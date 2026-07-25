/**
 * Optional agent/chat diagnostics. Enable with CSAGENT_LOG=1.
 * Info → stdout, errors → stderr (launchd: gateway.log / gateway.error.log).
 * TUI: stdout writes corrupt Ink rendering — use `logFile` (I-17, tui.log).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "./redact.js";
import { emitServiceLog, inferServiceLogLevel, type ServiceLogLevel } from "./serviceLog.js";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function envTruthy(name: string): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  return TRUTHY.has(v);
}

/** When true, chat/TUI/gateway callers emit timestamped lines to stderr. */
export function agentLogEnabled(): boolean {
  return envTruthy("CSAGENT_LOG") || envTruthy("CSAGENT_DEBUG");
}

/** Per-tool stream lines from chatEngine (very noisy). */
export function agentLogVerbose(): boolean {
  return envTruthy("CSAGENT_LOG_VERBOSE");
}

export interface AgentLoggerOptions {
  /** Prefix tag, e.g. `chat`, `tui`. */
  component?: string;
  /** Extra sink (tests, gateway). Receives redacted line + level. */
  onLog?: (line: string, level?: ServiceLogLevel) => void | Promise<void>;
  /** Append to this file instead of stdout/stderr (TUI must not write to stdout). */
  logFile?: string;
}

/** Build a logger: CSAGENT_LOG → stdout/stderr by level (or logFile); always forwards to onLog. */
export function resolveAgentLogger(opts: AgentLoggerOptions = {}): (line: string) => void {
  const component = opts.component ?? "irida";
  const enabled = agentLogEnabled();
  let fileReady = false;
  return (line: string) => {
    const msg = redact(line);
    const level = inferServiceLogLevel(msg);
    if (enabled) {
      const stamped = `[${component}] ${new Date().toISOString()} ${msg}`;
      if (opts.logFile) {
        try {
          if (!fileReady) {
            mkdirSync(dirname(opts.logFile), { recursive: true });
            fileReady = true;
          }
          appendFileSync(opts.logFile, `${level === "error" ? "ERROR " : ""}${stamped}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
        } catch {
          /* diagnostics must never crash the app */
        }
      } else {
        emitServiceLog(stamped, level);
      }
    }
    try {
      const pending = opts.onLog?.(msg, level);
      if (pending) void pending.catch(() => {});
    } catch {
      /* diagnostics must never crash the app */
    }
  };
}
