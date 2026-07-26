/**
 * Resolved irida environment accessors (Arch-4 — the single env read layer).
 *
 * Goal: nothing outside this module (and the DB-specific pg/pool.ts) reads
 * `process.env.CSAGENT_*` directly, so every knob is discoverable in one place
 * and tests have one seam to control. Each accessor trims and normalizes the
 * empty string to `undefined`. This is a leaf module — it imports nothing.
 */

function readTrimmed(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

/**
 * Read `IRIDA_<suffix>`, falling back to the legacy `CSAGENT_<suffix>` (rename
 * shim). New env wins; existing CSAGENT_* deployments keep working until the
 * legacy prefix is dropped in a later release.
 */
export function dualEnv(suffix: string): string | undefined {
  return readTrimmed(`IRIDA_${suffix}`) ?? readTrimmed(`CSAGENT_${suffix}`);
}

/** Prod home dir (e.g. ~/.irida; legacy ~/.csagent), or undefined when unset. */
export function iridaHome(): string | undefined {
  return dualEnv("HOME");
}

/**
 * Install root of the agent (e.g. ~/.csagent/csagent) — the second candidate
 * for resolving skills/prompts/scripts when launched outside the project dir.
 */
export function iridaRoot(): string | undefined {
  return dualEnv("ROOT");
}

/** Override for the project dir MCP child tools resolve memory/cron against. */
export function iridaMemoryDir(): string | undefined {
  return dualEnv("MEMORY_DIR");
}

/** Override for the state dir (.agent) MCP child tools resolve against. */
export function iridaStateDir(): string | undefined {
  return dualEnv("STATE_DIR");
}

/** Knowledge-base root for `memory kb` import/export. */
export function iridaKbRoot(): string | undefined {
  return dualEnv("KB_ROOT");
}

/**
 * Hard override that pauses all background/cron activity (truthy = paused).
 * Wins over the on-disk pause flag, so launchd jobs can be neutered via env
 * even before a deploy carries the file-based toggle. See backgroundPause.ts.
 */
export function backgroundPauseEnv(): string | undefined {
  return dualEnv("PAUSE_BACKGROUND");
}

// --- diagnostics / logging toggles (callers interpret "0"/"1") ---

/** Action transcript logging — enabled unless set to "0". */
export function iridaActionLog(): string | undefined {
  return dualEnv("ACTION_LOG");
}

/** Run logging — enabled unless set to "0". */
export function iridaRunLog(): string | undefined {
  return dualEnv("RUN_LOG");
}

/** Idle-refresh interval in ms ("0" disables); caller parses the number. */
export function iridaAgentIdleMs(): string | undefined {
  return dualEnv("AGENT_IDLE_MS");
}

/** Explicit env-file path, highest precedence in loadIridaEnv. */
export function iridaEnvFile(): string | undefined {
  return dualEnv("ENV");
}

/** Use the alternate TUI screen buffer when "1". */
export function iridaTuiAlt(): string | undefined {
  return dualEnv("TUI_ALT");
}

/** Comma-separated model picker override; caller splits. */
export function iridaModels(): string | undefined {
  return dualEnv("MODELS");
}

/** Escape hatch to allow writes under CSAGENT_HOME/.agent during tests. */
export function iridaAllowProdStateWrite(): string | undefined {
  return dualEnv("ALLOW_PROD_STATE_WRITE");
}

// --- gateway child-process context (passed to MCP tool subprocesses) ---

export function iridaGatewayChatId(): string | undefined {
  return dualEnv("GATEWAY_CHAT_ID");
}

export function iridaGatewayAdapter(): string | undefined {
  return dualEnv("GATEWAY_ADAPTER");
}

// --- browser MCP / chromium launch ---

export function iridaBrowserRoot(): string | undefined {
  return dualEnv("BROWSER_ROOT");
}

export function iridaBrowserProfile(): string | undefined {
  return dualEnv("BROWSER_PROFILE");
}

export function iridaBrowserHeadless(): string | undefined {
  return dualEnv("BROWSER_HEADLESS");
}

export function iridaBrowserNoSandbox(): string | undefined {
  return dualEnv("BROWSER_NO_SANDBOX");
}

export function iridaBrowserInsecureTls(): string | undefined {
  return dualEnv("BROWSER_INSECURE_TLS");
}

export function iridaChromePath(): string | undefined {
  return dualEnv("CHROME_PATH");
}

// --- TParser (day-slice cron builtin) ---

/** Base URL of the local TParser API (default http://127.0.0.1:8002). */
export function iridaTparserUrl(): string | undefined {
  return dualEnv("TPARSER_URL");
}

/** Override for TParser's API_AUTH_TOKEN; normally read from its own `.env`. */
export function iridaTparserToken(): string | undefined {
  return dualEnv("TPARSER_TOKEN");
}
