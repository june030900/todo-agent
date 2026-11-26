import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "../shared/chat.ts";
import { getModelClient, model } from "./model.ts";

export type { ChatMessage } from "../shared/chat.ts";

type ModelClient = ReturnType<typeof getModelClient>;
type Action = "add" | "list" | "due" | "done" | "delete" | "clarify" | "chat";
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

interface TaskSpec {
  title: string;
  priority?: Priority;
  dueDate?: string;
}

interface Intent {
  action: Action;
  title?: string;
  tasks?: TaskSpec[];
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
  clarify: "clarify", ask: "clarify", question: "clarify", unclear: "clarify",
  chat: "chat", talk: "chat", other: "chat",
};

function normalizeAction(value: unknown): Action | null {
  const key = String(value ?? "").toLowerCase().trim();
  return ACTION_ALIASES[key] ?? null;
}

function parsePriority(value: unknown): Priority | undefined {
  return value === "high" || value === "mid" || value === "low" ? value : undefined;
}

function parseDueDate(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function parseTasks(value: unknown): TaskSpec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const specs = value
    .map((item): TaskSpec | null => {
      if (typeof item === "string") return { title: item };
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        return {
          title: typeof o.title === "string" ? o.title : "",
          priority: parsePriority(o.priority),
          dueDate: parseDueDate(o.dueDate),
        };
      }
      return null;
    })
    .filter((t): t is TaskSpec => t !== null && t.title.trim().length > 0);
  return specs.length > 0 ? specs : undefined;
}

function parseIntent(raw: string): Intent | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const action = normalizeAction(obj.action);
    if (!action) return null;
    return {
      action,
      title: typeof obj.title === "string" ? obj.title : undefined,
      tasks: parseTasks(obj.tasks),
      taskId: typeof obj.taskId === "string" ? obj.taskId : null,
      priority: parsePriority(obj.priority),
      dueDate: parseDueDate(obj.dueDate),
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

function guessTargets(text: string, tasks: Task[]): Task[] {
  return tasks
    .map((task) => {
      const chars = new Set(task.title.replace(/\s/g, ""));
      if (chars.size === 0) return { task, score: 0 };
      let hit = 0;
      for (const ch of chars) if (text.includes(ch)) hit++;
      return { task, score: hit / chars.size };
    })
    .filter((s) => s.score >= 0.6)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.task);
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
  return guessTargets(userText, tasks)[0];
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
- action: "add" | "list" | "due" | "done" | "delete" | "clarify" | "chat" 七选一，必须使用这几个值
- tasks: add 时输出任务数组，每项为 {"title":"...", "priority":"high|mid|low 可省略", "dueDate":"YYYY-MM-DD 可省略"}。
  一句话含多个独立动作时必须拆成多条：如「做饭洗碗买东西逛超市运动」→ 拆成「做饭」「洗碗」「买东西」「逛超市」「运动」五条。
  「其中运动比较紧急」→ 只给「运动」设 priority:"high"，其他不设。
  单条任务也用数组，只有一个元素。
- taskId: done/delete 时，从下面的任务列表里选出最匹配的一条的 id；匹配不到填 null
- message: 自然简短的中文回复，20 字以内

当前任务列表 json（含已知的优先级 priority 和截止日期 due）：
${JSON.stringify(enriched)}

判断规则：
- 新增任务 → add，多个动作拆成多条，逐条设置 priority 和 dueDate
- 「有哪些任务」「看看清单」→ list
- 「今天有哪些任务到期」「什么快到期了」→ due
- 「买好了」「取完了」「做完了」→ done，只标记用户提到的那一件事，不要波及其他任务
- 「删掉」「去掉」「取消」→ delete
- 内容空洞、无法确定要做什么（如「记一下那个事」「帮我记个东西」没有具体内容）→ clarify，在 message 里追问细节，如「你想记的具体是什么任务？」
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
        const specs: TaskSpec[] = intent.tasks?.length
          ? intent.tasks
          : [{
              title: intent.title ?? extractTitle(userText) ?? userText,
              priority: intent.priority,
              dueDate: intent.dueDate,
            }];

        const created: string[] = [];
        const duplicates: string[] = [];
        for (const spec of specs) {
          const title = spec.title.trim().slice(0, 200);
          if (!title) continue;
          if (tasks.some((t) => !t.done && t.title === title)) {
            duplicates.push(title);
            continue;
          }
          const res = await api<Task>("/api/tasks", {
            method: "POST",
            body: JSON.stringify({ title }),
          });
          const m: TaskMeta = {};
          if (spec.dueDate) m.due = spec.dueDate;
          if (spec.priority) m.priority = spec.priority;
          if (Object.keys(m).length > 0) {
            meta[res.id] = m;
            saveMeta(meta);
          }
          created.push(title);
        }

        if (created.length === 0 && duplicates.length === 0) {
          return "没听清要记什么，可以说得具体一点吗？比如「帮我记一下买牛奶」。";
        }
        const lines: string[] = [];
        if (created.length === 1) lines.push(`已添加「${created[0]}」。`);
        else if (created.length > 1)
          lines.push(`已记下 ${created.length} 件事：${created.map((t) => `「${t}」`).join("、")}。`);
        if (duplicates.length) lines.push(`「${duplicates.join("」「")}」已在清单，未重复添加。`);
        return lines.join("\n");
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
        if (!intent.taskId && !intent.title) {
          const candidates = guessTargets(userText, tasks);
          if (candidates.length >= 2) {
            return `你说的是哪一条？现在有：${candidates.map((t) => `「${t.title}」`).join("、")}。说清楚了我再处理。`;
          }
        }
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
      case "clarify":
        return intent.message || "你想记的具体是什么事？再说详细一点，我好帮你记下。";
      case "chat":
        return intent.message || "我是小明，可以帮你管理待办清单。";
    }
  } catch (err) {
    console.error("agent error:", err);
    return "抱歉，刚才出了点问题，请再说一次。";
  }
}
