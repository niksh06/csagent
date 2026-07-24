/**
 * Project-local config (issue 003/004): ./agent.config.json + defaults.
 * Secrets NEVER live here — CURSOR_API_KEY comes from the environment.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { iridaHome } from "./env.js";

export const CONFIG_FILE = "agent.config.json";

export interface SafetyConfig {
  allowCloud: boolean;
  allowAutoPr: boolean;
}

/** Local embedding provider for semantic memory search (I-36). */
export interface EmbeddingsConfig {
  /** Compute embeddings on note save + enable semantic search (default false). */
  enabled?: boolean;
  /** Base URL (Ollama default http://127.0.0.1:11434; embed-service e.g. http://127.0.0.1:8014). */
  url?: string;
  /** Embedding model name (default nomic-embed-text; informational for embed-service). */
  model?: string;
  /**
   * API shape (I-131). "ollama": POST /api/embeddings {model,prompt} → {embedding}.
   * "embed-service": POST /embed {text} → {vector} — a dedicated sentence-transformers
   * microservice (768-dim multilingual), decoupled from the write path. Default "ollama".
   */
  provider?: "ollama" | "embed-service";
}

/** Silent memory retrieval before each turn (Wave B auto-RAG). */
export interface AutoRagConfig {
  /** When true, search memory for the user message and prepend top hits. */
  enabled?: boolean;
  /** Max notes to inject (default 3, max 10). */
  limit?: number;
  /** Prefer semantic search when embeddings are enabled (FTS fallback). */
  semantic?: boolean;
  /** Total chars cap for injected note bodies (default 12 KiB). */
  maxChars?: number;
  /** Restrict to these wings (default: all except secure). */
  wings?: string[];
}

/** Built-in turn context: profile excerpt + mode env fallback (I-52). */
export interface PreTurnConfig {
  /** Memory note name for profile excerpt (e.g. user-profile.niksh). */
  profileNote?: string;
  /** Max chars for profile excerpt (default 1500). */
  profileMaxChars?: number;
  /** Env var for mode when message has no ADVICE:/DO: prefix (default CSAGENT_MODE). */
  modeEnv?: string;
}

/** Optional hook script (I-47). */
export interface HookScriptConfig {
  command: string;
  timeoutMs?: number;
}

export interface HooksConfig {
  preTurn?: HookScriptConfig;
  postTurn?: HookScriptConfig;
}

export interface SkillPolicyConfig {
  allowUnsafe?: string[];
}

/** Hybrid FTS + vector search tuning (I-72). */
export interface MemorySearchConfig {
  hybridWeights?: { fts?: number; vector?: number };
}

/** Durable memory injected before the first turn of each chat session (issue 036). */
export interface MemoryConfig {
  /** Optional: inject named notes on first turn only (prefer MCP tools). */
  onStart?: string[];
  /** Total chars cap for onStart injection (default 32 KiB). */
  maxCharsPerTurn?: number;
  /** Attach csagent-memory MCP tools (default true). Set false to disable. */
  mcp?: boolean;
  /** Local embeddings for semantic search (Postgres + pgvector only). */
  embeddings?: EmbeddingsConfig;
  /** Silent memory_search before each turn — inject top matching notes. */
  autoRag?: AutoRagConfig;
  /** Mode prefix + profile excerpt before each turn (I-52). */
  preTurn?: PreTurnConfig;
  /** Wings omitted from FTS/semantic search unless includeArchive/includeEpisodic (default: cursor-ide, secure, episodic). */
  searchExcludeWings?: string[];
  /** Wings skipped by embed-on-save and reindex-embeddings (default: cursor-ide, secure). */
  embedExcludeWings?: string[];
  /** Hybrid search weights and related options (Postgres + embeddings). */
  search?: MemorySearchConfig;
  /** Annotate recalled notes older than this many days with a re-verify caution (I-115; default 7, 0 disables). */
  stalenessDays?: number;
}

/** Stealth browser MCP (puppeteer-extra + persistent Chromium profile). */
export interface BrowserConfig {
  /** Attach irida-browser MCP tools (default false). Set true to enable. */
  mcp?: boolean;
  /** Chromium user-data profile name under `<state>/browser/` (default `default`). */
  profile?: string;
  /** Headless mode for agent runs (default true). Set false for manual login flows. */
  headless?: boolean;
  /** Optional custom User-Agent string. */
  userAgent?: string;
  /** Optional Chrome/Chromium executable path (or CSAGENT_CHROME_PATH env). */
  chromePath?: string;
}

/** Engine selection (Irida / I-100): which agent runtime executes the work. */
export type EngineProvider = "cursor" | "claude-agent";

/**
 * Auth mode for the claude-agent engine:
 *  - "api-key": Anthropic API key (ANTHROPIC_API_KEY) — Console billing.
 *  - "account": Claude subscription via OAuth (CLAUDE_CODE_OAUTH_TOKEN from
 *    `claude setup-token`, or an existing `claude login` session in ~/.claude).
 * Ignored for the cursor engine.
 */
export type EngineAuth = "api-key" | "account";

/**
 * Runtime tool-permission policy for the claude-agent engine (I-94). OFF by
 * default — when unset/false the engine keeps its prior `bypassPermissions`
 * behavior (no gate). When on, destructive tool inputs (rm -rf, drop table, …)
 * the agent chooses at runtime are denied via the SDK `canUseTool` callback.
 * Per-surface so autonomous surfaces (gateway/cron) can be strict while the
 * interactive TUI stays relaxed.
 */
export interface ToolPolicyConfig {
  /** Deny destructive tool inputs at runtime. Default false. */
  denyDestructive?: boolean;
  /** Per-surface override of denyDestructive, keyed by SessionChannel (e.g. "telegram", "cron", "tui"). */
  bySurface?: Record<string, boolean>;
  /**
   * I-117: rewrite borderline inputs to a safer form (rm→rm -i, strip --no-verify)
   * instead of allowing verbatim. Default false. Only acts on surfaces where the
   * deny gate is on (it runs inside the same canUseTool). (git push --force stays
   * hard-denied; --force-with-lease is allowed directly.)
   */
  sanitizeInput?: boolean;
}

export interface EvolutionConfig {
  /**
   * Opt-in: let the evolution loop auto-apply agent-drafted skills that clear the
   * fitness gate (I-98 L1). Default false — skills are queued for human approval.
   * Only honored on the claude-agent engine (read-only eval enforcement).
   */
  autoApplySkills?: boolean;
}

export interface EngineConfig {
  /** Active runtime: Cursor SDK (default) or Anthropic Claude Agent SDK. */
  provider: EngineProvider;
  /** claude-agent auth mode (default "api-key"). */
  auth?: EngineAuth;
  /** Optional model override for the claude-agent engine (default claude-opus-4-8). */
  model?: string;
  /** Runtime tool-permission policy for the claude-agent engine (I-94). */
  toolPolicy?: ToolPolicyConfig;
  /** Managed-evolution autonomy switches (I-98). */
  evolution?: EvolutionConfig;
}

/**
 * Effective deny-destructive policy for a surface (I-94). A `bySurface` entry for
 * the channel wins; else the top-level `denyDestructive`; else false. Cursor
 * engine ignores this (gate lives in the Agent SDK).
 */
export function resolveDenyDestructive(engine: EngineConfig, channel?: string): boolean {
  const p = engine.toolPolicy;
  if (!p) return false;
  if (channel && p.bySurface && Object.prototype.hasOwnProperty.call(p.bySurface, channel)) {
    return Boolean(p.bySurface[channel]);
  }
  return Boolean(p.denyDestructive);
}

/** Effective input-sanitizer policy (I-117). Global opt-in; only acts where the deny gate runs. */
export function resolveSanitizeInput(engine: EngineConfig): boolean {
  return Boolean(engine.toolPolicy?.sanitizeInput);
}

/** Default model for the claude-agent engine when none is configured. */
export const DEFAULT_CLAUDE_AGENT_MODEL = "claude-opus-4-8";

/** Wisp pet snapshot bus (.agent/pet-state.json) — on unless disabled. */
export interface PetConfig {
  enabled?: boolean;
  theme?: "light" | "dark";
}

/** homebase MCP: deterministic git-derived continuity + situational-awareness (I-159). */
export interface HomebaseConfig {
  /** Attach csagent-homebase MCP tools (default true). Set false to disable. */
  mcp?: boolean;
  /** Commits shown as baseline context on a repo's first-ever visit (default 10). */
  baselineCommits?: number;
}

export interface AgentConfig {
  model: string;
  runtime: "local" | "cloud";
  engine: EngineConfig;
  cwd: string;
  skillsPath: string;
  stateDir: string;
  mcpServers: Record<string, unknown>;
  safety: SafetyConfig;
  memory: MemoryConfig;
  browser: BrowserConfig;
  hooks?: HooksConfig;
  skillPolicy?: SkillPolicyConfig;
  pet?: PetConfig;
  homebase?: HomebaseConfig;
}

export class ConfigError extends Error {}

/** Validate MCP server entries (stdio: command, http: url). Returns error strings. */
export function validateMcpServers(mcp: Record<string, unknown>): string[] {
  const errs: string[] = [];
  for (const [name, v] of Object.entries(mcp)) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      errs.push(`mcp '${name}': must be an object`);
      continue;
    }
    const o = v as Record<string, unknown>;
    const hasCmd = typeof o.command === "string" && o.command.trim().length > 0;
    const hasUrl = typeof o.url === "string" && o.url.trim().length > 0;
    if (!hasCmd && !hasUrl) {
      errs.push(`mcp '${name}': needs 'command' (stdio) or 'url' (http)`);
    }
  }
  return errs;
}

const SECRET_KEYS = ["CURSOR_API_KEY", "cursorApiKey", "apiKey", "api_key"];

/** Runtime home (~/.csagent): credentials, gateway, sqlite, memory. Defined in
 * the env leaf (Arch-4); re-exported for existing `from "./config.js"` imports. */
export { iridaHome };

export function defaultStateDir(_dir: string): string {
  const home = iridaHome();
  if (home) return resolve(home, ".agent");
  return ".agent";
}

/** Canonical `.agent` directory for memory, credentials, cron state. */
export function resolveMemoryRoot(projectDir: string = process.cwd()): string {
  const home = iridaHome();
  if (home) return resolve(home, ".agent");
  const cfg = loadConfig(projectDir);
  const stateDir = cfg.stateDir;
  if (stateDir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(stateDir)) return stateDir;
  return resolve(projectDir, stateDir);
}

/** Apply CLI `--engine` / `--auth` overrides onto a loaded config (I-100). Throws ConfigError on bad values. */
export function applyEngineOverride(cfg: AgentConfig, provider?: string, auth?: string): AgentConfig {
  if (!provider && !auth) return cfg;
  const engine: EngineConfig = { ...cfg.engine };
  if (provider) {
    if (provider !== "cursor" && provider !== "claude-agent") {
      throw new ConfigError(`--engine must be 'cursor' or 'claude-agent' (got '${provider}')`);
    }
    engine.provider = provider;
  }
  if (auth) {
    if (auth !== "api-key" && auth !== "account") {
      throw new ConfigError(`--auth must be 'api-key' or 'account' (got '${auth}')`);
    }
    engine.auth = auth;
  }
  return { ...cfg, engine };
}

export function defaults(dir: string): AgentConfig {
  return {
    model: "composer-2.5",
    runtime: "local",
    engine: { provider: "cursor" },
    cwd: dir,
    skillsPath: "skills",
    stateDir: defaultStateDir(dir),
    mcpServers: {},
    safety: { allowCloud: false, allowAutoPr: false },
    memory: {},
    browser: {},
  };
}

/**
 * Directory to read `agent.config.json` from. Mirrors resolveMemoryRoot's home
 * preference (Arch-4): `.agent` is already home-anchored, but the config file was
 * read from the literal launch dir — so the gateway (cwd `~/.irida`) and cron-tick
 * (cwd `~/.irida/irida`) loaded two configs that silently diverged (the I-129/I-131
 * two-config footgun: `memory.embeddings`/`preTurn` had to be set in both).
 *
 * Precedence: a dir that carries its OWN config wins (explicit `--dir` runs, tests,
 * and a deliberate per-install override) → else fall back to `IRIDA_HOME`'s config
 * → else the dir itself (defaults). Only the file LOCATION moves home; cwd/skills/
 * stateDir stay anchored to `dir` via defaults(dir)/validate(_, dir).
 */
function resolveConfigDir(dir: string): string {
  if (existsSync(resolve(dir, CONFIG_FILE))) return dir;
  const home = iridaHome();
  if (home && existsSync(resolve(home, CONFIG_FILE))) return home;
  return dir;
}

export function loadConfig(dir: string = process.cwd()): AgentConfig {
  const path = resolve(resolveConfigDir(dir), CONFIG_FILE);
  if (!existsSync(path)) return defaults(dir);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`cannot read ${CONFIG_FILE}: ${(e as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`invalid JSON in ${CONFIG_FILE}: ${(e as Error).message}`);
  }
  return validate(parsed, dir);
}

/** Trimmed, empty-dropped string list (matches the old `.map(trim).filter(Boolean)`). */
const trimmedStringArray = z.array(z.string()).transform((a) => a.map((s) => s.trim()).filter(Boolean));
/** Non-empty after trim; stored trimmed. */
const nonEmptyString = z.string().trim().min(1);

const safetySchema = z
  .object({ allowCloud: z.unknown().optional(), allowAutoPr: z.unknown().optional() })
  // Lenient by design: anything other than literal `true` reads as false (no error).
  .transform((s) => ({ allowCloud: s.allowCloud === true, allowAutoPr: s.allowAutoPr === true }));

const embeddingsSchema = z.object({
  enabled: z.boolean().optional(),
  url: nonEmptyString.optional(),
  model: nonEmptyString.optional(),
  provider: z.enum(["ollama", "embed-service"]).optional(),
});

const autoRagSchema = z.object({
  enabled: z.boolean().optional(),
  limit: z.number().min(1).optional(),
  semantic: z.boolean().optional(),
  maxChars: z.number().min(512).optional(),
  wings: trimmedStringArray.optional(),
});

const memorySearchSchema = z.object({
  hybridWeights: z
    .object({ fts: z.number().gt(0).optional(), vector: z.number().gt(0).optional() })
    .optional(),
});

const preTurnSchema = z.object({
  profileNote: nonEmptyString.optional(),
  profileMaxChars: z.number().min(256).optional(),
  modeEnv: nonEmptyString.optional(),
});

const memorySchema = z.object({
  onStart: trimmedStringArray.optional(),
  maxCharsPerTurn: z.number().min(256).optional(),
  mcp: z.boolean().optional(),
  embeddings: embeddingsSchema.optional(),
  autoRag: autoRagSchema.optional(),
  search: memorySearchSchema.optional(),
  preTurn: preTurnSchema.optional(),
  searchExcludeWings: trimmedStringArray.optional(),
  embedExcludeWings: trimmedStringArray.optional(),
  stalenessDays: z.number().min(0).optional(),
});

const browserSchema = z.object({
  mcp: z.boolean().optional(),
  profile: nonEmptyString.optional(),
  headless: z.boolean().optional(),
  userAgent: nonEmptyString.optional(),
  chromePath: nonEmptyString.optional(),
});

const hookScriptSchema = z.object({
  command: nonEmptyString,
  timeoutMs: z.number().min(100).optional(),
});

const hooksSchema = z.object({
  preTurn: hookScriptSchema.optional(),
  postTurn: hookScriptSchema.optional(),
});

const skillPolicySchema = z.object({ allowUnsafe: trimmedStringArray.optional() });

const toolPolicySchema = z.object({
  denyDestructive: z.boolean().optional(),
  bySurface: z.record(z.string(), z.boolean()).optional(),
  sanitizeInput: z.boolean().optional(),
});

const evolutionSchema = z.object({
  autoApplySkills: z.boolean().optional(),
});

const engineSchema = z.object({
  provider: z.enum(["cursor", "claude-agent"]).optional(),
  auth: z.enum(["api-key", "account"]).optional(),
  model: nonEmptyString.optional(),
  toolPolicy: toolPolicySchema.optional(),
  evolution: evolutionSchema.optional(),
});

const petSchema = z.object({
  enabled: z.boolean().optional(),
  theme: z.enum(["light", "dark"]).optional(),
});

const homebaseSchema = z.object({
  mcp: z.boolean().optional(),
  baselineCommits: z.number().min(1).max(100).optional(),
});

const agentConfigSchema = z.object({
  model: z.string().refine((s) => s.trim().length > 0, "must be a non-empty string").optional(),
  runtime: z.enum(["local", "cloud"]).optional(),
  engine: engineSchema.optional(),
  skillsPath: z.string().optional(),
  stateDir: z.string().optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  safety: safetySchema.optional(),
  memory: memorySchema.optional(),
  browser: browserSchema.optional(),
  hooks: hooksSchema.optional(),
  skillPolicy: skillPolicySchema.optional(),
  pet: petSchema.optional(),
  homebase: homebaseSchema.optional(),
});

function formatZodIssue(e: z.ZodError): string {
  const issue = e.issues[0];
  if (!issue) return "invalid config";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

function validate(obj: unknown, dir: string): AgentConfig {
  // Secrets are unknown keys zod would silently strip — reject them up front.
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const k of SECRET_KEYS) {
      if (k in obj) {
        throw new ConfigError(
          `secrets must not live in ${CONFIG_FILE}; set CURSOR_API_KEY in the environment`
        );
      }
    }
  }

  let parsed: z.infer<typeof agentConfigSchema>;
  try {
    parsed = agentConfigSchema.parse(obj);
  } catch (e) {
    if (e instanceof z.ZodError) throw new ConfigError(`${CONFIG_FILE}: ${formatZodIssue(e)}`);
    throw e;
  }

  // Merge provided keys onto defaults; unspecified keys keep their default.
  const cfg = defaults(dir);
  if (parsed.model !== undefined) cfg.model = parsed.model;
  if (parsed.runtime !== undefined) cfg.runtime = parsed.runtime;
  if (parsed.engine !== undefined) {
    cfg.engine = {
      provider: parsed.engine.provider ?? "cursor",
      ...(parsed.engine.auth !== undefined ? { auth: parsed.engine.auth } : {}),
      ...(parsed.engine.model !== undefined ? { model: parsed.engine.model } : {}),
      ...(parsed.engine.toolPolicy !== undefined ? { toolPolicy: parsed.engine.toolPolicy } : {}),
      ...(parsed.engine.evolution !== undefined ? { evolution: parsed.engine.evolution } : {}),
    };
  }
  if (parsed.skillsPath !== undefined) cfg.skillsPath = parsed.skillsPath;
  if (parsed.stateDir !== undefined) cfg.stateDir = parsed.stateDir;
  if (parsed.mcpServers !== undefined) cfg.mcpServers = parsed.mcpServers;
  if (parsed.safety !== undefined) cfg.safety = parsed.safety;
  if (parsed.memory !== undefined) cfg.memory = parsed.memory;
  if (parsed.browser !== undefined) cfg.browser = parsed.browser;
  if (parsed.hooks !== undefined) cfg.hooks = parsed.hooks;
  if (parsed.pet !== undefined) cfg.pet = parsed.pet;
  if (parsed.homebase !== undefined) cfg.homebase = parsed.homebase;
  // Old behavior: skillPolicy only materializes when allowUnsafe is present.
  if (parsed.skillPolicy?.allowUnsafe !== undefined) {
    cfg.skillPolicy = { allowUnsafe: parsed.skillPolicy.allowUnsafe };
  }
  return cfg;
}
