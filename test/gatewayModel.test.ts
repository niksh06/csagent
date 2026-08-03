import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  clearChatModel,
  getChatModel,
  loadGatewayModels,
  modelConflict,
  modelEngineFamily,
  setChatModel,
} from "../src/gatewayModelStore.js";
import { setChatEngine } from "../src/gatewayEngineStore.js";
import { handleGatewaySlash, GATEWAY_SLASH_COMMANDS } from "../src/gatewaySlash.js";
import { resolveEngineModel, DEFAULT_CODEX_MODEL, defaults } from "../src/config.js";
import type { GatewayConfig } from "../src/gatewayConfig.js";

// I-174: pick the model per chat from Telegram. Unlike /engine the session
// survives — every engine takes the model per turn.

function tmp(engine?: Record<string, unknown>): string {
  const dir = mkdtempSync(resolve(tmpdir(), "model-"));
  mkdirSync(join(dir, ".agent"), { recursive: true });
  if (engine) writeFileSync(join(dir, "agent.config.json"), JSON.stringify({ engine }));
  return dir;
}

function ctxFor(dir: string, reopens: number[] = [], resets: string[] = []) {
  return {
    dir,
    adapter: "telegram",
    chatId: "42",
    cfg: {} as GatewayConfig,
    skills: [],
    reopenSession: async () => {
      reopens.push(1);
    },
    resetSession: async () => {
      resets.push("reset");
      return null;
    },
  };
}

test("model family is recognized by prefix, unknown ids stay allowed", () => {
  assert.equal(modelEngineFamily("claude-opus-5"), "claude-agent");
  assert.equal(modelEngineFamily("gpt-5.6-sol"), "codex");
  assert.equal(modelEngineFamily("o3-mini"), "codex");
  assert.equal(modelEngineFamily("composer-2.5"), "cursor");
  // A future id must not be locked out by our prefix list.
  assert.equal(modelEngineFamily("someone-new-1"), null);
  assert.equal(modelEngineFamily(""), null);
});

test("only a cross-family model is refused", () => {
  // The fatal case: Codex answers a Claude id with HTTP 400 on every message.
  assert.match(modelConflict("codex", "claude-opus-5") ?? "", /claude-agent/);
  assert.match(modelConflict("claude-agent", "gpt-5.4") ?? "", /codex/);
  assert.equal(modelConflict("codex", "gpt-5.6-sol"), null);
  assert.equal(modelConflict("claude-agent", "claude-opus-5"), null);
  // Unknown family → allowed rather than guessed.
  assert.equal(modelConflict("codex", "experimental-x"), null);
});

test("the sticky model round-trips and clears", () => {
  const dir = tmp();
  assert.equal(getChatModel(dir, "telegram", "42"), undefined);
  setChatModel(dir, "telegram", "42", " claude-opus-5 ");
  assert.equal(getChatModel(dir, "telegram", "42"), "claude-opus-5");
  assert.equal(loadGatewayModels(dir).models["telegram:42"], "claude-opus-5");
  // Other chats are unaffected.
  assert.equal(getChatModel(dir, "telegram", "43"), undefined);
  assert.equal(clearChatModel(dir, "telegram", "42"), true);
  assert.equal(clearChatModel(dir, "telegram", "42"), false);
});

test("/model with no argument reports the active model and its source", async () => {
  const dir = tmp({ provider: "claude-agent", model: "claude-opus-5" });
  const bare = await handleGatewaySlash("/model", ctxFor(dir));
  assert.match(bare!, /claude-opus-5/);
  assert.match(bare!, /из конфига/);

  setChatModel(dir, "telegram", "42", "claude-haiku-4-5");
  const sticky = await handleGatewaySlash("/model", ctxFor(dir));
  assert.match(sticky!, /claude-haiku-4-5/);
  assert.match(sticky!, /sticky/);
});

test("/model sets a sticky model and keeps the session", async () => {
  const dir = tmp({ provider: "claude-agent", model: "claude-opus-5" });
  const reopens: number[] = [];
  const resets: string[] = [];
  const reply = await handleGatewaySlash("/model claude-sonnet-5", ctxFor(dir, reopens, resets));
  assert.match(reply!, /claude-sonnet-5/);
  assert.equal(getChatModel(dir, "telegram", "42"), "claude-sonnet-5");
  // Re-opened (so the new model applies) but NOT reset — context survives.
  assert.equal(reopens.length, 1);
  assert.deepEqual(resets, []);
});

test("/model refuses a model from another engine instead of breaking every turn", async () => {
  const dir = tmp({ provider: "codex", auth: "account" });
  const reopens: number[] = [];
  const reply = await handleGatewaySlash("/model claude-opus-5", ctxFor(dir, reopens));
  assert.match(reply!, /не переключаю/);
  assert.equal(getChatModel(dir, "telegram", "42"), undefined);
  assert.equal(reopens.length, 0);
});

test("/model validates against the STICKY engine, not just the config", async () => {
  // Config says claude-agent, but this chat switched to codex — a claude id
  // must be refused for this chat even though the config would accept it.
  const dir = tmp({ provider: "claude-agent", model: "claude-opus-5" });
  setChatEngine(dir, "telegram", "42", "codex");
  const reply = await handleGatewaySlash("/model claude-opus-5", ctxFor(dir));
  assert.match(reply!, /не переключаю/);

  // And the reported default is the codex one, not the config's claude model.
  const bare = await handleGatewaySlash("/model", ctxFor(dir));
  assert.match(bare!, new RegExp(DEFAULT_CODEX_MODEL.replace(/\./g, "\\.")));
  assert.match(bare!, /codex/);
});

test("/model off returns to the config default", async () => {
  const dir = tmp({ provider: "claude-agent", model: "claude-opus-5" });
  const reopens: number[] = [];
  assert.match((await handleGatewaySlash("/model off", ctxFor(dir)))!, /не была задана/);
  setChatModel(dir, "telegram", "42", "claude-haiku-4-5");
  const reply = await handleGatewaySlash("/model off", ctxFor(dir, reopens));
  assert.match(reply!, /claude-opus-5/);
  assert.equal(getChatModel(dir, "telegram", "42"), undefined);
  assert.equal(reopens.length, 1);
});

test("/model rejects an argument that is not a model id", async () => {
  const dir = tmp({ provider: "claude-agent", model: "claude-opus-5" });
  const reply = await handleGatewaySlash("/model claude opus 5", ctxFor(dir));
  assert.match(reply!, /пробел/);
  assert.equal(getChatModel(dir, "telegram", "42"), undefined);
});

test("/model is in the gateway command catalog", () => {
  assert.ok(GATEWAY_SLASH_COMMANDS.some((c) => c.cmd === "model"));
});

test("resolveEngineModel is the one definition of the effective model", () => {
  const base = defaults("/tmp");
  assert.equal(resolveEngineModel({ ...base, engine: { provider: "codex" } }), DEFAULT_CODEX_MODEL);
  assert.equal(
    resolveEngineModel({ ...base, engine: { provider: "codex", model: "gpt-5.4" } }),
    "gpt-5.4"
  );
  // The cursor engine reads the top-level model, not engine.model.
  assert.equal(resolveEngineModel({ ...base, model: "composer-2.5" }), "composer-2.5");
});
