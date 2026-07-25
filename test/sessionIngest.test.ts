import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createStore } from "../src/store.js";
import { createMemoryStore } from "../src/memoryStore.js";
import {
  EPISODIC_WING,
  episodicNoteName,
  formatEpisodicNoteBody,
  ingestRecentSessions,
  ingestSessionRecord,
  isTrivialSession,
} from "../src/sessionIngest.js";
import type { SessionRecord, RunRecord } from "../src/store.js";
import { executeCronJob } from "../src/cronEngine.js";
import { autoRagMemoryBlocks } from "../src/autoRag.js";
import { sessionStartMemoryBlocks } from "../src/memory.js";
import { composePrompt } from "../src/composePrompt.js";
import type { AgentConfig } from "../src/config.js";

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "session-ingest-"));
  mkdirSync(join(dir, ".agent"), { recursive: true });
  writeFileSync(
    join(dir, "agent.config.json"),
    JSON.stringify({ model: "m", runtime: "local", cwd: dir, stateDir: ".agent" }, null, 2)
  );
  return dir;
}

async function withKey<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = "crsr_test_key_for_session_ingest_0123456789";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prev;
  }
}

test("episodicNoteName prefixes session id", () => {
  assert.equal(episodicNoteName("sess_abc12345"), "ep.sess_abc12345");
});

test("ingestRecentSessions writes episodic note searchable via FTS", async () => {
  const dir = tmp();
  const store = createStore(dir, ".agent");
  const now = new Date().toISOString();
  await store.upsertSession({
    id: "sess_ingest1",
    title: "telegram chat",
    cwd: dir,
    runtime: "local",
    sdk_agent_id: null,
    last_status: "finished",
    channel: "telegram",
  });
  await store.recordRun({
    id: "run_i1",
    session_id: "sess_ingest1",
    sdk_agent_id: null,
    sdk_run_id: null,
    prompt_preview: "how does cron work",
    result_preview: "cron uses five-field schedule",
    status: "finished",
    error_kind: null,
    started_at: now,
    finished_at: now,
    cwd: dir,
    runtime: "local",
    model: "m",
  });
  await store.close();

  const out = await ingestRecentSessions(dir, { windowHours: 24 });
  assert.equal(out.ingested, 1);
  assert.equal(out.skipped, 0);
  assert.deepEqual(out.names, ["ep.sess_ingest1"]);

  const memory = createMemoryStore(dir, ".agent");
  try {
    const note = await memory.getNote("ep.sess_ingest1");
    assert.ok(note);
    assert.equal(note!.wing, EPISODIC_WING);
    assert.match(note!.body, /how does cron work/);
    assert.match(note!.body, /five-field schedule/);
    const hits = await memory.searchNotes("cron schedule", 5, { includeEpisodic: true });
    assert.ok(hits.some((h) => h.name === "ep.sess_ingest1"));
    const defaultHits = await memory.searchNotes("cron schedule", 5);
    assert.ok(!defaultHits.some((h) => h.name === "ep.sess_ingest1"));
  } finally {
    await memory.close();
  }
});

test("ingestRecentSessions skips up-to-date sessions", async () => {
  const dir = tmp();
  const store = createStore(dir, ".agent");
  const now = new Date().toISOString();
  await store.upsertSession({
    id: "sess_skip1",
    title: "summarize the parser changes", // non-trivial so it ingests (test is about up-to-date skip)
    cwd: dir,
    runtime: "local",
    sdk_agent_id: null,
    last_status: "finished",
  });
  await store.recordRun({
    id: "run_s1",
    session_id: "sess_skip1",
    sdk_agent_id: null,
    sdk_run_id: null,
    prompt_preview: "hello",
    result_preview: "hi",
    status: "finished",
    error_kind: null,
    started_at: now,
    finished_at: now,
    cwd: dir,
    runtime: "local",
    model: "m",
  });
  await store.close();

  const first = await ingestRecentSessions(dir);
  assert.equal(first.ingested, 1);
  const second = await ingestRecentSessions(dir);
  assert.equal(second.ingested, 0);
  assert.equal(second.skipped, 1);
});

test("ingestRecentSessions skips rotate-fail temp cwd sessions", async () => {
  const dir = tmp();
  const store = createStore(dir, ".agent");
  const tmpSess = mkdtempSync(join(tmpdir(), "rotate-fail-"));
  const now = new Date().toISOString();
  await store.upsertSession({
    id: "sess_testtmp",
    title: "rotation test noise",
    cwd: tmpSess,
    runtime: "local",
    sdk_agent_id: null,
    last_status: "finished",
    channel: "cli",
  });
  await store.recordRun({
    id: "run_testtmp",
    session_id: "sess_testtmp",
    sdk_agent_id: null,
    sdk_run_id: null,
    prompt_preview: "hello",
    result_preview: "hi",
    status: "finished",
    error_kind: null,
    started_at: now,
    finished_at: now,
    cwd: tmpSess,
    runtime: "local",
    model: "m",
    is_test: true,
  });
  await store.close();

  const out = await ingestRecentSessions(dir, { windowHours: 24 });
  assert.equal(out.ingested, 0);
  assert.equal(out.skipped, 1);
});

test("builtin session-ingest cron handler", async () => {
  await withKey(async () => {
    const dir = tmp();
    const store = createStore(dir, ".agent");
    const now = new Date().toISOString();
    await store.upsertSession({
      id: "sess_cron1",
      title: "cron ingest",
      cwd: dir,
      runtime: "local",
      sdk_agent_id: null,
      last_status: "finished",
    });
    await store.recordRun({
      id: "run_c1",
      session_id: "sess_cron1",
      sdk_agent_id: null,
      sdk_run_id: null,
      prompt_preview: "digest",
      result_preview: "ok",
      status: "finished",
      error_kind: null,
      started_at: now,
      finished_at: now,
      cwd: dir,
      runtime: "local",
      model: "m",
    });
    await store.close();

    const job = { id: "ing", cron: "0 4 * * 0", builtin: "session-ingest" as const };
    const result = await executeCronJob(job, { dir });
    assert.equal(result.ok, true);
    assert.match(result.message, /1 note/);
  });
});

test("autoRagMemoryBlocks disabled by default", async () => {
  const dir = tmp();
  const blocks = await autoRagMemoryBlocks(dir, "cron gateway");
  assert.deepEqual(blocks, []);
});

test("autoRagMemoryBlocks injects matching notes when enabled", async () => {
  const dir = tmp();
  const memory = createMemoryStore(dir, ".agent");
  await memory.upsertNote({
    name: "ops.gateway",
    wing: "default",
    title: "Gateway ops",
    body: "# Gateway\n\nTelegram long-poll and outbox drain.",
  });
  await memory.close();

  const cfg: AgentConfig = {
    model: "m",
    runtime: "local",
    cwd: dir,
    skillsPath: "skills",
    stateDir: ".agent",
    mcpServers: {},
    safety: { allowCloud: false, allowAutoPr: false },
    memory: { autoRag: { enabled: true, limit: 2 } },
    browser: {},
  };

  const blocks = await autoRagMemoryBlocks(dir, "telegram outbox", cfg);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0]!, /Telegram long-poll/);

  const composed = await composePrompt({
    userPrompt: "fix gateway",
    cwd: dir,
    dir,
    autoRagBlocks: blocks,
  });
  assert.match(composed, /Relevant memory \(retrieved for this message\)/);
  assert.match(composed, /Telegram long-poll/);
  assert.match(composed, /# Task/);
  assert.match(composed, /fix gateway/);
});

test("autoRagMemoryBlocks logs hits when CSAGENT_LOG=1", async () => {
  const dir = tmp();
  const memory = createMemoryStore(dir, ".agent");
  await memory.upsertNote({
    name: "ops.gateway",
    wing: "default",
    title: "Gateway ops",
    body: "# Gateway\n\nTelegram long-poll and outbox drain.",
  });
  await memory.close();

  const cfg: AgentConfig = {
    model: "m",
    runtime: "local",
    cwd: dir,
    skillsPath: "skills",
    stateDir: ".agent",
    mcpServers: {},
    safety: { allowCloud: false, allowAutoPr: false },
    memory: { autoRag: { enabled: true, limit: 2 } },
    browser: {},
  };

  const prevLog = process.env.CSAGENT_LOG;
  process.env.CSAGENT_LOG = "1";
  const captured: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;

  try {
    await autoRagMemoryBlocks(dir, "telegram outbox", cfg);
    const joined = captured.join("");
    assert.match(joined, /\[autoRag\]/);
    assert.match(joined, /hits=1/);
    assert.match(joined, /notes=ops\.gateway/);
  } finally {
    process.stdout.write = origWrite;
    if (prevLog === undefined) delete process.env.CSAGENT_LOG;
    else process.env.CSAGENT_LOG = prevLog;
  }
});

// An oversized top hit used to `break` the selection loop, so autoRag returned zero
// blocks even when smaller relevant notes were sitting right behind it — the agent got
// no memory at all and nothing in the prompt said so. Regression guard for that.
test("autoRagMemoryBlocks skips an oversized hit instead of dropping the whole injection", async () => {
  const dir = tmp();
  const memory = createMemoryStore(dir, ".agent");
  await memory.upsertNote({
    name: "ops.small",
    wing: "default",
    title: "Gateway ops",
    body: "# Gateway\n\nTelegram outbox drains on every poll.",
  });
  // searchNotes orders by updated_at DESC — the gap makes the oversized note hit #1.
  await new Promise((r) => setTimeout(r, 5));
  await memory.upsertNote({
    name: "ops.huge",
    wing: "default",
    title: "Gateway ops dump",
    body: `# Gateway\n\nTelegram outbox drains on every poll.\n\n${"padding ".repeat(500)}`,
  });
  // Precondition — assert the oversized note really ranks first, else this test is vacuous.
  const ranked = await memory.searchNotes("telegram outbox", 5);
  assert.equal(ranked[0]?.name, "ops.huge");
  await memory.close();

  const cfg: AgentConfig = {
    model: "m",
    runtime: "local",
    cwd: dir,
    skillsPath: "skills",
    stateDir: ".agent",
    mcpServers: {},
    safety: { allowCloud: false, allowAutoPr: false },
    memory: { autoRag: { enabled: true, limit: 3, maxChars: 1000 } },
    browser: {},
  };

  const blocks = await autoRagMemoryBlocks(dir, "telegram outbox", cfg);
  assert.equal(blocks.length, 1, "the small note must survive the oversized one");
  assert.match(blocks[0]!, /Telegram outbox drains/);
  assert.ok(!blocks[0]!.includes("padding"), "the oversized note must not be injected");
});

test("autoRagMemoryBlocks logs how many hits it dropped for size", async () => {
  const dir = tmp();
  const memory = createMemoryStore(dir, ".agent");
  await memory.upsertNote({
    name: "ops.small",
    wing: "default",
    title: "Gateway ops",
    body: "# Gateway\n\nTelegram outbox drains on every poll.",
  });
  await new Promise((r) => setTimeout(r, 5));
  await memory.upsertNote({
    name: "ops.huge",
    wing: "default",
    title: "Gateway ops dump",
    body: `# Gateway\n\nTelegram outbox drains on every poll.\n\n${"padding ".repeat(500)}`,
  });
  await memory.close();

  const cfg: AgentConfig = {
    model: "m",
    runtime: "local",
    cwd: dir,
    skillsPath: "skills",
    stateDir: ".agent",
    mcpServers: {},
    safety: { allowCloud: false, allowAutoPr: false },
    memory: { autoRag: { enabled: true, limit: 3, maxChars: 1000 } },
    browser: {},
  };

  const prevLog = process.env.CSAGENT_LOG;
  process.env.CSAGENT_LOG = "1";
  const captured: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;

  try {
    await autoRagMemoryBlocks(dir, "telegram outbox", cfg);
    const joined = captured.join("");
    assert.match(joined, /hits=1/);
    assert.match(joined, /skipped=1/);
  } finally {
    process.stdout.write = origWrite;
    if (prevLog === undefined) delete process.env.CSAGENT_LOG;
    else process.env.CSAGENT_LOG = prevLog;
  }
});

test("sessionStartMemoryBlocks skips an over-budget note instead of dropping the rest", async () => {
  const dir = tmp();
  const memory = createMemoryStore(dir, ".agent");
  await memory.upsertNote({ name: "big", wing: "default", title: "Big", body: "x".repeat(3000) });
  await memory.upsertNote({ name: "small", wing: "default", title: "Small", body: "keep me" });
  await memory.close();

  const cfg: AgentConfig = {
    model: "m",
    runtime: "local",
    cwd: dir,
    skillsPath: "skills",
    stateDir: ".agent",
    mcpServers: {},
    safety: { allowCloud: false, allowAutoPr: false },
    memory: { onStart: ["big", "small"], maxCharsPerTurn: 1000 },
    browser: {},
  };

  const blocks = await sessionStartMemoryBlocks(dir, cfg);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0]!, /keep me/);
});

test("ingestSessionRecord returns skipped for empty runs", async () => {
  const dir = tmp();
  const memory = createMemoryStore(dir, ".agent");
  try {
    const status = await ingestSessionRecord(
      memory,
      {
        id: "sess_empty",
        title: "empty",
        cwd: dir,
        runtime: "local",
        sdk_agent_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_status: "created",
        selected_skills: null,
        mcp_server_names: null,
        channel: "",
      },
      []
    );
    assert.equal(status, "skipped");
  } finally {
    await memory.close();
  }
});

test("formatEpisodicNoteBody includes session metadata", () => {
  const body = formatEpisodicNoteBody(
    {
      id: "sess_x",
      title: "My chat",
      cwd: "/tmp",
      runtime: "local",
      sdk_agent_id: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      last_status: "finished",
      selected_skills: null,
      mcp_server_names: null,
      channel: "tui",
    },
    [
      {
        id: "run_x",
        session_id: "sess_x",
        sdk_agent_id: null,
        sdk_run_id: null,
        prompt_preview: "q",
        result_preview: "a",
        status: "finished",
        error_kind: null,
        started_at: "2026-01-02T00:00:00Z",
        finished_at: "2026-01-02T00:00:01Z",
        cwd: "/tmp",
        runtime: "local",
        model: "m",
      },
    ]
  );
  assert.match(body, /sess_x/);
  assert.match(body, /My chat/);
  assert.match(body, /\*\*User:\*\*/);
});

describe("isTrivialSession (I-123 source filter)", () => {
  const s = (title: string): SessionRecord =>
    ({ id: "x", title, cwd: "/work", runtime: "local", sdk_agent_id: null, last_status: "finished", created_at: "t", updated_at: "t", channel: "telegram" }) as unknown as SessionRecord;
  const r = (over: Partial<RunRecord> = {}): RunRecord =>
    ({ status: "finished", is_test: false, cwd: "/work", ...over }) as unknown as RunRecord;

  test("flags greeting/test/once titles with no substantive work", () => {
    for (const t of ["hello", "hi", "t", "once", "test", "ping", "ok", ""]) {
      assert.equal(isTrivialSession(s(t), [r()]), true, `"${t}" should be trivial`);
    }
  });
  test("keeps a junk-titled session that actually did multi-turn work", () => {
    assert.equal(isTrivialSession(s("hello"), [r(), r()]), false, "≥2 substantive runs ⇒ keep");
  });
  test("keeps a real-titled session regardless of run count", () => {
    assert.equal(isTrivialSession(s("fix the parser bug"), [r()]), false);
    assert.equal(isTrivialSession(s("Расскажи сказку"), [r()]), false); // non-trivial (non-ascii) title kept
  });
  test("does not count test/errored runs as substantive", () => {
    assert.equal(isTrivialSession(s("hi"), [r({ is_test: true } as Partial<RunRecord>), r({ status: "error" } as Partial<RunRecord>)]), true);
  });
});
