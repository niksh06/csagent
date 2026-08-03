/**
 * Autonomous self-monitor (I-121). One periodic sweep asserts the autonomous
 * surfaces are actually alive and surfaces problems the user would otherwise
 * miss — the digest dead 4 days, the account 403 only in error.log. Detection +
 * robust alert only (no remediation). Two NEW detectors (cron freshness for any
 * `critical` job, engine auth/403 streak) + reuse of the existing gateway probes.
 *
 * The cron `self-monitor` builtin runs this, then delivers via the normal cron
 * notify path (direct Telegram + outbox park) — never an agent turn, so the alert
 * does not depend on the engine it reports on. Anti-spam via a small state file:
 * RED alerts on change or every RE_ALERT_HOURS while red; heartbeat once a day so
 * silence means confirmed-healthy.
 */
import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import {
  loadCronJobs,
  loadCronState,
  parseCronMinuteKey,
  type CronJob,
  type CronJobLastResult,
} from "./cronJobs.js";
import { nextCronRun } from "./cronSchedule.js";
import { loadRunLogEntries, countRecentErrorKinds } from "./runMetrics.js";
import { gatherGatewayStatus, gatherGatewayStoreStatusLines } from "./gatewayStatus.js";
import { redact } from "./redact.js";

export interface SelfMonitorCheck {
  name: string;
  ok: boolean;
  detail: string;
}
export interface SelfMonitorReport {
  checks: SelfMonitorCheck[];
  redKeys: string[];
  anyRed: boolean;
}
export interface SelfMonitorState {
  lastRedKeys: string[];
  lastAlertAt?: string;
  lastHeartbeatAt?: string;
}
export type SelfMonitorEmission = { kind: "alert" | "heartbeat"; text: string } | null;

const DEFAULT_MAX_AGE_HOURS = 26;
const ENGINE_STREAK_WINDOW_HOURS = 6;
const ENGINE_STREAK_THRESHOLD = 2;
const ENGINE_STREAK_KINDS = ["auth", "startup"];
const RE_ALERT_HOURS = 6;
const HEARTBEAT_HOURS = 24;
/** Existing gateway-status rows that represent autonomous infra health. */
const INFRA_ROWS = new Set(["launchd gateway", "gateway health", "outbox", "store (postgres)"]);

function hoursSince(iso: string, now: number): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now - t) / 3600_000 : Number.POSITIVE_INFINITY;
}

/** Freshness verdict for one critical job — pure, unit-tested. */
export function cronJobFreshness(
  job: Pick<CronJob, "id" | "maxAgeHours">,
  last: CronJobLastResult | undefined,
  ran: boolean,
  now: number
): SelfMonitorCheck {
  const name = `cron ${job.id}`;
  const max = job.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  if (!last) return { name, ok: false, detail: ran ? "ran but no result recorded" : "never ran" };
  if (!last.ok) return { name, ok: false, detail: `last run FAILED — ${last.message.slice(0, 80)}` };
  const age = hoursSince(last.at, now);
  return { name, ok: age <= max, detail: `${age.toFixed(1)}h ago (max ${max}h)` };
}

/** Freshness of every `critical` cron job (generalizes the digest freshness check). */
export function evaluateCronFreshness(dir: string, now: number): SelfMonitorCheck[] {
  const jobs = loadCronJobs(dir).filter((j) => j.critical && j.enabled !== false);
  if (!jobs.length) return [];
  const state = loadCronState(dir);
  return jobs.map((job) =>
    cronJobFreshness(job, state.lastResult?.[job.id], Boolean(state.lastRun?.[job.id]), now)
  );
}

/** Only watch daily-or-sparser jobs for staleness (skip frequent every-N-min jobs). */
const STALENESS_MIN_CADENCE_HOURS = 12;
/** A job is stale once it has missed ~1.5 cadences without firing. */
const STALENESS_CADENCE_FACTOR = 1.5;

/** A job's cadence in hours from its cron expr (gap between consecutive runs). */
export function cronCadenceHours(cronExpr: string, now: number): number | null {
  const n1 = nextCronRun(cronExpr, new Date(now));
  if (!n1) return null;
  const n2 = nextCronRun(cronExpr, n1);
  if (!n2) return null;
  return (n2.getTime() - n1.getTime()) / 3600_000;
}

/**
 * I-129: a recurring job can stop firing SILENTLY — its slot falls between two
 * cron ticks (host sleep / launchd drift exceeding the grace window), so lastRun
 * never advances and nothing complains. The `critical` freshness check (above)
 * only covers jobs flagged critical. This generalizes it to every enabled,
 * daily-or-sparser job: flag when lastRun is older than ~1.5× its cadence. The
 * threshold scales with the cron, so a weekly job is not falsely flagged at 36h.
 */
export function evaluateRecurringStaleness(dir: string, now: number): SelfMonitorCheck[] {
  const state = loadCronState(dir);
  // `critical` jobs are already covered by evaluateCronFreshness — avoid duplicates.
  const jobs = loadCronJobs(dir).filter((j) => j.enabled !== false && j.cron && !j.critical);
  const checks: SelfMonitorCheck[] = [];
  for (const job of jobs) {
    const cadenceH = cronCadenceHours(job.cron, now);
    if (cadenceH == null || cadenceH < STALENESS_MIN_CADENCE_HOURS) continue;
    const thresholdH = cadenceH * STALENESS_CADENCE_FACTOR;
    const lastRun = parseCronMinuteKey(state.lastRun?.[job.id] ?? "");
    const ageH = lastRun ? (now - lastRun.getTime()) / 3600_000 : Number.POSITIVE_INFINITY;
    if (ageH > thresholdH) {
      const ran = lastRun ? `last ran ${ageH.toFixed(0)}h ago` : "never ran";
      checks.push({
        name: `cron ${job.id}`,
        ok: false,
        detail: `${ran} (daily~${cadenceH.toFixed(0)}h cadence, stale >${thresholdH.toFixed(0)}h) — not firing?`,
      });
    }
  }
  return checks;
}

/** Auth/403/startup error streak in the recent run log (the account rate-cap gap). */
export function evaluateEngineErrorStreak(dir: string, now: number): SelfMonitorCheck {
  const stateDir = loadConfig(dir).stateDir;
  const entries = loadRunLogEntries(dir, stateDir);
  const since = now - ENGINE_STREAK_WINDOW_HOURS * 3600_000;
  const count = countRecentErrorKinds(entries, since, ENGINE_STREAK_KINDS, { prodOnly: true });
  const ok = count < ENGINE_STREAK_THRESHOLD;
  return {
    name: "engine auth/403",
    ok,
    detail: ok
      ? `${count} auth/startup err in ${ENGINE_STREAK_WINDOW_HOURS}h`
      : `${count} auth/startup err in ${ENGINE_STREAK_WINDOW_HOURS}h (≥${ENGINE_STREAK_THRESHOLD} — token expired or subscription rate cap?)`,
  };
}

/**
 * Reuse the existing gateway probes for infra health (store/poll/outbox).
 * Probes are injectable and the function exported for unit tests only.
 */
export async function gatherInfraChecks(
  dir: string,
  probes: {
    status: typeof gatherGatewayStatus;
    store: typeof gatherGatewayStoreStatusLines;
  } = { status: gatherGatewayStatus, store: gatherGatewayStoreStatusLines }
): Promise<SelfMonitorCheck[]> {
  let rows;
  try {
    rows = [...probes.status(dir), ...(await probes.store())];
  } catch (e) {
    // A thrown probe must not read as confirmed-healthy — this module's
    // contract is "silence means healthy", so the failure itself goes red
    // instead of vanishing into an empty check list (Vesper §103).
    return [
      {
        name: "infra probes",
        ok: false,
        detail: `probe threw: ${e instanceof Error ? e.message : String(e)}`,
      },
    ];
  }
  return rows
    .filter((r) => INFRA_ROWS.has(r.name))
    .map((r) => ({ name: r.name, ok: r.ok, detail: r.detail }));
}

export async function runSelfMonitor(dir: string, opts: { now?: number } = {}): Promise<SelfMonitorReport> {
  const now = opts.now ?? Date.now();
  const checks: SelfMonitorCheck[] = [
    ...evaluateCronFreshness(dir, now),
    ...evaluateRecurringStaleness(dir, now),
    evaluateEngineErrorStreak(dir, now),
    ...(await gatherInfraChecks(dir)),
  ];
  const redKeys = checks.filter((c) => !c.ok).map((c) => c.name).sort();
  return { checks, redKeys, anyRed: redKeys.length > 0 };
}

export function formatSelfMonitorAlert(report: SelfMonitorReport): string {
  const red = report.checks.filter((c) => !c.ok);
  const green = report.checks.length - red.length;
  const lines = [
    "🔴 irida self-monitor — внимание:",
    ...red.map((c) => `• ${c.name}: ${redact(c.detail)}`),
    "",
    `(${green}/${report.checks.length} ok)`,
  ];
  return lines.join("\n");
}

export function formatSelfMonitorHeartbeat(report: SelfMonitorReport): string {
  return `✅ irida self-monitor — всё ок (${report.checks.length} проверок: cron freshness, engine, store, gateway).`;
}

/** Anti-spam decision: alert on change / RE_ALERT_HOURS while red; heartbeat once a day. */
export function decideSelfMonitorEmission(
  report: SelfMonitorReport,
  state: SelfMonitorState,
  now: number
): { emission: SelfMonitorEmission; nextState: SelfMonitorState } {
  const next: SelfMonitorState = { ...state, lastRedKeys: report.redKeys };
  if (report.anyRed) {
    const changed = JSON.stringify(report.redKeys) !== JSON.stringify(state.lastRedKeys ?? []);
    const lastAlert = state.lastAlertAt ? Date.parse(state.lastAlertAt) : 0;
    const due = now - lastAlert >= RE_ALERT_HOURS * 3600_000;
    if (changed || due) {
      next.lastAlertAt = new Date(now).toISOString();
      return { emission: { kind: "alert", text: formatSelfMonitorAlert(report) }, nextState: next };
    }
    return { emission: null, nextState: next };
  }
  const lastHb = state.lastHeartbeatAt ? Date.parse(state.lastHeartbeatAt) : 0;
  if (now - lastHb >= HEARTBEAT_HOURS * 3600_000) {
    next.lastHeartbeatAt = new Date(now).toISOString();
    return { emission: { kind: "heartbeat", text: formatSelfMonitorHeartbeat(report) }, nextState: next };
  }
  return { emission: null, nextState: next };
}

function selfMonitorStatePath(dir: string): string {
  return resolve(dir, loadConfig(dir).stateDir, "self-monitor.state.json");
}

export function loadSelfMonitorState(dir: string): SelfMonitorState {
  const p = selfMonitorStatePath(dir);
  if (!existsSync(p)) return { lastRedKeys: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return { lastRedKeys: [], ...parsed };
  } catch {
    return { lastRedKeys: [] };
  }
}

export function saveSelfMonitorState(dir: string, state: SelfMonitorState): void {
  const p = selfMonitorStatePath(dir);
  mkdirSync(resolve(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2));
}
