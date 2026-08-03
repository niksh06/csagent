import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cronJobFreshness,
  decideSelfMonitorEmission,
  formatSelfMonitorAlert,
  formatSelfMonitorHeartbeat,
  type SelfMonitorReport,
} from "../src/selfMonitor.js";
import { countRecentErrorKinds } from "../src/runMetrics.js";
import type { CronJobLastResult } from "../src/cronJobs.js";
import type { RunLogEntry } from "../src/runLog.js";

const NOW = Date.parse("2026-06-21T12:00:00Z");
const hAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const ok = (atIso: string): CronJobLastResult => ({ at: atIso, ok: true, durationMs: 1000, message: "ok" });

describe("cronJobFreshness", () => {
  it("fresh critical job → ok", () => {
    const r = cronJobFreshness({ id: "digest" }, ok(hAgo(2)), true, NOW);
    assert.equal(r.ok, true);
  });
  it("stale beyond maxAgeHours → red", () => {
    const r = cronJobFreshness({ id: "digest", maxAgeHours: 26 }, ok(hAgo(104)), true, NOW);
    assert.equal(r.ok, false);
    assert.match(r.detail, /104\.0h ago/);
  });
  it("last run failed → red even if recent", () => {
    const last: CronJobLastResult = { at: hAgo(1), ok: false, durationMs: 1, message: "synthesize exited 70" };
    const r = cronJobFreshness({ id: "digest" }, last, true, NOW);
    assert.equal(r.ok, false);
    assert.match(r.detail, /FAILED/);
  });
  it("never ran → red", () => {
    assert.equal(cronJobFreshness({ id: "x" }, undefined, false, NOW).ok, false);
    assert.match(cronJobFreshness({ id: "x" }, undefined, false, NOW).detail, /never ran/);
  });
});

describe("countRecentErrorKinds (engine streak)", () => {
  const mk = (h: number, kind: string | null, isTest = false): RunLogEntry =>
    ({ ts: hAgo(h), status: kind ? "error" : "finished", error_kind: kind, is_test: isTest }) as RunLogEntry;
  it("counts auth/startup in the window, ignores others + injected + test", () => {
    const entries = [
      mk(1, "auth"),
      mk(2, "startup"),
      mk(3, "sdk"), // other kind — ignored
      mk(10, "auth"), // outside 6h window
      mk(1, "auth", true), // is_test — ignored by prodOnly
      { ts: hAgo(1), status: "injected", error_kind: "auth" } as RunLogEntry, // injected — ignored
    ];
    const since = NOW - 6 * 3600_000;
    assert.equal(countRecentErrorKinds(entries, since, ["auth", "startup"], { prodOnly: true }), 2);
  });
});

const report = (checks: SelfMonitorReport["checks"]): SelfMonitorReport => {
  const redKeys = checks.filter((c) => !c.ok).map((c) => c.name).sort();
  return { checks, redKeys, anyRed: redKeys.length > 0 };
};
const RED = report([
  { name: "cron digest", ok: false, detail: "104h ago" },
  { name: "engine auth/403", ok: true, detail: "0 err" },
]);
const GREEN = report([{ name: "cron digest", ok: true, detail: "2h ago" }]);

describe("decideSelfMonitorEmission (anti-spam)", () => {
  it("new red → alert + records lastAlertAt/redKeys", () => {
    const { emission, nextState } = decideSelfMonitorEmission(RED, { lastRedKeys: [] }, NOW);
    assert.equal(emission?.kind, "alert");
    assert.deepEqual(nextState.lastRedKeys, ["cron digest"]);
    assert.ok(nextState.lastAlertAt);
  });
  it("same red within RE_ALERT window → deduped (no emit)", () => {
    const state = { lastRedKeys: ["cron digest"], lastAlertAt: hAgo(1) };
    assert.equal(decideSelfMonitorEmission(RED, state, NOW).emission, null);
  });
  it("same red after RE_ALERT window → re-alert", () => {
    const state = { lastRedKeys: ["cron digest"], lastAlertAt: hAgo(7) };
    assert.equal(decideSelfMonitorEmission(RED, state, NOW).emission?.kind, "alert");
  });
  it("green with no recent heartbeat → heartbeat", () => {
    const { emission, nextState } = decideSelfMonitorEmission(GREEN, { lastRedKeys: [] }, NOW);
    assert.equal(emission?.kind, "heartbeat");
    assert.ok(nextState.lastHeartbeatAt);
  });
  it("green with a recent heartbeat → no emit", () => {
    const state = { lastRedKeys: [], lastHeartbeatAt: hAgo(2) };
    assert.equal(decideSelfMonitorEmission(GREEN, state, NOW).emission, null);
  });
  it("recovered (red→green) clears lastRedKeys", () => {
    const state = { lastRedKeys: ["cron digest"], lastHeartbeatAt: hAgo(2) };
    assert.deepEqual(decideSelfMonitorEmission(GREEN, state, NOW).nextState.lastRedKeys, []);
  });
});

describe("formatters", () => {
  it("alert lists red checks + ok count", () => {
    const t = formatSelfMonitorAlert(RED);
    assert.match(t, /cron digest/);
    assert.match(t, /1\/2 ok/);
  });
  it("heartbeat is a single green line", () => {
    assert.match(formatSelfMonitorHeartbeat(GREEN), /✅/);
  });
});

describe("gatherInfraChecks (a thrown probe is red, not silence — Vesper §103)", () => {
  it("returns one red row when a probe throws instead of an empty list", async () => {
    const { gatherInfraChecks } = await import("../src/selfMonitor.js");
    const rows = await gatherInfraChecks("/nonexistent", {
      status: () => {
        throw new Error("pg exploded");
      },
      store: async () => [],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ok, false);
    assert.match(rows[0].detail, /pg exploded/);
  });
});
