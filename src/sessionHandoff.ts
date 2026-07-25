/**
 * Session handoff notes — a durable "note to the next shift" written when a chat
 * session has to shed its context (I-159's handoff idea, applied to the chat
 * session instead of the git worktree).
 *
 * Why deterministic and not model-written: the one moment we need this note is the
 * moment the context is already too long to ask the model for anything. So the note
 * is assembled from what the store already holds — the run history — with no model
 * call and no dependency on a working upstream.
 *
 * Written to a searchable wing so autoRag surfaces it on later turns: after a
 * compact, the agent's own summary lives in the SDK session and this note is what
 * survives independently of it.
 */
import type { IStore } from "./store.js";
import type { IMemoryStore } from "./memoryStore.js";

/** Handoff notes wing — searchable by default (not an archive wing). */
export const SESSION_HANDOFF_WING = "session-handoff";

const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_CHARS = 6_000;

/** One note per session, upserted — the latest checkpoint, not a growing pile. */
export function sessionHandoffNoteName(sessionId: string): string {
  return `session-handoff.${sessionId.trim()}`;
}

function clip(text: string, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export interface SessionHandoffInput {
  sessionId: string;
  reason: string;
  atIso: string;
  channel?: string;
  turns: { prompt: string; result: string; at?: string }[];
  maxChars?: number;
}

/**
 * Markdown body for a handoff note. Newest turns are kept when the budget runs
 * out — the tail of a conversation is what the next shift needs, not its opening.
 */
export function formatSessionHandoffBody(input: SessionHandoffInput): string {
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  const header = [
    `# Session handoff — ${input.sessionId}`,
    "",
    `- **Written:** ${input.atIso}`,
    `- **Reason:** ${input.reason}`,
    ...(input.channel ? [`- **Channel:** ${input.channel}`] : []),
    "",
    "Context was shed at this point (compacted). The exchange below is the tail of",
    "the conversation as recorded by the run store — previews, not full transcripts.",
    "",
    "## Last exchanges",
    "",
  ].join("\n");

  const rendered: string[] = [];
  let budget = maxChars;
  // Walk newest → oldest so truncation drops the OLDEST turns, then re-order.
  for (let i = input.turns.length - 1; i >= 0; i--) {
    const t = input.turns[i]!;
    const when = t.at ? ` _(${t.at})_` : "";
    const block = `### Turn${when}\n\n**User:** ${clip(t.prompt, 400)}\n\n**Agent:** ${clip(t.result, 700) || "_(no stored output)_"}`;
    if (block.length > budget) break;
    budget -= block.length;
    rendered.unshift(block);
  }

  const dropped = input.turns.length - rendered.length;
  const footer = dropped > 0 ? `\n\n_(${dropped} earlier turn(s) omitted for size)_` : "";
  const body = rendered.length ? rendered.join("\n\n") : "_(no recorded turns)_";
  return `${header}${body}${footer}\n`;
}

export interface WriteSessionHandoffOptions {
  reason: string;
  channel?: string;
  maxTurns?: number;
  maxChars?: number;
  now?: () => Date;
}

/**
 * Build and persist the handoff note. Returns the note name, or undefined when
 * there was nothing to record. Callers treat failure as non-fatal — a missing
 * handoff must never block the compact that un-wedges the session.
 */
export async function writeSessionHandoff(
  store: IStore,
  memory: IMemoryStore,
  sessionId: string,
  opts: WriteSessionHandoffOptions
): Promise<string | undefined> {
  const runs = (await store.listRuns(sessionId)).slice(-(opts.maxTurns ?? DEFAULT_MAX_TURNS));
  if (runs.length === 0) return undefined;

  const atIso = (opts.now?.() ?? new Date()).toISOString();
  const body = formatSessionHandoffBody({
    sessionId,
    reason: opts.reason,
    atIso,
    channel: opts.channel,
    maxChars: opts.maxChars,
    turns: runs.map((r) => ({
      prompt: r.prompt_preview ?? "",
      result: r.result_preview ?? "",
      at: r.started_at ?? undefined,
    })),
  });

  const name = sessionHandoffNoteName(sessionId);
  await memory.upsertNote({
    name,
    wing: SESSION_HANDOFF_WING,
    title: `Session handoff — ${sessionId}`,
    body,
  });
  return name;
}
