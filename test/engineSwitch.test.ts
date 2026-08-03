import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  clearChatEngine,
  getChatEngine,
  loadGatewayEngines,
  parseEngineArg,
  setChatEngine,
} from "../src/gatewayEngineStore.js";
import { handleGatewaySlash, GATEWAY_SLASH_COMMANDS } from "../src/gatewaySlash.js";
import type { GatewayConfig } from "../src/gatewayConfig.js";
import { parseSlash } from "../src/tui/slash.js";

// I-143: pick the SDK engine from Telegram (/engine, sticky per chat) and the
// TUI (/engine, session override). Switching always opens a fresh session.

function tmp(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "engine-"));
  mkdirSync(join(dir, ".agent"), { recursive: true });
  return dir;
}

/** claude-agent switch needs credentials; account auth legitimately has none. */
function tmpWithAccountAuth(): string {
  const dir = tmp();
  writeFileSync(
    join(dir, "agent.config.json"),
    JSON.stringify({ stateDir: ".agent", cwd: dir, engine: { provider: "cursor", auth: "account" } }),
    "utf8"
  );
  return dir;
}

function withoutAnthropicEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevTok = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  return fn().finally(() => {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevTok === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevTok;
  });
}

const ctxFor = (dir: string, resetLog: string[]) => ({
  dir,
  adapter: "telegram",
  chatId: "42",
  cfg: {} as GatewayConfig,
  skills: [],
  resetSession: async () => {
    resetLog.push("reset");
    return null;
  },
});

test("parseEngineArg accepts aliases and rejects junk", () => {
  assert.equal(parseEngineArg("cursor"), "cursor");
  assert.equal(parseEngineArg("claude"), "claude-agent");
  assert.equal(parseEngineArg("Claude-Agent"), "claude-agent");
  // I-144: the OpenAI runtime Irida drives is codex; gpt/openai/oai alias to it.
  assert.equal(parseEngineArg("codex"), "codex");
  assert.equal(parseEngineArg("gpt"), "codex");
  assert.equal(parseEngineArg("openai"), "codex");
  assert.equal(parseEngineArg("gemini"), null);
  assert.equal(parseEngineArg(""), null);
});

test("engine store: set/get/clear survive reload and validate values", () => {
  const dir = tmp();
  assert.equal(getChatEngine(dir, "telegram", "42"), undefined);
  setChatEngine(dir, "telegram", "42", "claude-agent");
  assert.equal(getChatEngine(dir, "telegram", "42"), "claude-agent");
  assert.equal(loadGatewayEngines(dir).engines["telegram:42"], "claude-agent");
  assert.equal(clearChatEngine(dir, "telegram", "42"), true);
  assert.equal(clearChatEngine(dir, "telegram", "42"), false);
  // Corrupt/foreign values are dropped on load.
  writeFileSync(
    join(dir, ".agent", "gateway.engines.json"),
    JSON.stringify({ version: 1, engines: { "telegram:42": "gpt-5" } }),
    "utf8"
  );
  assert.equal(getChatEngine(dir, "telegram", "42"), undefined);
});

test("/engine bare shows the config default when no sticky choice is set", async () => {
  const dir = tmp();
  const resets: string[] = [];
  const reply = await handleGatewaySlash("/engine", ctxFor(dir, resets));
  assert.ok(reply);
  assert.match(reply!, /cursor/); // config default
  assert.match(reply!, /из конфига/);
  assert.deepEqual(resets, []);
});

test("/engine claude sets the sticky choice and resets the session", async () => {
  const dir = tmpWithAccountAuth();
  const resets: string[] = [];
  const reply = await handleGatewaySlash("/engine claude", ctxFor(dir, resets));
  assert.ok(reply);
  assert.match(reply!, /claude-agent/);
  assert.equal(getChatEngine(dir, "telegram", "42"), "claude-agent");
  assert.deepEqual(resets, ["reset"]);
  // Bare /engine now reports the sticky choice.
  const show = await handleGatewaySlash("/engine", ctxFor(dir, resets));
  assert.match(show!, /claude-agent/);
  assert.match(show!, /sticky/);
});

test("/engine with the already-active engine is a no-op (no session reset)", async () => {
  const dir = tmp();
  const resets: string[] = [];
  const reply = await handleGatewaySlash("/engine cursor", ctxFor(dir, resets));
  assert.match(reply!, /уже/);
  assert.deepEqual(resets, []);
  assert.equal(getChatEngine(dir, "telegram", "42"), undefined);
});

test("/engine off clears the sticky choice and resets the session", async () => {
  const dir = tmp();
  const resets: string[] = [];
  setChatEngine(dir, "telegram", "42", "claude-agent");
  const reply = await handleGatewaySlash("/engine off", ctxFor(dir, resets));
  assert.match(reply!, /из конфига/);
  assert.equal(getChatEngine(dir, "telegram", "42"), undefined);
  assert.deepEqual(resets, ["reset"]);
  // off again — nothing to clear, no reset.
  const again = await handleGatewaySlash("/engine off", ctxFor(dir, resets));
  assert.match(again!, /не был задан/);
  assert.deepEqual(resets, ["reset"]);
});

test("/engine refuses a doomed switch: claude-agent with api-key auth and no key", async () => {
  await withoutAnthropicEnv(async () => {
    const dir = tmp(); // no engine block -> auth defaults to api-key
    const resets: string[] = [];
    const reply = await handleGatewaySlash("/engine claude", ctxFor(dir, resets));
    assert.match(reply!, /не переключаю/);
    assert.match(reply!, /ANTHROPIC_API_KEY/);
    assert.equal(getChatEngine(dir, "telegram", "42"), undefined); // sticky untouched
    assert.deepEqual(resets, []); // and the session was not reset
  });
});

test("/engine rejects unknown engines", async () => {
  const dir = tmp();
  const resets: string[] = [];
  // Not "gpt" — that aliases to codex since I-144.
  const reply = await handleGatewaySlash("/engine gemini", ctxFor(dir, resets));
  assert.match(reply!, /неизвестный движок/);
  assert.deepEqual(resets, []);
});

test("/engine is in the gateway catalog and the TUI parser", () => {
  assert.ok(GATEWAY_SLASH_COMMANDS.some((c) => c.cmd === "engine"));
  assert.deepEqual(parseSlash("/engine"), { type: "engine", engine: undefined });
  assert.deepEqual(parseSlash("/engine claude"), { type: "engine", engine: "claude" });
});

test("router opens the peer session with the sticky engine choice", async () => {
  const { GatewaySessionRouter } = await import("../src/gatewayRouter.js");
  const prev = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = "test-key";
  const dir = tmp();
  // account auth: claude-agent legitimately opens without a token.
  writeFileSync(
    join(dir, "agent.config.json"),
    JSON.stringify({ stateDir: ".agent", cwd: dir, engine: { provider: "cursor", auth: "account" } }),
    "utf8"
  );
  setChatEngine(dir, "telegram", "77", "claude-agent");
  const sdk = {
    prompt: async () => ({ status: "finished", result: "x", id: "r", agentId: "a" }),
    create: async () => ({ agentId: "a1", send: async () => ({ stream: async function* () {}, wait: async () => ({ status: "finished" }) }) }),
    resume: async () => ({ agentId: "a1", send: async () => ({ stream: async function* () {}, wait: async () => ({ status: "finished" }) }) }),
  };
  const router = new GatewaySessionRouter({ dir, adapter: "telegram", sdk });
  try {
    const session = await router.getOrCreateSession("77");
    assert.equal(session.cfg.engine.provider, "claude-agent");
  } finally {
    await router.closeAll();
    if (prev === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prev;
  }
});
