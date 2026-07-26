import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_DIGEST_JOB_ID,
  DIGEST_TG_TARGET_CHARS,
  DIGEST_QA_MAX_BODY_CHARS,
  digestNeverRan,
  evaluateDigestQa,
  formatDigestQaAlert,
  saveDigestOutput,
  saveDigestQaResult,
} from "../src/digestQa.js";
import { loadCronState, saveCronState } from "../src/cronJobs.js";

function setupDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "digest-qa-"));
  mkdirSync(join(dir, ".agent"), { recursive: true });
  writeFileSync(
    join(dir, "agent.config.json"),
    JSON.stringify({ stateDir: ".agent", cwd: dir }),
    "utf8"
  );
  writeFileSync(
    join(dir, ".agent", "cron.jobs.json"),
    JSON.stringify({
      version: 1,
      jobs: [
        {
          id: DEFAULT_DIGEST_JOB_ID,
          cron: "59 23 * * *",
          topicDelegates: true,
          topicPromptFile: "deploy/prompts/tparser-daily-topic.prompt.txt",
          synthesizePromptFile: "deploy/prompts/tparser-daily-synthesize.prompt.txt",
        },
      ],
    }),
    "utf8"
  );
  return dir;
}

test("evaluateDigestQa passes with healthy lastResult and digest body", () => {
  const dir = setupDir();
  const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  saveCronState(dir, {
    version: 1,
    lastRun: { [DEFAULT_DIGEST_JOB_ID]: "2026-05-29 23:59" },
    lastResult: {
      [DEFAULT_DIGEST_JOB_ID]: {
        at,
        ok: true,
        durationMs: 600_000,
        message: "finished",
        topicOk: 5,
        topicTotal: 5,
        topics: [
          { id: "ai-ml", title: "AI / ML / LLM", ok: true },
          { id: "infosec", title: "InfoSec", ok: true },
        ],
      },
    },
  });
  saveDigestOutput(
    dir,
    DEFAULT_DIGEST_JOB_ID,
    [
      "📬 TParser · день",
      "## AI / ML / LLM",
      "Вердикт агента: ok",
      "https://t.me/example/1",
      "## AISec / MLSec",
      "https://t.me/example/2",
      "## InfoSec / AppSec",
      "https://t.me/example/3",
    ].join("\n")
  );
  const report = evaluateDigestQa(dir, DEFAULT_DIGEST_JOB_ID);
  assert.equal(report.ok, true);
  assert.ok(report.checks.some((c) => c.name === "tg links" && c.ok));
});

test("evaluateDigestQa fails when lastResult missing", () => {
  const dir = setupDir();
  const report = evaluateDigestQa(dir, DEFAULT_DIGEST_JOB_ID);
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((c) => c.name === "last run" && !c.ok));
  assert.match(
    report.checks.find((c) => c.name === "last run")!.detail,
    /never ran/
  );
});

test("digestNeverRan is true without lastRun entry", () => {
  const dir = setupDir();
  assert.equal(digestNeverRan(dir, DEFAULT_DIGEST_JOB_ID), true);
});

test("formatDigestQaAlert lists failed checks only", () => {
  const alert = formatDigestQaAlert({
    jobId: DEFAULT_DIGEST_JOB_ID,
    ok: false,
    checks: [
      { name: "run status", ok: true, detail: "OK" },
      { name: "tg links", ok: false, detail: "0 t.me link(s)" },
    ],
  });
  assert.match(alert, /QA FAIL/);
  assert.match(alert, /tg links/);
  assert.doesNotMatch(alert, /run status/);
});

test("formatDigestQaAlert morning prefix", () => {
  const alert = formatDigestQaAlert(
    {
      jobId: DEFAULT_DIGEST_JOB_ID,
      ok: false,
      checks: [{ name: "freshness", ok: false, detail: "30h ago" }],
    },
    { morning: true }
  );
  assert.match(alert, /morning QA FAIL/);
});

test("saveDigestQaResult patches lastResult", () => {
  const dir = setupDir();
  const at = new Date().toISOString();
  saveCronState(dir, {
    version: 1,
    lastRun: {},
    lastResult: {
      [DEFAULT_DIGEST_JOB_ID]: {
        at,
        ok: true,
        durationMs: 1,
        message: "x",
      },
    },
  });
  saveDigestQaResult(dir, DEFAULT_DIGEST_JOB_ID, {
    jobId: DEFAULT_DIGEST_JOB_ID,
    ok: false,
    checks: [{ name: "tg links", ok: false, detail: "0" }],
  });
  const state = loadCronState(dir);
  assert.equal(state.lastResult?.[DEFAULT_DIGEST_JOB_ID]?.qaOk, false);
  assert.deepEqual(state.lastResult?.[DEFAULT_DIGEST_JOB_ID]?.qaFailedChecks, ["tg links"]);
});

test("evaluateDigestQa accepts empty-day digest", () => {
  const dir = setupDir();
  const at = new Date(Date.now() - 1 * 3_600_000).toISOString();
  saveCronState(dir, {
    version: 1,
    lastRun: {},
    lastResult: {
      [DEFAULT_DIGEST_JOB_ID]: {
        at,
        ok: true,
        durationMs: 120_000,
        message: "empty",
        topicOk: 5,
        topicTotal: 5,
      },
    },
  });
  saveDigestOutput(dir, DEFAULT_DIGEST_JOB_ID, "📬 TParser · день · релевантных постов не было.");
  const report = evaluateDigestQa(dir, DEFAULT_DIGEST_JOB_ID);
  assert.equal(report.ok, true);
});

test("evaluateDigestQa warns but passes when digest 3501-12000 chars", () => {
  const dir = setupDir();
  const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  saveCronState(dir, {
    version: 1,
    lastRun: { [DEFAULT_DIGEST_JOB_ID]: "2026-06-13 23:59" },
    lastResult: {
      [DEFAULT_DIGEST_JOB_ID]: {
        at,
        ok: true,
        durationMs: 600_000,
        message: "finished",
        topicOk: 5,
        topicTotal: 5,
      },
    },
  });
  // Sized off BOTH constants, never a literal: this test hardcoded 3500, then
  // 12000, and each time the numbers moved it silently stopped exercising the
  // warn band it exists to cover. Aim at the midpoint between warn and fail.
  const skeleton = [
    "📬 TParser · день",
    "**TL;DR:** краткий итог дня для Telegram.",
    "## AI / ML / LLM",
    "Вердикт агента: ok",
    "https://t.me/example/1",
    "## AISec / MLSec",
    "https://t.me/example/2",
    "## InfoSec / AppSec",
    "https://t.me/example/3",
    "## Programming / devtools",
    "https://t.me/example/4",
  ].join("\n");
  const want = Math.floor((DIGEST_TG_TARGET_CHARS + DIGEST_QA_MAX_BODY_CHARS) / 2);
  const body = `${skeleton}\n${"x".repeat(want - skeleton.length - 1)}`;
  assert.ok(
    body.length > DIGEST_TG_TARGET_CHARS && body.length <= DIGEST_QA_MAX_BODY_CHARS,
    `body len=${body.length} must sit between warn ${DIGEST_TG_TARGET_CHARS} and fail ${DIGEST_QA_MAX_BODY_CHARS}`
  );
  saveDigestOutput(dir, DEFAULT_DIGEST_JOB_ID, body);
  const report = evaluateDigestQa(dir, DEFAULT_DIGEST_JOB_ID);
  assert.equal(report.ok, true);
  const tgLen = report.checks.find((c) => c.name === "digest tg length");
  assert.ok(tgLen?.warn);
  assert.ok(tgLen?.ok);
  const hardLen = report.checks.find((c) => c.name === "digest length");
  assert.equal(hardLen?.ok, true);
});

test("evaluateDigestQa fails when the digest exceeds the hard body cap", () => {
  const dir = setupDir();
  const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  saveCronState(dir, {
    version: 1,
    lastRun: { [DEFAULT_DIGEST_JOB_ID]: "2026-06-13 23:59" },
    lastResult: {
      [DEFAULT_DIGEST_JOB_ID]: {
        at,
        ok: true,
        durationMs: 600_000,
        message: "finished",
        topicOk: 5,
        topicTotal: 5,
      },
    },
  });
  const line = "📬 TParser · день\nhttps://t.me/x/1\n";
  const body = line.repeat(Math.ceil(DIGEST_QA_MAX_BODY_CHARS / line.length) + 10);
  assert.ok(body.length > DIGEST_QA_MAX_BODY_CHARS);
  saveDigestOutput(dir, DEFAULT_DIGEST_JOB_ID, body);
  const report = evaluateDigestQa(dir, DEFAULT_DIGEST_JOB_ID);
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((c) => c.name === "digest length" && !c.ok));
});
