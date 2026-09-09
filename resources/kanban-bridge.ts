// kanban-bridge: Pion's bundled PI extension (docs/kanban-design.md §5).
// Injected by Pion's dispatcher via `pi --mode rpc -e <this file>`; users may
// also load it explicitly in a terminal (`pi -e <path>`), which shares the
// same board. Stateless: every call re-reads <cwd>/.pion/kanban/events.jsonl
// and appends single-line events with one write() — the same multi-writer
// contract the GUI's KanbanStore watches for.
//
// Trust: this file ships with Pion (app resource), so loading it is not a
// project-trust decision; it never touches project-local .pi resources.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_NOTE_CHARS = 8_192;
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

async function readCards(cwd: string): Promise<Map<string, BridgeCard>> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, EVENTS_REL), "utf8");
  } catch {
    return new Map(); // board not enabled in this project
  }
  return projectCards(raw.split("\n"));
}

function nowIso(): string {
  return new Date().toISOString();
}

async function appendEvent(cwd: string, event: Record<string, unknown>): Promise<void> {
  await appendFile(join(cwd, EVENTS_REL), JSON.stringify({ v: 1, ts: nowIso(), ...event }) + "\n");
}

export default function (pi: ExtensionAPI) {
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
      const note = params.note.trim();
      if (!note) {
        return { content: [{ type: "text", text: "note 不能为空。" }], details: { ok: false } };
      }
      if (note.length > MAX_NOTE_CHARS) {
        return { content: [{ type: "text", text: `note 超过 ${MAX_NOTE_CHARS} 字符上限,请精简。` }], details: { ok: false } };
      }
      const cards = await readCards(ctx.cwd);
      const card = cards.get(params.cardId);
      if (!card) {
        return {
          content: [{ type: "text", text: `看板中不存在卡片 ${params.cardId},汇报未记录。` }],
          details: { ok: false },
        };
      }
      if (card.archived) {
        return { content: [{ type: "text", text: `卡片 ${params.cardId} 已归档,汇报未记录。` }], details: { ok: false } };
      }
      const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
      // blocked 停在 in_progress(设计 §5),其余状态按汇报移动。
      const target = params.status === "blocked" ? "in_progress" : params.status;
      const noteText = params.status === "blocked" ? `⚠ 阻塞:${note}` : note;
      await appendEvent(ctx.cwd, {
        type: "note_added",
        id: params.cardId,
        note: { id: `n_${Math.random().toString(16).slice(2, 10)}`, source: "agent", text: noteText, ...(sessionFile ? { sessionFile } : {}) },
      });
      if (target && target !== card.status) {
        await appendEvent(ctx.cwd, { type: "card_moved", id: params.cardId, to: target, by: "agent" });
      }
      // Return the freshly projected card so the agent immediately sees the
      // confirmed state (design §5: 工具返回投影后的卡片 JSON).
      const refreshed = (await readCards(ctx.cwd)).get(params.cardId);
      const statusLine = params.status === "blocked" ? "已记录阻塞(卡片保留在 in_progress)" : target ? `卡片已移动到 ${target}` : "动态已记录";
      return {
        content: [{ type: "text", text: `汇报成功:${statusLine}。\n${JSON.stringify(refreshed ?? card, null, 2)}` }],
        details: { ok: true, card: refreshed ?? card },
      };
    },
  });
}
