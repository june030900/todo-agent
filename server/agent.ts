import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "../shared/chat.ts";
import { getModelClient, model } from "./model.ts";

export type { ChatMessage } from "../shared/chat.ts";

type ModelClient = ReturnType<typeof getModelClient>;
type Action = "add" | "list" | "due" | "done" | "delete" | "chat";
type Priority = "high" | "mid" | "low";

interface Task {
  id: string;
  title: string;
  done: boolean;
}

interface TaskMeta {
  priority?: Priority;
  due?: string;
}

type MetaMap = Record<string, TaskMeta>;

interface Intent {
  action: Action;
  title?: string;
  taskId?: string | null;
  priority?: Priority;
  dueDate?: string;
  message?: string;
}

interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

const API_BASE = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const META_FILE = join("data", "task-meta.json");

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`任务 API 返回 ${res.status}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function listTasks(): Promise<Task[]> {
  return api<Task[]>("/api/tasks");
}

function loadMeta(): MetaMap {
  try {
    if (!existsSync(META_FILE)) return {};
    return JSON.parse(readFileSync(META_FILE, "utf8")) as MetaMap;
  } catch {
    return {};
  }
}

function saveMeta(meta: MetaMap) {
  mkdirSync(join("data"), { recursive: true });
  writeFileSync(META_FILE, JSON.stringify(meta, null, 2) + "\n");
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayStr(): string {
  return fmtDate(new Date());
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return fmtDate(new Date(y, m - 1, d + days));
}

const ACTION_ALIASES: Record<string, Action> = {
  add: "add", create: "add", create_task: "add", new: "add", new_task: "add",
  list: "list", query: "list", show: "list", view: "list", get: "list",
  due: "due", expire: "due", expires: "due", deadline: "due", due_today: "due",
  done: "done", complete: "done", finish: "done", mark: "done", mark_done: "done",
  delete: "delete", remove: "delete", del: "delete", cancel: "delete",
  chat: "chat", talk: "chat", other: "chat",
};

function normalizeAction(value: unknown): Action | null {
  const key = String(value ?? "").toLowerCase().trim();
  return ACTION_ALIASES[key] ?? null;
}

function parseIntent(raw: string): Intent | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const action = normalizeAction(obj.action);
    if (!action) return null;
    const priority =
      obj.priority === "high" || obj.priority === "mid" || obj.priority === "low"
        ? (obj.priority as Priority)
        : undefined;
    const dueDate =
      typeof obj.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(obj.dueDate)
        ? obj.dueDate
        : undefined;
    return {
      action,
      title: typeof obj.title === "string" ? obj.title : undefined,
      taskId: typeof obj.taskId === "string" ? obj.taskId : null,
      priority,
      dueDate,
      message: typeof obj.message === "string" ? obj.message : undefined,
    };
  } catch {
    return null;
  }
}

function describeMeta(meta?: TaskMeta, today = todayStr()): string {
  if (!meta) return "";
  const tags: string[] = [];
  if (meta.priority === "high") tags.push("高优先级");
  if (meta.due) {
    if (meta.due < today) tags.push("已过期");
    else if (meta.due === today) tags.push("今天到期");
    else if (meta.due === addDays(today, 1)) tags.push("明天到期");
    else tags.push(`${meta.due} 到期`);
  }
  return tags.length ? `（${tags.join("，")}）` : "";
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, mid: 1, low: 2 };

function formatList(tasks: Task[], meta: MetaMap): string {
  if (tasks.length === 0) return "清单还是空的，说「帮我记一下买牛奶」就能加第一条。";
  const today = todayStr();
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  open.sort((a, b) => {
    const da = meta[a.id]?.due ?? "9999-12-31";
    const db = meta[b.id]?.due ?? "9999-12-31";
    if (da !== db) return da < db ? -1 : 1;
    const pa = PRIORITY_RANK[meta[a.id]?.priority ?? "mid"];
    const pb = PRIORITY_RANK[meta[b.id]?.priority ?? "mid"];
    return pa - pb;
  });
  const lines = [...open, ...done].map(
    (t, i) =>
      `${i + 1}. ${t.done ? "[已完成]" : "[待办]"} ${t.title}${t.done ? "" : describeMeta(meta[t.id], today)}`,
  );
  const dueHint = open.some((t) => meta[t.id]?.due === today)
    ? "\n提醒：有任务今天到期，记得处理！"
    : "";
  return `你现在有 ${tasks.length} 条任务（待办 ${open.length} 条 / 已完成 ${done.length} 条）：\n${lines.join("\n")}${dueHint}`;
}

function guessTargetByText(text: string, tasks: Task[]): Task | undefined {
  let best: { task: Task; score: number } | undefined;
  for (const task of tasks) {
    const chars = new Set(task.title.replace(/\s/g, ""));
    if (chars.size === 0) continue;
    let hit = 0;
    for (const ch of chars) if (text.includes(ch)) hit++;
    const score = hit / chars.size;
    if (!best || score > best.score) best = { task, score };
  }
  return best && best.score >= 0.6 ? best.task : undefined;
}

function findTask(tasks: Task[], intent: Intent, userText: string): Task | undefined {
  if (intent.taskId) {
    const byId = tasks.find((t) => t.id === intent.taskId);
    if (byId) return byId;
  }
  const key = (intent.title ?? "").trim();
  if (key) {
    const direct = tasks.find((t) => t.title.includes(key) || key.includes(t.title));
    if (direct) return direct;
  }
  return guessTargetByText(userText, tasks);
}

function extractTitle(text: string): string | undefined {
  const m = text.match(
    /(?:帮我记一下|记一下|记一条|帮我记|帮我加|添加|新增|提醒我|加一条|加个)一?条?[:：，,、\s]*(.+)$/,
  );
  const title = m?.[1]?.trim();
  return title || undefined;
}

function buildSystem(tasks: Task[], meta: MetaMap): string {
  const today = todayStr();
  const weekday = `周${"日一二三四五六"[new Date().getDay()]}`;
  const enriched = tasks.map((t) => ({ id: t.id, title: t.title, done: t.done, ...(meta[t.id] ?? {}) }));
  return `你是中文待办助手「小明」。根据用户最新一句话判断意图，只输出一个严格 json 对象，不要 markdown 代码块、不要额外解释。历史对话中 assistant 的消息都是 json 格式，你的输出也必须保持 json 格式。

今天是 ${today}（${weekday}），据此推算「今天、明天、周五」等相对日期。

json 字段：
- action: "add" | "list" | "due" | "done" | "delete" | "chat" 六选一，必须使用这几个值
- title: add 时的任务标题，去掉「帮我记一下」「记一条」等前缀，1-200 字；其他动作可省略
- taskId: done/delete 时，从下面的任务列表里选出最匹配的一条的 id；匹配不到填 null
- priority: add 时，用户说「紧急/重要/尽快」→ "high"；说「不急/有空再说」→ "low"；没提就省略
- dueDate: add 时，用户提到期限（今天/明天/后天/周X/X月X日）→ 换算为 "YYYY-MM-DD"；没提就省略
- message: 自然简短的中文回复，20 字以内

当前任务列表 json（含已知的优先级 priority 和截止日期 due）：
${JSON.stringify(enriched)}

判断规则：
- 「记一下」「加上」「新增」→ add，并尽量抽取 priority 和 dueDate
- 「有哪些任务」「看看清单」→ list
- 「今天有哪些任务到期」「什么快到期了」→ due
- 「买好了」「取完了」「做完了」→ done，按语义匹配（如「牛奶买好了」对应「买牛奶」）
- 「删掉」「去掉」「取消」→ delete
- 其他闲聊 → chat，在 message 里正常回答
- 只根据最新一句判断，不要被历史对话误导`;
}

function historyForLLM(messages: ChatMessage[]): LLMMessage[] {
  return messages.map((m) => ({
    role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: m.role === "assistant" ? JSON.stringify({ message: m.content }) : m.content,
  }));
}

async function callOnce(
  client: ModelClient,
  messages: { role: "system" | LLMMessage["role"]; content: string }[],
): Promise<Intent | null> {
  const res = await client.chat.completions.create({
    model,
    messages,
    temperature: 0,
    response_format: { type: "json_object" },
  });
  return parseIntent(res.choices[0]?.message?.content ?? "");
}

async function askIntent(
  system: string,
  history: LLMMessage[],
  userText: string,
): Promise<Intent | null> {
  const client = getModelClient();
  try {
    const intent = await callOnce(client, [{ role: "system", content: system }, ...history]);
    if (intent) return intent;
  } catch (err) {
    console.error("intent call failed:", err);
  }
  try {
    return await callOnce(client, [
      { role: "system", content: `${system}\n再次强调：只能输出一个 json 对象，禁止输出任何其他文本。` },
      { role: "user", content: userText },
    ]);
  } catch (err) {
    console.error("intent retry failed:", err);
    return null;
  }
}

function fallbackIntent(text: string): Intent {
  if (/到期|截止/.test(text)) return { action: "due" };
  if (/删|去掉|移除|清除|不要了/.test(text)) return { action: "delete" };
  if (/取完|买好|做完|办完|搞定|完成|好了/.test(text)) return { action: "done" };
  if (/哪些|清单|列表|有什么任务|有哪几|看看/.test(text)) return { action: "list" };
  if (/记一下|记一条|添加|新增|提醒我|帮我记|加一条|加个/.test(text)) {
    return { action: "add", title: extractTitle(text) };
  }
  return { action: "chat" };
}

export async function reply(messages: ChatMessage[]): Promise<string> {
  try {
    const latest = messages[messages.length - 1];
    const userText = typeof latest?.content === "string" ? latest.content.trim() : "";
    if (!userText) return "请告诉我你想做什么，比如「帮我记一下买牛奶」。";

    const tasks = await listTasks();
    const meta = loadMeta();
    const system = buildSystem(tasks, meta);

    const intent =
      (await askIntent(system, historyForLLM(messages), userText)) ?? fallbackIntent(userText);

    switch (intent.action) {
      case "add": {
        const title = (intent.title ?? extractTitle(userText) ?? userText).trim().slice(0, 200);
        if (!title) return "任务内容不能为空。";
        const duplicate = tasks.find((t) => !t.done && t.title === title);
        if (duplicate) return `「${title}」已经在清单里了，不用重复记。`;
        const created = await api<Task>("/api/tasks", {
          method: "POST",
          body: JSON.stringify({ title }),
        });
        const taskMeta: TaskMeta = {};
        if (intent.dueDate) taskMeta.due = intent.dueDate;
        if (intent.priority) taskMeta.priority = intent.priority;
        if (Object.keys(taskMeta).length > 0) {
          meta[created.id] = taskMeta;
          saveMeta(meta);
        }
        return intent.message || `已添加「${title}」${describeMeta(taskMeta)}。`;
      }
      case "list":
        return formatList(await listTasks(), meta);
      case "due": {
        const today = todayStr();
        const dueTasks = tasks.filter(
          (t) => !t.done && meta[t.id]?.due !== undefined && meta[t.id].due! <= today,
        );
        if (dueTasks.length === 0) return "今天没有到期的任务，安排得明明白白。";
        const lines = dueTasks.map((t, i) => `${i + 1}. ${t.title}${describeMeta(meta[t.id], today)}`);
        return `今天到期或已过期的任务有 ${dueTasks.length} 条：\n${lines.join("\n")}`;
      }
      case "done":
      case "delete": {
        const target = findTask(tasks, intent, userText);
        if (!target) return "没找到对应的任务，可以说得更明确些，比如「把买牛奶标记为完成」。";
        if (intent.action === "done") {
          await api<Task>(`/api/tasks/${encodeURIComponent(target.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ done: true }),
          });
          return intent.message || `已把「${target.title}」标记为完成。`;
        }
        await api<void>(`/api/tasks/${encodeURIComponent(target.id)}`, { method: "DELETE" });
        if (meta[target.id] !== undefined) {
          delete meta[target.id];
          saveMeta(meta);
        }
        return intent.message || `已删除「${target.title}」。`;
      }
      case "chat":
        return intent.message || "我是小明，可以帮你管理待办清单。";
    }
  } catch (err) {
    console.error("agent error:", err);
    return "抱歉，刚才出了点问题，请再说一次。";
  }
}
