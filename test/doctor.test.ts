import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cmdDoctor } from "../src/doctor.js";
import { gatherDoctorApiChecks, gatherDoctorChecks, gatherDoctorTelegramChecks } from "../src/doctorChecks.js";
import { gatherStaleDistChecks } from "../src/doctorDistStale.js";

const VALID_TEST_KEY = "crsr_" + "k".repeat(24);

function withKey(value: string | undefined, fn: () => void | Promise<void>): Promise<void> {
  const prev = process.env.CURSOR_API_KEY;
  if (value === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = value;
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prev;
  });
}

test("gatherCronNotifyChecks flags notify blocks without chatId (§107)", async () => {
  const { gatherCronNotifyChecks } = await import("../src/doctorChecks.js");
  const { cronJobsPath } = await import("../src/cronJobs.js");
  const dir = mkdtempSync(resolve(tmpdir(), "doc-notify-"));
  const path = cronJobsPath(dir);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      jobs: [
        { id: "loud", cron: "0 9 * * *", prompt: "x", notify: { chatId: "42", telegram: true } },
        { id: "mute", cron: "0 9 * * *", prompt: "x", notify: { telegram: true, webhookUrl: "https://x" } },
        { id: "silent-by-design", cron: "0 9 * * *", prompt: "x" },
      ],
    })
  );
  const checks = gatherCronNotifyChecks(dir);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].ok, false);
  assert.match(checks[0].detail, /mute/);
  assert.doesNotMatch(checks[0].detail, /loud|silent-by-design/);
});

test("gatherCronNotifyChecks passes when every notify has a chatId", async () => {
  const { gatherCronNotifyChecks } = await import("../src/doctorChecks.js");
  const { cronJobsPath } = await import("../src/cronJobs.js");
  const dir = mkdtempSync(resolve(tmpdir(), "doc-notify-ok-"));
  const path = cronJobsPath(dir);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      jobs: [{ id: "loud", cron: "0 9 * * *", prompt: "x", notify: { chatId: "42" } }],
    })
  );
  const checks = gatherCronNotifyChecks(dir);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].ok, true);
});

test("doctor fails without API key", async () => {
  await withKey(undefined, async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "doc-"));
    assert.equal(await cmdDoctor(dir), 1);
  });
});

test("doctor passes with key + writable dir + models API", async () => {
  await withKey(VALID_TEST_KEY, async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "doc-"));
    assert.equal(
      await cmdDoctor(dir, {
        listModels: async () => [{ id: "composer-2.5" }, { id: "gpt-5.4" }],
      }),
      0
    );
  });
});

test("doctor fails when models API rejects key", async () => {
  await withKey("bad-key", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "doc-bad-"));
    assert.equal(
      await cmdDoctor(dir, {
        listModels: async () => {
          throw Object.assign(new Error("Authentication failed"), { code: 16 });
        },
      }),
      1
    );
  });
});

test("gatherDoctorTelegramChecks skips without gateway.json", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "doc-tg-"));
  assert.deepEqual(await gatherDoctorTelegramChecks(dir), []);
});

test("gatherDoctorApiChecks skips when key unset", async () => {
  await withKey(undefined, async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "doc-nocred-"));
    assert.deepEqual(await gatherDoctorApiChecks(dir), []);
  });
});

test("gatherDoctorChecks reports secret format failures", () => {
  const prev = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = "short";
  try {
    const dir = mkdtempSync(resolve(tmpdir(), "doc-fmt-"));
    const checks = gatherDoctorChecks(dir);
    const fmt = checks.find((c) => c.name === "CURSOR_API_KEY format");
    assert.ok(fmt);
    assert.equal(fmt!.ok, false);
  } finally {
    if (prev === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prev;
  }
});

test("gatherDoctorApiChecks reports model count", async () => {
  await withKey(VALID_TEST_KEY, async () => {
    const checks = await gatherDoctorApiChecks(".", {
      listModels: async () => [{ id: "a" }, { id: "b" }],
    });
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.ok, true);
    assert.match(checks[0]?.detail ?? "", /2 model/);
  });
});

test("gatherDoctorChecks reports autoRag disabled by default", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "doc-ar-off-"));
  mkdirSync(join(dir, ".agent"), { recursive: true });
  writeFileSync(join(dir, "agent.config.json"), JSON.stringify({ model: "m", runtime: "local" }));
  const ar = gatherDoctorChecks(dir).find((c) => c.name === "autoRag");
  assert.ok(ar);
  assert.equal(ar!.ok, true);
  assert.match(ar!.detail, /disabled/);
});

test("gatherDoctorChecks fails autoRag when meta wing enabled", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "doc-ar-meta-"));
  mkdirSync(join(dir, ".agent"), { recursive: true });
  writeFileSync(
    join(dir, "agent.config.json"),
    JSON.stringify({
      model: "m",
      runtime: "local",
      memory: { autoRag: { enabled: true, wings: ["default", "meta"] } },
    })
  );
  const ar = gatherDoctorChecks(dir).find((c) => c.name === "autoRag");
  assert.ok(ar);
  assert.equal(ar!.ok, false);
  assert.match(ar!.detail, /meta/);
});

test("gatherDoctorChecks resolves skills root via CSAGENT_ROOT", () => {
  const home = mkdtempSync(resolve(tmpdir(), "doc-sk-home-"));
  const root = join(home, "csagent");
  const skillsDir = join(root, "skills");
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(join(home, ".agent"), { recursive: true });
  writeFileSync(join(skillsDir, "memory-ops.md"), "---\nname: memory-ops\n---\nbody");
  writeFileSync(
    join(home, ".agent", "gateway.json"),
    JSON.stringify({
      version: 1,
      adapter: "telegram",
      allowedChatIds: ["1"],
      skills: ["memory-ops"],
      telegram: { tokenEnv: "TELEGRAM_BOT_TOKEN" },
    })
  );

  const prevHome = process.env.CSAGENT_HOME;
  const prevRoot = process.env.CSAGENT_ROOT;
  process.env.CSAGENT_HOME = home;
  process.env.CSAGENT_ROOT = root;
  try {
    const checks = gatherDoctorChecks(home);
    const skillsRoot = checks.find((c) => c.name === "skills root");
    assert.ok(skillsRoot);
    assert.equal(skillsRoot!.ok, true);
    assert.match(skillsRoot!.detail, new RegExp(`${skillsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    const gwSkills = checks.find((c) => c.name === "gateway skills");
    assert.ok(gwSkills);
    assert.equal(gwSkills!.ok, true);
    assert.match(gwSkills!.detail, /memory-ops/);
    assert.ok(gwSkills!.detail.includes(skillsDir));
  } finally {
    if (prevHome === undefined) delete process.env.CSAGENT_HOME;
    else process.env.CSAGENT_HOME = prevHome;
    if (prevRoot === undefined) delete process.env.CSAGENT_ROOT;
    else process.env.CSAGENT_ROOT = prevRoot;
  }
});

test("gatherStaleDistChecks warns when dist is older than src", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "doc-dist-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "dist"), { recursive: true });
  const src = join(dir, "src/memoryStore.ts");
  const dist = join(dir, "dist/memoryStore.js");
  writeFileSync(src, "// src\n");
  writeFileSync(dist, "// dist\n");
  const base = Date.now() / 1000;
  utimesSync(dist, base - 60, base - 60);
  utimesSync(src, base, base);

  const stale = gatherStaleDistChecks(dir);
  assert.equal(stale.length, 1);
  assert.equal(stale[0]?.ok, false);
  assert.match(stale[0]?.detail ?? "", /memoryStore/);
});

// I-172: a dead embedder used to be invisible — makeEmbedder fails soft by design,
// so nothing anywhere said the semantic layer was gone. doctor is where that has to
// surface, and a liveness ping is not enough: a service running the WRONG model
// answers 200 with a vector of the wrong width and silently poisons a 768-dim corpus.

function embedderCfgDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "doctor-embed-"));
  writeFileSync(
    join(dir, "agent.config.json"),
    JSON.stringify({
      memory: {
        embeddings: { enabled: true, provider: "embed-service", url: "http://127.0.0.1:8014" },
      },
    })
  );
  return dir;
}

function stubFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })) as unknown as typeof fetch;
}

test("doctor: embeddings check passes on a correct round-trip", async () => {
  const { gatherDoctorEmbedderChecks } = await import("../src/doctorChecks.js");
  const checks = await gatherDoctorEmbedderChecks(
    embedderCfgDir(),
    stubFetch({ vector: new Array(768).fill(0.1) })
  );
  assert.equal(checks[0]?.ok, true);
  assert.match(checks[0]?.detail ?? "", /768-dim/);
});

test("doctor: embeddings check fails loudly on a wrong-width vector", async () => {
  const { gatherDoctorEmbedderChecks } = await import("../src/doctorChecks.js");
  const checks = await gatherDoctorEmbedderChecks(
    embedderCfgDir(),
    stubFetch({ vector: new Array(384).fill(0.1) })
  );
  assert.equal(checks[0]?.ok, false);
  assert.match(checks[0]?.detail ?? "", /384-dim, expected 768/);
  assert.match(checks[0]?.detail ?? "", /different model/);
});

test("doctor: embeddings check fails when the service is unreachable", async () => {
  const { gatherDoctorEmbedderChecks } = await import("../src/doctorChecks.js");
  const dead = (async () => {
    throw new Error("fetch failed");
  }) as unknown as typeof fetch;
  const checks = await gatherDoctorEmbedderChecks(embedderCfgDir(), dead);
  assert.equal(checks[0]?.ok, false);
  assert.match(checks[0]?.detail ?? "", /unreachable/);
  assert.ok(checks[0]?.fix, "a failed check must carry a copy-paste remedy");
});

test("doctor: embeddings check stays quiet when embeddings are off", async () => {
  const { gatherDoctorEmbedderChecks } = await import("../src/doctorChecks.js");
  const dir = mkdtempSync(resolve(tmpdir(), "doctor-embed-off-"));
  writeFileSync(join(dir, "agent.config.json"), JSON.stringify({ memory: {} }));
  const checks = await gatherDoctorEmbedderChecks(dir, stubFetch({}));
  assert.equal(checks[0]?.ok, true);
  assert.match(checks[0]?.detail ?? "", /disabled/);
});

test("run log checks: disabled recorder is named, not passed off as 'no runs' (Vesper §98)", async () => {
  const { gatherRunLogChecks } = await import("../src/doctorChecks.js");
  const dir = mkdtempSync(resolve(tmpdir(), "doc-runlog-"));
  const prev = process.env.IRIDA_RUN_LOG;
  try {
    process.env.IRIDA_RUN_LOG = "0";
    const off = gatherRunLogChecks(dir);
    assert.equal(off.length, 1);
    assert.match(off[0].detail, /DISABLED/);
    delete process.env.IRIDA_RUN_LOG;
    const on = gatherRunLogChecks(dir);
    assert.match(on[0]?.detail ?? "", /no runs in last 24h/);
  } finally {
    if (prev === undefined) delete process.env.IRIDA_RUN_LOG;
    else process.env.IRIDA_RUN_LOG = prev;
  }
});
