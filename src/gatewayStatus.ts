/**
 * `irida gateway status` — launchd + log probe (I-18).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { iridaHome } from "./env.js";
import { backgroundPauseState } from "./backgroundPause.js";
import { resolve } from "node:path";
import { loadConfig, resolveDenyDestructive } from "./config.js";
import { gatewayConfigPath, loadGatewayConfig } from "./gatewayConfig.js";
import { resolveAllowedChatIds, hasPlaintextGatewayAllowlist, gatewayAllowlistHasTestIds } from "./gatewayAllowlist.js";
import { pgGatewayAllowlistEnabled } from "./gatewayAllowedPg.js";
import { probePgGatewayAllowlist } from "./gatewayAllowedPg.js";
import { assessTelegramAllowedUpdates, telegramBotToken } from "./gatewayTelegram.js";
import { pgConfigured, probePgReachable } from "./pg/pool.js";
import { assessGatewayServiceHealth, tailLogLines } from "./gatewayLogHealth.js";
import { gatherCronContextDirIssue } from "./cronContextArtifact.js";
import { cronJobsPath, loadCronJobs, loadCronState, validateCronJobsFile } from "./cronJobs.js";
import { formatCronLastResultSummary } from "./cronRunRecord.js";
import { formatRunMetrics, loadRunMetrics } from "./runMetrics.js";
import { runLogEnabled } from "./runLog.js";
import { assessOutboxHealth } from "./gatewayOutbox.js";
import { loadFollowups } from "./gatewayFollowupStore.js";
import { getChatEngine } from "./gatewayEngineStore.js";

export interface GatewayStatusLine {
  name: string;
  ok: boolean;
  detail: string;
}

// Accept both the new ai.irida.* labels and legacy ai.csagent.* (rename shim) so
// status works whether prod has relabeled launchd yet (see deploy/IRIDA-MIGRATION.md).
const GATEWAY_LABELS = ["ai.irida.gateway", "ai.csagent.gateway"];
const CRON_LABELS = ["ai.irida.cron-tick", "ai.csagent.cron-tick"];

function launchdRunning(labels: string[], isCron = false): { ok: boolean; detail: string } {
  try {
    const out = execSync("launchctl list", { encoding: "utf8", timeout: 5000 });
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3 && labels.includes(parts[parts.length - 1]!)) {
        const pid = parts[0];
        const code = parts[1];
        if (pid === "-" || pid === "0") {
          if (isCron && code === "0") {
            return { ok: true, detail: "interval job idle (last exit 0)" };
          }
          return { ok: false, detail: `loaded but not running (last exit ${code})` };
        }
        return { ok: true, detail: `pid ${pid}` };
      }
    }
    return { ok: false, detail: "not loaded in launchctl" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

function readLogTailLines(path: string, lines = 5): string[] {
  if (!existsSync(path)) return [];
  return tailLogLines(readFileSync(path, "utf8"), lines);
}

function logAgeMs(path: string): number {
  return existsSync(path) ? Date.now() - statSync(path).mtimeMs : Number.POSITIVE_INFINITY;
}

export function gatherGatewayStatus(
  dir: string = process.cwd(),
  chat?: { adapter: string; chatId: string }
): GatewayStatusLine[] {
  const rows: GatewayStatusLine[] = [];
  const home = iridaHome() || resolve(dir, "..", "..");
  const logDir = resolve(home, "logs");
  const cronLog = resolve(logDir, "cron-tick.log");

  const gwPath = gatewayConfigPath(dir);
  if (existsSync(gwPath)) {
    try {
      const cfg = loadGatewayConfig(dir);
      const peers = resolveAllowedChatIds(cfg, dir);
      const storage = pgGatewayAllowlistEnabled() ? "postgres" : "gateway.json";
      rows.push({
        name: "gateway config",
        ok: peers.length > 0,
        detail:
          peers.length > 0
            ? `${cfg.adapter} · ${peers.length} peer(s) · allowlist ${storage}`
            : `${cfg.adapter} · allowlist empty (${storage})`,
      });
    } catch (e) {
      rows.push({
        name: "gateway config",
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  } else {
    rows.push({ name: "gateway config", ok: false, detail: "gateway.json missing" });
  }

  const pause = backgroundPauseState(dir);
  rows.push({
    name: "background",
    ok: true,
    detail: pause.paused
      ? `PAUSED — cron runs no jobs (${[pause.source, pause.reason].filter(Boolean).join(": ")})`
      : "active — cron runs due jobs",
  });

  // I-126: deferred follow-ups awaiting their due time (cron-tick fires them).
  try {
    const pending = loadFollowups(dir).followups.length;
    rows.push({
      name: "follow-ups",
      ok: true,
      detail: pending > 0 ? `${pending} pending (deferred self-resume)` : "none scheduled",
    });
  } catch {
    // non-fatal — status should never break on the follow-up store
  }

  const gwLaunch = launchdRunning(GATEWAY_LABELS);
  rows.push({ name: "launchd gateway", ok: gwLaunch.ok, detail: gwLaunch.detail });

  const cronLaunch = launchdRunning(CRON_LABELS, true);
  rows.push({ name: "launchd cron-tick", ok: cronLaunch.ok, detail: cronLaunch.detail });

  const infoLog = resolve(logDir, "gateway.log");
  const errLog = resolve(logDir, "gateway.error.log");
  if (existsSync(infoLog) || existsSync(errLog)) {
    const health = assessGatewayServiceHealth({
      infoLines: readLogTailLines(infoLog, 8),
      errorLines: readLogTailLines(errLog, 5),
      infoAgeMs: logAgeMs(infoLog),
      errorAgeMs: logAgeMs(errLog),
      gatewayRunning: gwLaunch.ok,
    });
    rows.push({
      name: "gateway health",
      ok: health.ok,
      detail: health.hint ? `${health.detail} → ${health.hint}` : health.detail,
    });
  } else {
    rows.push({
      name: "gateway health",
      ok: false,
      detail: `no logs in ${logDir} (expected gateway.log)`,
    });
  }

  if (existsSync(cronLog)) {
    const tail = readLogTailLines(cronLog, 2).join(" | ") || "(empty)";
    rows.push({ name: "cron log", ok: true, detail: tail.slice(0, 160) });
  }

  const cronPath = cronJobsPath(dir);
  if (!existsSync(cronPath)) {
    rows.push({ name: "cron jobs", ok: false, detail: "cron.jobs.json missing" });
  } else {
    const cronErrs = validateCronJobsFile(dir);
    if (cronErrs.length) {
      rows.push({ name: "cron jobs", ok: false, detail: cronErrs.join("; ") });
    } else {
      const count = loadCronJobs(dir).length;
      rows.push({
        name: "cron jobs",
        ok: true,
        detail: count ? `${count} job(s) · valid` : "empty · valid",
      });
    }
  }

  const ctxIssue = gatherCronContextDirIssue(dir);
  if (ctxIssue) {
    rows.push({ name: "cron context dir", ok: false, detail: ctxIssue });
  }

  const outbox = assessOutboxHealth(dir);
  rows.push({ name: "outbox", ok: outbox.ok, detail: outbox.detail });

  const cfg = loadConfig(dir);
  // The chat's EFFECTIVE engine, not the config default: a sticky /engine
  // choice silently outlives its session, and /status claiming the config
  // engine while the chat runs another is exactly how a dead upstream looked
  // like «irida сломалась» (12.08: sticky codex + exhausted Codex limit).
  const sticky = chat ? getChatEngine(dir, chat.adapter, chat.chatId) : null;
  const provider = sticky ?? cfg.engine.provider;
  const stickyMark = sticky ? " · sticky для чата (/engine off — вернуть конфиг)" : "";
  const engineDetail =
    provider === "claude-agent"
      ? `claude-agent (auth=${cfg.engine.auth ?? "api-key"}, model=${cfg.engine.model ?? "claude-opus-4-8"})`
      : provider === "codex"
        ? `codex (auth=${cfg.engine.auth ?? "account"})`
        : `cursor (model=${cfg.model})`;
  rows.push({
    name: "engine",
    ok: true,
    detail: engineDetail + stickyMark,
  });
  if (provider === "claude-agent") {
    // Informational (I-94): reflect the runtime tool-deny gate for the gateway
    // surface. Not a WARN — the gate is opt-in by design.
    const gateOn = resolveDenyDestructive(cfg.engine, "telegram");
    rows.push({
      name: "tool-policy",
      ok: true,
      detail: `deny-destructive ${gateOn ? "on" : "off"} (telegram)`,
    });
  }
  try {
    if (!runLogEnabled()) {
      rows.push({ name: "runs 24h", ok: true, detail: "run log disabled (IRIDA_RUN_LOG=0) — metrics unavailable" });
    } else {
      const metrics = loadRunMetrics(dir, cfg.stateDir, 24, { prodOnly: true });
      // On the account (subscription) engine the $ is what it WOULD cost metered —
      // the subscription doesn't pay it. Flag that so the estimate isn't misread.
      const acct =
        cfg.engine.provider === "claude-agent" &&
        (cfg.engine.auth ?? "api-key") === "account" &&
        metrics.costUsd != null;
      rows.push({
        name: "runs 24h",
        ok: true,
        detail: formatRunMetrics(metrics, 24, { prodOnly: true }) + (acct ? " · subscription (no metered charge)" : ""),
      });
    }
  } catch {
    // metrics are best-effort
  }

  try {
    const state = loadCronState(dir);
    const jobs = loadCronJobs(dir).filter((j) => j.topicDelegates);
    for (const job of jobs) {
      const last = state.lastResult?.[job.id];
      if (!last) {
        rows.push({ name: `cron ${job.id}`, ok: false, detail: "no runs recorded yet" });
        continue;
      }
      rows.push({
        name: `cron ${job.id}`,
        ok: last.ok,
        detail: formatCronLastResultSummary(job.id, last),
      });
    }
  } catch {
    // cron config optional for status
  }

  return rows;
}

/**
 * Postgres store reachability for `gateway status` (postmortem 2026-06-18 PG
 * down). Without this the status stays green while every turn fails because the
 * store is unreachable. No-op line when running on SQLite.
 */
export async function gatherGatewayStoreStatusLines(): Promise<GatewayStatusLine[]> {
  if (!pgConfigured()) return [];
  const probe = await probePgReachable();
  return [
    {
      name: "store (postgres)",
      ok: probe.ok,
      detail: probe.ok ? probe.detail : `${probe.detail} → start Docker/OrbStack (irida postgres :5435)`,
    },
  ];
}

/** Live Telegram Bot API probe for gateway status /status (I-83). */
export async function gatherTelegramGatewayStatusLines(
  dir: string = process.cwd()
): Promise<GatewayStatusLine[]> {
  const gwPath = gatewayConfigPath(dir);
  if (!existsSync(gwPath)) return [];
  let cfg;
  try {
    cfg = loadGatewayConfig(dir);
  } catch {
    return [];
  }
  if (cfg.adapter !== "telegram") return [];
  let token: string;
  try {
    token = telegramBotToken(cfg, dir);
  } catch {
    return [];
  }
  if (!token) return [];
  const assessment = await assessTelegramAllowedUpdates(token);
  return [
    {
      name: "telegram allowed_updates",
      ok: assessment.ok,
      detail: assessment.ok ? `includes message (${assessment.detail})` : assessment.detail,
    },
  ];
}
