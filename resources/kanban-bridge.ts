// kanban-bridge: Pion's bundled PI extension (docs/kanban-design.md §5).
// Injected by Pion's dispatcher via `pi --mode rpc -e <this file>`; users may
// also load it explicitly in a terminal (`pi -e <path>`), which shares the
// same board. Stateless: every call re-reads the board's events.jsonl and
// appends single-line events with one write() — the same multi-writer
// contract the GUI's KanbanStore watches for.
//
// Two toolsets, selected by env (set by Pion's daemon, never user input):
// - worker (default, cwd-bound): kanban_read/kanban_report over
//   <cwd>/.pion/kanban/events.jsonl — the dispatched session reports on its
//   bound card.
// - manager (PION_KANBAN_MODE=manager + PION_DATA_DIR): temp chat sessions
//   get board-management tools (list/read/create/move/report) over EVERY
//   board — the global unassigned board plus the daemon-registered projects.
//   Board targets resolve BY NAME from the daemon-written index
//   (<data>/kanban/boards.json); the model can never pass a raw path, so a
//   manager session cannot write outside known boards.
//
// Trust: this file ships with Pion (app resource), so loading it is not a
// project-trust decision; it never touches project-local .pi resources.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_NOTE_CHARS = 8_192;
const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 32_768;
const EVENTS_REL = join(".pion", "kanban", "events.jsonl");

interface BridgeCard {
  id: string;
  title: string;
  body?: string;
  acceptance?: string[];
  status: string;
  assignee?: { sessionFile?: string; model?: string; label?: string };
  archived: boolean;
}

function isStatus(value: unknown): value is string {
  return value === "todo" || value === "in_progress" || value === "review" || value === "done";
}

// Minimal stateless projection: enough for card lookup and status checks.
// Full folding stays in the GUI's kanbanReducer; the bridge only ever needs
// "does this card exist here, what status is it in".
function projectCards(lines: string[]): Map<string, BridgeCard> {
  const cards = new Map<string, BridgeCard>();
  for (const line of lines) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // broken line: skip, never poison the rest
    }
    if (raw?.v !== 1 || typeof raw.type !== "string" || typeof raw.id !== "string") continue;
    switch (raw.type) {
      case "card_created":
        if (!cards.has(raw.id) && typeof raw.title === "string") {
          cards.set(raw.id, {
            id: raw.id,
            title: raw.title,
            body: typeof raw.body === "string" ? raw.body : undefined,
            acceptance: Array.isArray(raw.acceptance) ? (raw.acceptance as string[]) : undefined,
            status: "todo",
            archived: false,
          });
        }
        break;
      case "card_moved": {
        const card = cards.get(raw.id);
        if (card && isStatus(raw.to)) card.status = raw.to;
        break;
      }
      case "card_assigned": {
        const card = cards.get(raw.id);
        if (card) {
          card.assignee = {
            ...(typeof raw.sessionFile === "string" ? { sessionFile: raw.sessionFile } : {}),
            ...(typeof raw.model === "string" ? { model: raw.model } : {}),
            ...(typeof raw.label === "string" ? { label: raw.label } : {}),
          };
        }
        break;
      }
      case "card_archived": {
        const card = cards.get(raw.id);
        if (card) card.archived = true;
        break;
      }
      default:
        break; // card_updated / note_added / unknown: irrelevant to the bridge
    }
  }
  return cards;
}

async function readCardsFromFile(file: string): Promise<Map<string, BridgeCard>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return new Map(); // board not enabled yet — reads never create
  }
  return projectCards(raw.split("\n"));
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(16).slice(2, 10)}`;
}

async function appendEventFile(file: string, event: Record<string, unknown>): Promise<void> {
  // First write to a not-yet-enabled board materializes its directory — the
  // same "explicit action enables" rule as the GUI's create button.
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify({ v: 1, ts: nowIso(), ...event }) + "\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Worker mode (dispatched sessions; cwd-bound, unchanged behavior)
// ──────────────────────────────────────────────────────────────────────────

function readCards(cwd: string): Promise<Map<string, BridgeCard>> {
  return readCardsFromFile(join(cwd, EVENTS_REL));
}

function appendEvent(cwd: string, event: Record<string, unknown>): Promise<void> {
  return appendEventFile(join(cwd, EVENTS_REL), event);
}

function registerWorkerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "kanban_read",
    label: "Kanban Read",
    description:
      "读取 Pion 看板:带 cardId 返回该任务卡详情(标题/描述/验收标准/状态),不带则返回整板摘要。只读,不产生事件。",
    parameters: Type.Object({
      cardId: Type.Optional(Type.String({ description: "任务卡 id,形如 k_xxxxxxxx" })),
    }),
    promptGuidelines: [
      "开始处理绑定的任务卡之前,先用 kanban_read 读取该卡片详情与验收标准。",
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cards = await readCards(ctx.cwd);
      if (params.cardId) {
        const card = cards.get(params.cardId);
        if (!card) {
          return {
            content: [{ type: "text", text: `看板中不存在卡片 ${params.cardId}。用 kanban_read(不带参数)查看整板摘要。` }],
            details: { ok: false },
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(card, null, 2) }],
          details: { ok: true, card },
        };
      }
      const summary = [...cards.values()]
        .filter((c) => !c.archived)
        .map((c) => `${c.id} [${c.status}] ${c.title}${c.assignee ? " (已绑定会话)" : ""}`);
      return {
        content: [{ type: "text", text: summary.length ? summary.join("\n") : "看板为空(或本项目尚未启用看板)。" }],
        details: { ok: true, count: summary.length },
      };
    },
  });

  pi.registerTool({
    name: "kanban_report",
    label: "Kanban Report",
    description:
      "向 Pion 看板汇报任务进展:必须带 note;status 可选(in_progress/review/blocked)。完成后用 status=review 汇报结论,被阻塞用 status=blocked。",
    parameters: Type.Object({
      cardId: Type.String({ description: "任务卡 id" }),
      note: Type.String({ description: "本次汇报内容:进展/结论/阻塞原因" }),
      status: Type.Optional(
        StringEnum(["in_progress", "review", "blocked"] as const, {
          description: "汇报后的卡片状态;blocked 会保留在 in_progress 并在动态中标记",
        }),
      ),
    }),
    promptGuidelines: [
      "关键节点(完成子步骤、方案变更)用 kanban_report 记录进展。",
      "任务全部完成并用 kanban_report(cardId, status=\"review\", note=结论与改动说明) 交付审核。",
      "被阻塞时用 kanban_report(cardId, status=\"blocked\", note=原因) 说明,不要静默停止。",
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return reportOnBoard(
        params.cardId,
        params.note,
        params.status,
        () => readCards(ctx.cwd),
        (ev) => appendEvent(ctx.cwd, ev),
        ctx,
      );
    },
  });
}

// Shared report semantics (worker = cwd board, manager = named board).
// `load` re-reads the board so the result carries the freshly projected card
// (design §5: 工具返回投影后的卡片 JSON).
async function reportOnBoard(
  cardId: string,
  note: string,
  status: "in_progress" | "review" | "blocked" | undefined,
  load: () => Promise<Map<string, BridgeCard>>,
  append: (event: Record<string, unknown>) => Promise<void>,
  ctx: { sessionManager: { getSessionFile(): string | null } },
) {
  const trimmed = note.trim();
  if (!trimmed) {
    return { content: [{ type: "text", text: "note 不能为空。" }], details: { ok: false } };
  }
  if (trimmed.length > MAX_NOTE_CHARS) {
    return { content: [{ type: "text", text: `note 超过 ${MAX_NOTE_CHARS} 字符上限,请精简。` }], details: { ok: false } };
  }
  const card = (await load()).get(cardId);
  if (!card) {
    return {
      content: [{ type: "text", text: `看板中不存在卡片 ${cardId},汇报未记录。` }],
      details: { ok: false },
    };
  }
  if (card.archived) {
    return { content: [{ type: "text", text: `卡片 ${cardId} 已归档,汇报未记录。` }], details: { ok: false } };
  }
  const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
  // blocked 停在 in_progress(设计 §5),其余状态按汇报移动。
  const target = status === "blocked" ? "in_progress" : status;
  const noteText = status === "blocked" ? `⚠ 阻塞:${trimmed}` : trimmed;
  await append({
    type: "note_added",
    id: cardId,
    note: { id: randomId("n"), source: "agent", text: noteText, ...(sessionFile ? { sessionFile } : {}) },
  });
  if (target && target !== card.status) {
    await append({ type: "card_moved", id: cardId, to: target, by: "agent" });
  }
  const refreshed = (await load()).get(cardId);
  const statusLine = status === "blocked" ? "已记录阻塞(卡片保留在 in_progress)" : target ? `卡片已移动到 ${target}` : "动态已记录";
  return {
    content: [{ type: "text", text: `汇报成功:${statusLine}。\n${JSON.stringify(refreshed ?? card, null, 2)}` }],
    details: { ok: true, card: refreshed ?? card },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Manager mode (temp chat sessions; all boards by name)
// ──────────────────────────────────────────────────────────────────────────

interface BoardEntry {
  name: string;
  path: string;
}

async function readBoardIndex(dataDir: string): Promise<BoardEntry[]> {
  try {
    const raw = JSON.parse(await readFile(join(dataDir, "kanban", "boards.json"), "utf8")) as {
      projects?: BoardEntry[];
    };
    return Array.isArray(raw.projects) ? raw.projects.filter((p) => p && typeof p.name === "string" && typeof p.path === "string") : [];
  } catch {
    return []; // no index yet: only the unassigned board exists
  }
}

function registerManagerTools(pi: ExtensionAPI, dataDir: string): void {
  const unassignedFile = join(dataDir, "kanban", "events.jsonl");

  // Board names the model may use: "unassigned" + registered project names.
  // Name→file comes ONLY from the daemon-written index — the model can never
  // aim a write at an arbitrary path.
  async function resolveBoard(board: string | undefined): Promise<{ name: string; file: string } | { error: string }> {
    if (!board || board === "unassigned" || board === "未分配") return { name: "unassigned", file: unassignedFile };
    const index = await readBoardIndex(dataDir);
    const hit = index.find((p) => p.name === board || p.path === board);
    if (!hit) {
      const names = ["unassigned", ...index.map((p) => p.name)].join("、");
      return { error: `未知看板 "${board}"。可用看板:${names}。先用 kanban_boards() 查看全部看板。` };
    }
    return { name: hit.name, file: join(hit.path, EVENTS_REL) };
  }

  pi.registerTool({
    name: "kanban_boards",
    label: "Kanban Boards",
    description: "列出全部可用看板及其卡片数:全局「unassigned」板 + 各注册项目的看板。board 参数的合法取值即这里的名称。",
    parameters: Type.Object({}),
    promptGuidelines: ["操作任何看板前,先 kanban_boards() 获取合法的 board 名称。"],
    async execute() {
      const index = await readBoardIndex(dataDir);
      const boards = [{ name: "unassigned", file: unassignedFile }, ...index.map((p) => ({ name: p.name, file: join(p.path, EVENTS_REL) }))];
      const lines: string[] = [];
      for (const b of boards) {
        const cards = await readCardsFromFile(b.file);
        const live = [...cards.values()].filter((c) => !c.archived);
        const byStatus = { todo: 0, in_progress: 0, review: 0, done: 0 } as Record<string, number>;
        for (const c of live) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
        lines.push(
          `- ${b.name}: ${live.length} 张卡(todo ${byStatus.todo}/in_progress ${byStatus.in_progress}/review ${byStatus.review}/done ${byStatus.done})`,
        );
      }
      return {
        content: [{ type: "text", text: lines.join("\n") || "没有可用看板。" }],
        details: { ok: true, boards: boards.map((b) => b.name) },
      };
    },
  });

  pi.registerTool({
    name: "kanban_read",
    label: "Kanban Read",
    description:
      "读取看板:board+cardId 返回该卡详情;board 返回该板全部卡片摘要;都不带返回所有看板的摘要。board 取值见 kanban_boards。",
    parameters: Type.Object({
      board: Type.Optional(Type.String({ description: '看板名称:项目名,或 "unassigned"(全局未分配板)' })),
      cardId: Type.Optional(Type.String({ description: "任务卡 id,形如 k_xxxxxxxx" })),
    }),
    async execute(_toolCallId, params) {
      const resolved = await resolveBoard(params.board);
      if ("error" in resolved) return { content: [{ type: "text", text: resolved.error }], details: { ok: false } };
      if (params.cardId) {
        const card = (await readCardsFromFile(resolved.file)).get(params.cardId);
        if (!card) {
          return { content: [{ type: "text", text: `看板 ${resolved.name} 中不存在卡片 ${params.cardId}。` }], details: { ok: false } };
        }
        return { content: [{ type: "text", text: JSON.stringify(card, null, 2) }], details: { ok: true, card } };
      }
      if (params.board) {
        const cards = [...(await readCardsFromFile(resolved.file)).values()].filter((c) => !c.archived);
        const text = cards.length
          ? cards.map((c) => `${c.id} [${c.status}] ${c.title}${c.assignee ? " (已绑定会话)" : ""}`).join("\n")
          : "看板为空(或尚未启用)。";
        return { content: [{ type: "text", text }], details: { ok: true, count: cards.length } };
      }
      const index = await readBoardIndex(dataDir);
      const boards = [{ name: "unassigned", file: unassignedFile }, ...index.map((p) => ({ name: p.name, file: join(p.path, EVENTS_REL) }))];
      const sections: string[] = [];
      for (const b of boards) {
        const cards = [...(await readCardsFromFile(b.file)).values()].filter((c) => !c.archived);
        sections.push(
          cards.length ? `【${b.name}】\n${cards.map((c) => `${c.id} [${c.status}] ${c.title}`).join("\n")}` : `【${b.name}】(空)`,
        );
      }
      return { content: [{ type: "text", text: sections.join("\n\n") }], details: { ok: true } };
    },
  });

  pi.registerTool({
    name: "kanban_create",
    label: "Kanban Create",
    description: "在看板上创建任务卡:标题必填,可附描述与验收标准。新卡初始为 todo。",
    parameters: Type.Object({
      board: Type.String({ description: '目标看板名称(项目名或 "unassigned")' }),
      title: Type.String({ description: "卡片标题,≤200 字符" }),
      body: Type.Optional(Type.String({ description: "卡片描述" })),
      acceptance: Type.Optional(Type.Array(Type.String({ description: "验收标准" }))),
    }),
    promptGuidelines: ["把讨论中形成的任务落成卡片时,给出清晰的标题与可验证的验收标准。"],
    async execute(_toolCallId, params) {
      const resolved = await resolveBoard(params.board);
      if ("error" in resolved) return { content: [{ type: "text", text: resolved.error }], details: { ok: false } };
      const title = params.title.trim();
      if (!title) return { content: [{ type: "text", text: "title 不能为空。" }], details: { ok: false } };
      if (title.length > MAX_TITLE_CHARS) return { content: [{ type: "text", text: `title 超过 ${MAX_TITLE_CHARS} 字符上限。` }], details: { ok: false } };
      if (params.body && params.body.length > MAX_BODY_CHARS) {
        return { content: [{ type: "text", text: `body 超过 ${MAX_BODY_CHARS} 字符上限。` }], details: { ok: false } };
      }
      const id = randomId("k");
      await appendEventFile(resolved.file, {
        type: "card_created",
        id,
        title,
        ...(params.body ? { body: params.body } : {}),
        ...(params.acceptance?.length ? { acceptance: params.acceptance } : {}),
      });
      const card = (await readCardsFromFile(resolved.file)).get(id);
      return {
        content: [{ type: "text", text: `已在看板 ${resolved.name} 创建卡片 ${id}。\n${JSON.stringify(card, null, 2)}` }],
        details: { ok: true, card },
      };
    },
  });

  pi.registerTool({
    name: "kanban_move",
    label: "Kanban Move",
    description: "移动看板卡片状态:todo → in_progress → review → done。",
    parameters: Type.Object({
      board: Type.String({ description: '看板名称(项目名或 "unassigned")' }),
      cardId: Type.String({ description: "任务卡 id" }),
      to: StringEnum(["todo", "in_progress", "review", "done"] as const, { description: "目标状态" }),
    }),
    async execute(_toolCallId, params) {
      const resolved = await resolveBoard(params.board);
      if ("error" in resolved) return { content: [{ type: "text", text: resolved.error }], details: { ok: false } };
      const card = (await readCardsFromFile(resolved.file)).get(params.cardId);
      if (!card) return { content: [{ type: "text", text: `看板 ${resolved.name} 中不存在卡片 ${params.cardId}。` }], details: { ok: false } };
      if (card.archived) return { content: [{ type: "text", text: `卡片 ${params.cardId} 已归档,不能再移动。` }], details: { ok: false } };
      if (card.status === params.to) {
        return { content: [{ type: "text", text: `卡片 ${params.cardId} 已在 ${params.to}。` }], details: { ok: true, card } };
      }
      await appendEventFile(resolved.file, { type: "card_moved", id: params.cardId, to: params.to, by: "agent" });
      const refreshed = (await readCardsFromFile(resolved.file)).get(params.cardId);
      return {
        content: [{ type: "text", text: `卡片 ${params.cardId} 已移至 ${params.to}。\n${JSON.stringify(refreshed, null, 2)}` }],
        details: { ok: true, card: refreshed },
      };
    },
  });

  pi.registerTool({
    name: "kanban_report",
    label: "Kanban Report",
    description:
      "向指定看板的卡片汇报进展:必须带 note;status 可选(in_progress/review/blocked)。完成后用 status=review,被阻塞用 status=blocked。",
    parameters: Type.Object({
      board: Type.String({ description: '看板名称(项目名或 "unassigned")' }),
      cardId: Type.String({ description: "任务卡 id" }),
      note: Type.String({ description: "本次汇报内容:进展/结论/阻塞原因" }),
      status: Type.Optional(
        StringEnum(["in_progress", "review", "blocked"] as const, {
          description: "汇报后的卡片状态;blocked 会保留在 in_progress 并在动态中标记",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const resolved = await resolveBoard(params.board);
      if ("error" in resolved) return { content: [{ type: "text", text: resolved.error }], details: { ok: false } };
      return reportOnBoard(
        params.cardId,
        params.note,
        params.status,
        () => readCardsFromFile(resolved.file),
        (ev) => appendEventFile(resolved.file, ev),
        ctx,
      );
    },
  });
}

export default function (pi: ExtensionAPI) {
  const dataDir = process.env.PION_KANBAN_MODE === "manager" ? process.env.PION_DATA_DIR : undefined;
  if (dataDir) registerManagerTools(pi, dataDir);
  else registerWorkerTools(pi);
}
