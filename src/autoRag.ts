/**
 * Silent memory retrieval before each chat turn (Wave B auto-RAG).
 * Injects top matching notes without requiring the model to call memory_search first.
 */
import { agentLogEnabled, resolveAgentLogger } from "./agentLog.js";
import { loadConfig, type AgentConfig } from "./config.js";
import { createMemoryStore, SECURE_WING, type MemoryNote } from "./memoryStore.js";
import { stalenessNote } from "./memoryStaleness.js";

const DEFAULT_LIMIT = 3;
const DEFAULT_MAX_CHARS = 12_000;

function formatAutoRagBlock(note: MemoryNote, stalenessDays?: number): string {
  const stale = stalenessNote(note.updated_at, Date.now(), stalenessDays);
  const footer = stale ? `\n\n_${stale}_` : "";
  return `### Memory: ${note.name}\n\n${note.body.trim()}${footer}`;
}

function resolveAutoRag(cfg: AgentConfig): {
  enabled: boolean;
  limit: number;
  semantic: boolean;
  maxChars: number;
  wings?: string[];
} {
  const ar = cfg.memory?.autoRag;
  if (!ar?.enabled) {
    return { enabled: false, limit: DEFAULT_LIMIT, semantic: false, maxChars: DEFAULT_MAX_CHARS };
  }
  const limit =
    typeof ar.limit === "number" && ar.limit >= 1 ? Math.min(ar.limit, 10) : DEFAULT_LIMIT;
  const maxChars =
    typeof ar.maxChars === "number" && ar.maxChars >= 512
      ? Math.min(ar.maxChars, 32_000)
      : DEFAULT_MAX_CHARS;
  const wings = Array.isArray(ar.wings)
    ? ar.wings
        .filter((w): w is string => typeof w === "string" && w.trim().length > 0)
        .map((w) => w.trim())
    : undefined;
  return {
    enabled: true,
    limit,
    semantic: ar.semantic === true,
    maxChars,
    wings,
  };
}

async function searchForAutoRag(
  store: ReturnType<typeof createMemoryStore>,
  query: string,
  limit: number,
  semantic: boolean
): Promise<MemoryNote[]> {
  if (semantic && store.searchNotesHybrid) {
    const hits = await store.searchNotesHybrid(query, limit);
    if (hits.length > 0) return hits;
  }
  if (semantic && store.searchNotesSemantic) {
    const hits = await store.searchNotesSemantic(query, limit);
    if (hits.length > 0) return hits;
  }
  return store.searchNotes(query, limit);
}

/** Top matching memory blocks for the user message (empty when disabled or no hits). */
export async function autoRagMemoryBlocks(
  dir: string,
  query: string,
  cfg?: AgentConfig
): Promise<string[]> {
  const config = cfg ?? loadConfig(dir);
  const opts = resolveAutoRag(config);
  if (!opts.enabled) return [];

  const q = query.trim();
  if (!q) return [];

  const store = createMemoryStore(dir, config.stateDir);
  try {
    const notes = await searchForAutoRag(store, q, opts.limit, opts.semantic);
    const blocks: string[] = [];
    const noteNames: string[] = [];
    let total = 0;
    let skipped = 0;
    for (const note of notes) {
      if (note.wing === SECURE_WING) continue;
      if (note.body === "(encrypted — use memory show)") continue;
      if (opts.wings?.length && !opts.wings.includes(note.wing)) continue;
      const block = formatAutoRagBlock(note, config.memory?.stalenessDays);
      if (total + block.length > opts.maxChars) {
        // Skip this note, don't stop the scan: a single oversized hit must not
        // drop the whole injection. `break` here meant one fat top hit silently
        // returned zero blocks — the agent got no memory and no way to notice.
        skipped += 1;
        continue;
      }
      blocks.push(block);
      noteNames.push(note.name);
      total += block.length;
    }
    if (agentLogEnabled()) {
      const log = resolveAgentLogger({ component: "autoRag" });
      const names = noteNames.length ? noteNames.join(",") : "-";
      log(`hits=${blocks.length} chars=${total} skipped=${skipped} notes=${names}`);
    }
    return blocks;
  } finally {
    await store.close();
  }
}
