import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherCronPromptDrift } from "../src/cronPromptDrift.js";
import { writeExampleCronJobs } from "../src/cron_cmd.js";

test("gatherCronPromptDrift warns on inline digest prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "drift-"));
  writeExampleCronJobs(dir, [
    { id: "tparser-bi-hourly-digest", cron: "0 */2 * * *", prompt: "x".repeat(500) },
  ]);
  const r = gatherCronPromptDrift(dir);
  assert.equal(r.ok, false);
  assert.match(r.warnings[0] ?? "", /inline prompt/);
});

test("gatherCronPromptDrift skips builtin and script jobs", () => {
  const dir = mkdtempSync(join(tmpdir(), "drift-bs-"));
  writeExampleCronJobs(dir, [
    { id: "tparser-digest-feed", cron: "0 */2 * * *", builtin: "tparser-digest-feed" },
    { id: "aleph-alerts-digest", cron: "0 9 * * *", script: "scripts/alerts.sh" },
  ]);
  const r = gatherCronPromptDrift(dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
});

test("gatherCronPromptDrift detects hash drift vs deploy", () => {
  const dir = mkdtempSync(join(tmpdir(), "drift2-"));
  const deploy = join(dir, "deploy", "prompts");
  mkdirSync(deploy, { recursive: true });
  writeFileSync(join(deploy, "job.txt"), "canonical\n");
  const runtime = join(dir, "runtime");
  mkdirSync(runtime);
  writeFileSync(join(runtime, "job.txt"), "changed\n");
  process.env.CSAGENT_ROOT = dir;
  writeExampleCronJobs(dir, [
    { id: "j", cron: "0 9 * * *", promptFile: "runtime/job.txt", cwd: dir },
  ]);
  const r = gatherCronPromptDrift(dir);
  assert.equal(r.ok, false);
  assert.match(r.warnings.join(" "), /drift/);
  delete process.env.CSAGENT_ROOT;
});

test("gatherCronPromptDrift ok when runtime matches deploy", () => {
  const dir = mkdtempSync(join(tmpdir(), "drift3-"));
  const deploy = join(dir, "deploy", "prompts");
  mkdirSync(deploy, { recursive: true });
  writeFileSync(join(deploy, "job.txt"), "same\n");
  process.env.CSAGENT_ROOT = dir;
  writeExampleCronJobs(dir, [
    { id: "j", cron: "0 9 * * *", promptFile: "deploy/prompts/job.txt" },
  ]);
  const r = gatherCronPromptDrift(dir);
  assert.equal(r.ok, true);
  delete process.env.CSAGENT_ROOT;
});
