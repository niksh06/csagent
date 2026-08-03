import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadConfig, ConfigError, applyEngineOverride } from "../src/config.js";

function tmp(): string {
  return mkdtempSync(resolve(tmpdir(), "cfg-"));
}

test("memory.embeddings.provider survives parsing (I-131)", () => {
  const dir = tmp();
  writeFileSync(
    resolve(dir, "agent.config.json"),
    JSON.stringify({
      memory: { embeddings: { enabled: true, provider: "embed-service", url: "http://127.0.0.1:8014" } },
    })
  );
  const e = loadConfig(dir).memory?.embeddings;
  assert.equal(e?.enabled, true);
  assert.equal(e?.provider, "embed-service"); // schema must not drop the field
  assert.equal(e?.url, "http://127.0.0.1:8014");
});

test("defaults when no config file", () => {
  const dir = tmp();
  const c = loadConfig(dir);
  assert.equal(c.model, "composer-2.5");
  assert.equal(c.runtime, "local");
  assert.equal(c.cwd, dir);
  assert.equal(c.safety.allowCloud, false);
  assert.equal(c.engine.provider, "cursor");
});

test("config: falls back to IRIDA_HOME when launch dir has none (two-config fix)", () => {
  const home = tmp();
  const install = tmp(); // no config here — mimics cron-tick's install-root cwd
  writeFileSync(
    resolve(home, "agent.config.json"),
    JSON.stringify({ model: "from-home", engine: { provider: "claude-agent" } })
  );
  const prev = process.env.IRIDA_HOME;
  process.env.IRIDA_HOME = home;
  try {
    // install/ has no config → read home/, but cwd/state stay anchored to `dir`.
    const c = loadConfig(install);
    assert.equal(c.model, "from-home");
    assert.equal(c.engine.provider, "claude-agent");
    assert.equal(c.cwd, install); // only the FILE location moves home, not cwd

    // A local config wins over home (explicit --dir / per-install override).
    writeFileSync(
      resolve(install, "agent.config.json"),
      JSON.stringify({ model: "from-install" })
    );
    assert.equal(loadConfig(install).model, "from-install");
  } finally {
    if (prev === undefined) delete process.env.IRIDA_HOME;
    else process.env.IRIDA_HOME = prev;
  }
});

test("engine: selects claude-agent with optional model override", () => {
  const dir = tmp();
  writeFileSync(
    resolve(dir, "agent.config.json"),
    JSON.stringify({ engine: { provider: "claude-agent", model: "claude-opus-4-8" } })
  );
  const c = loadConfig(dir);
  assert.equal(c.engine.provider, "claude-agent");
  assert.equal(c.engine.model, "claude-opus-4-8");
});

test("engine: provider defaults to cursor when only model given", () => {
  const dir = tmp();
  writeFileSync(resolve(dir, "agent.config.json"), JSON.stringify({ engine: { model: "x" } }));
  assert.equal(loadConfig(dir).engine.provider, "cursor");
});

test("engine: rejects unknown provider", () => {
  const dir = tmp();
  writeFileSync(resolve(dir, "agent.config.json"), JSON.stringify({ engine: { provider: "gpt" } }));
  assert.throws(() => loadConfig(dir), ConfigError);
});

test("applyEngineOverride: sets provider+auth, validates, no mutation, no-op", () => {
  const base = loadConfig(tmp());
  const o = applyEngineOverride(base, "claude-agent", "account");
  assert.equal(o.engine.provider, "claude-agent");
  assert.equal(o.engine.auth, "account");
  assert.equal(base.engine.provider, "cursor"); // original untouched
  assert.equal(applyEngineOverride(base).engine.provider, "cursor"); // no-op when no flags
  // "gpt" is a codex alias since I-144; a real non-engine still throws.
  assert.equal(applyEngineOverride(base, "gpt").engine.provider, "codex");
  assert.equal(applyEngineOverride(base, "openai").engine.provider, "codex");
  assert.throws(() => applyEngineOverride(base, "gemini"), ConfigError);
  assert.throws(() => applyEngineOverride(base, undefined, "oauth"), ConfigError);
});

test("rejects secrets in config", () => {
  const dir = tmp();
  writeFileSync(resolve(dir, "agent.config.json"), JSON.stringify({ CURSOR_API_KEY: "x" }));
  assert.throws(() => loadConfig(dir), ConfigError);
});

test("rejects invalid JSON", () => {
  const dir = tmp();
  writeFileSync(resolve(dir, "agent.config.json"), "{ not json");
  assert.throws(() => loadConfig(dir), ConfigError);
});

test("rejects bad runtime", () => {
  const dir = tmp();
  writeFileSync(resolve(dir, "agent.config.json"), JSON.stringify({ runtime: "moon" }));
  assert.throws(() => loadConfig(dir), ConfigError);
});

test("accepts valid overrides", () => {
  const dir = tmp();
  writeFileSync(
    resolve(dir, "agent.config.json"),
    JSON.stringify({ model: "composer-2", runtime: "cloud", safety: { allowCloud: true } })
  );
  const c = loadConfig(dir);
  assert.equal(c.model, "composer-2");
  assert.equal(c.runtime, "cloud");
  assert.equal(c.safety.allowCloud, true);
});

function write(dir: string, cfg: unknown): void {
  writeFileSync(resolve(dir, "agent.config.json"), JSON.stringify(cfg));
}

test("safety is lenient — non-true coerces to false (no throw)", () => {
  const dir = tmp();
  write(dir, { safety: { allowCloud: "yes", allowAutoPr: 1 } });
  const c = loadConfig(dir);
  assert.equal(c.safety.allowCloud, false);
  assert.equal(c.safety.allowAutoPr, false);
});

test("string arrays are trimmed and empties dropped", () => {
  const dir = tmp();
  write(dir, { memory: { onStart: ["  a ", "", "  ", "b"] } });
  assert.deepEqual(loadConfig(dir).memory.onStart, ["a", "b"]);
});

test("nested strings are stored trimmed", () => {
  const dir = tmp();
  write(dir, { memory: { embeddings: { url: "  http://x  " } } });
  assert.equal(loadConfig(dir).memory.embeddings?.url, "http://x");
});

test("rejects numeric minimums", () => {
  for (const cfg of [
    { memory: { maxCharsPerTurn: 10 } },
    { memory: { autoRag: { limit: 0 } } },
    { memory: { search: { hybridWeights: { fts: 0 } } } },
    { hooks: { preTurn: { command: "x", timeoutMs: 50 } } },
  ]) {
    const dir = tmp();
    write(dir, cfg);
    assert.throws(() => loadConfig(dir), ConfigError, JSON.stringify(cfg));
  }
});

test("rejects a nested object given as an array", () => {
  const dir = tmp();
  write(dir, { memory: [] });
  assert.throws(() => loadConfig(dir), ConfigError);
});

test("skillPolicy only materializes when allowUnsafe is present", () => {
  const a = tmp();
  write(a, { skillPolicy: {} });
  assert.equal(loadConfig(a).skillPolicy, undefined);

  const b = tmp();
  write(b, { skillPolicy: { allowUnsafe: [" s ", ""] } });
  assert.deepEqual(loadConfig(b).skillPolicy, { allowUnsafe: ["s"] });
});
