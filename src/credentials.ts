/**
 * Local API key storage under <stateDir>/credentials.json (default .agent/).
 * With CSAGENT_DATABASE_URL + CSAGENT_SECRETS_KEY: secrets live in Postgres (pgcrypto).
 * Env vars win for CI overrides. Plaintext file is chmod 600; directory is gitignored.
 *
 * Arch-7 note: the `if (pgSecretsEnabled())` branches here are deliberately NOT
 * collapsed into a single polymorphic SecretStore. The two backends differ in
 * behavior, not just storage — the PG path manages an in-memory cache, strips
 * the plaintext file copy, migrates on warm, and validates secret format, while
 * the lenient `save*` file API skips validation (and is tested as such). Read
 * resolution is already a precedence chain (env → pg cache → file), not a
 * branch. These distinctions were hardened by the 2026-06 split-brain/self-heal
 * postmortems; unify with care.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { redact } from "./redact.js";
import { withPgRetry } from "./pg/pool.js";
import {
  CREDENTIAL_SECRET_NAMES,
  type CredentialSecretName,
  clearPgCredentialSecrets,
  deletePgCredentialSecret,
  loadPgCredentialSecrets,
  pgSecretsEnabled,
  setPgCredentialSecret,
} from "./credentialsPg.js";

export { pgSecretsEnabled, SECRETS_KEY_ENV } from "./credentialsPg.js";

export const CREDENTIALS_FILE = "credentials.json";
export const CREDENTIALS_VERSION = 1;

export type SecretSource = "env" | "file" | "pg" | "none";

/** @deprecated use SecretSource */
export type ApiKeySource = SecretSource;

export interface ResolvedApiKey {
  key: string;
  source: SecretSource;
}

export interface ResolvedSecret {
  value: string;
  source: SecretSource;
}

export interface CredentialsFile {
  version: number;
  storage?: "pg";
  cursor_api_key?: string;
  telegram_bot_token?: string;
  anthropic_api_key?: string;
  claude_code_oauth_token?: string;
  openai_api_key?: string;
}

export const API_KEY_HELP =
  "Set CURSOR_API_KEY in the environment or run: irida auth login --stdin";

export const ANTHROPIC_API_KEY_HELP =
  "claude-agent engine (auth=api-key): set ANTHROPIC_API_KEY in the environment";

export const OPENAI_API_KEY_HELP =
  "codex engine (auth=api-key): set OPENAI_API_KEY in the environment or run: irida auth openai login --stdin";

export const CODEX_ACCOUNT_HELP =
  "codex engine (auth=account): connect your ChatGPT account — run `codex login` (the CLI stores the session in ~/.codex/auth.json)";

export const CLAUDE_OAUTH_HELP =
  "claude-agent engine (auth=account): connect your Claude account — run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN, or run `claude login` (the SDK reads ~/.claude/.credentials.json)";

export const TELEGRAM_TOKEN_HELP =
  "Set TELEGRAM_BOT_TOKEN in the environment or run: irida auth telegram login --stdin";

export interface SecretFormatCheck {
  ok: boolean;
  detail: string;
}

/**
 * A real secret is one unbroken token — never internal whitespace. Catches a
 * whole class of paste mistakes a length-only check misses: a shell command
 * typed into a `--stdin` prompt by accident, an `export FOO=...` line pasted
 * whole, multi-line clipboard content, etc. (I-169 incident: a full `npm run
 * dev -- auth claude token-add ...` command line was accepted as a token
 * because it happened to be ≥20 chars.)
 */
function whitespaceShapeIssue(trimmed: string): SecretFormatCheck | null {
  if (/\s/.test(trimmed)) {
    return {
      ok: false,
      detail: "contains whitespace — a real secret is one unbroken token (did you paste a command or an export line instead of just the value?)",
    };
  }
  return null;
}

/** Shape check only — does not call external APIs. Never logs the secret. */
export function validateCursorApiKeyFormat(key: string): SecretFormatCheck {
  const k = key.trim();
  if (k.length < 20) {
    return {
      ok: false,
      detail: `too short (${k.length} chars) — likely corrupt decryption or wrong secret`,
    };
  }
  const ws = whitespaceShapeIssue(k);
  if (ws) return ws;
  if (/^(crsr_|cursor_|key_)/.test(k) || k.startsWith("sk-")) {
    return { ok: true, detail: "ok" };
  }
  if (k.length >= 40) return { ok: true, detail: "ok" };
  return {
    ok: false,
    detail: `unexpected shape (${k.length} chars) — expected crsr_/cursor_ prefix or length ≥40`,
  };
}

/** OpenAI API keys are `sk-…` / `sk-proj-…`; stay loose beyond a corruption floor. */
export function validateOpenAiApiKeyFormat(key: string): SecretFormatCheck {
  const k = key.trim();
  if (k.length < 20) {
    return {
      ok: false,
      detail: `too short (${k.length} chars) — likely corrupt decryption or wrong secret`,
    };
  }
  const ws = whitespaceShapeIssue(k);
  if (ws) return ws;
  if (k.startsWith("sk-")) return { ok: true, detail: "ok" };
  if (k.length >= 40) return { ok: true, detail: "ok" };
  return {
    ok: false,
    detail: `unexpected shape (${k.length} chars) — expected sk-… prefix or length ≥40`,
  };
}

/** Anthropic API keys are `sk-ant-…` (~100 chars). */
export function validateAnthropicApiKeyFormat(key: string): SecretFormatCheck {
  const k = key.trim();
  if (k.length < 20) {
    return {
      ok: false,
      detail: `too short (${k.length} chars) — likely corrupt decryption or wrong secret`,
    };
  }
  const ws = whitespaceShapeIssue(k);
  if (ws) return ws;
  if (k.startsWith("sk-ant-")) return { ok: true, detail: "ok" };
  if (k.length >= 40) return { ok: true, detail: "ok" };
  return {
    ok: false,
    detail: `unexpected shape (${k.length} chars) — expected sk-ant-… prefix or length ≥40`,
  };
}

/**
 * `claude setup-token` emits `sk-ant-oat…`; stay loose beyond a corruption
 * floor. The stored value can ALSO be a pool-wrapper JSON array (I-169) — a
 * container, not a token — validated shallowly here (well-formed, non-empty
 * array). Per-entry token shape (length, no whitespace) is enforced once,
 * when that entry is added (`addClaudeOAuthTokenToPool`), not re-checked on
 * every read of the whole blob — one bad/legacy entry, or a label containing
 * spaces, must not make `guardResolvedSecret` reject the entire pool.
 */
export function validateClaudeOAuthTokenFormat(value: string): SecretFormatCheck {
  const v = value.trim();
  if (v.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(v);
      return Array.isArray(parsed) && parsed.length > 0
        ? { ok: true, detail: "ok" }
        : { ok: false, detail: "empty or malformed token pool" };
    } catch {
      return { ok: false, detail: "malformed token pool JSON" };
    }
  }
  if (v.length < 20) {
    return {
      ok: false,
      detail: `too short (${v.length} chars) — likely corrupt decryption or wrong secret`,
    };
  }
  const ws = whitespaceShapeIssue(v);
  if (ws) return ws;
  return { ok: true, detail: "ok" };
}

/** Bot API tokens are `{bot_id}:{secret}` (~46 chars). Catches PG garbage like 6-char blobs. */
export function validateTelegramBotTokenFormat(token: string): SecretFormatCheck {
  const t = token.trim();
  if (t.length < 35) {
    return {
      ok: false,
      detail: `too short (${t.length} chars) — Bot API tokens are typically ~46 chars`,
    };
  }
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(t)) {
    return { ok: false, detail: "invalid shape — expected bot_id:secret (digits:alnum)" };
  }
  return { ok: true, detail: "ok" };
}

let pgSecretsCache: Partial<Record<CredentialSecretName, string>> | null = null;
let pgCacheReady = false;

/** Absolute path to the credentials file for a project. */
export function credentialsPath(dir: string = process.cwd()): string {
  const cfg = loadConfig(dir);
  return resolve(dir, cfg.stateDir, CREDENTIALS_FILE);
}

function readCredentialsFileFromDisk(dir: string = process.cwd()): CredentialsFile {
  const path = credentialsPath(dir);
  if (!existsSync(path)) return { version: CREDENTIALS_VERSION };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CredentialsFile>;
    const out: CredentialsFile = { version: CREDENTIALS_VERSION };
    if (parsed.storage === "pg") out.storage = "pg";
    if (typeof parsed.cursor_api_key === "string" && parsed.cursor_api_key.trim()) {
      out.cursor_api_key = parsed.cursor_api_key.trim();
    }
    if (typeof parsed.telegram_bot_token === "string" && parsed.telegram_bot_token.trim()) {
      out.telegram_bot_token = parsed.telegram_bot_token.trim();
    }
    if (typeof parsed.anthropic_api_key === "string" && parsed.anthropic_api_key.trim()) {
      out.anthropic_api_key = parsed.anthropic_api_key.trim();
    }
    if (typeof parsed.claude_code_oauth_token === "string" && parsed.claude_code_oauth_token.trim()) {
      out.claude_code_oauth_token = parsed.claude_code_oauth_token.trim();
    }
    if (typeof parsed.openai_api_key === "string" && parsed.openai_api_key.trim()) {
      out.openai_api_key = parsed.openai_api_key.trim();
    }
    return out;
  } catch {
    return { version: CREDENTIALS_VERSION };
  }
}

/** Read credentials.json from disk (plaintext fields only; does not hit Postgres). */
export function readCredentialsFile(dir: string = process.cwd()): CredentialsFile {
  return readCredentialsFileFromDisk(dir);
}

function writeCredentialsFile(dir: string, data: CredentialsFile): void {
  const cfg = loadConfig(dir);
  const stateRoot = resolve(dir, cfg.stateDir);
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  try {
    chmodSync(stateRoot, 0o700);
  } catch {
    // best-effort on platforms without Unix modes
  }

  const path = resolve(stateRoot, CREDENTIALS_FILE);
  const body: CredentialsFile = { version: CREDENTIALS_VERSION };
  if (data.storage === "pg") body.storage = "pg";
  if (data.cursor_api_key?.trim()) body.cursor_api_key = data.cursor_api_key.trim();
  if (data.telegram_bot_token?.trim()) body.telegram_bot_token = data.telegram_bot_token.trim();
  if (data.anthropic_api_key?.trim()) body.anthropic_api_key = data.anthropic_api_key.trim();
  if (data.claude_code_oauth_token?.trim()) body.claude_code_oauth_token = data.claude_code_oauth_token.trim();
  if (data.openai_api_key?.trim()) body.openai_api_key = data.openai_api_key.trim();

  if (
    !body.cursor_api_key &&
    !body.telegram_bot_token &&
    !body.anthropic_api_key &&
    !body.claude_code_oauth_token &&
    !body.openai_api_key &&
    body.storage !== "pg"
  ) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }

  writeFileSync(path, JSON.stringify(body, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort */
  }
}

function stripPlaintextSecretFromFile(dir: string, name: CredentialSecretName): void {
  // Preserve every OTHER field (I-145 — the old cursor/telegram-only rebuild
  // silently dropped anthropic fields from the file on any strip).
  const existing = readCredentialsFileFromDisk(dir);
  const next: CredentialsFile = { ...existing, version: CREDENTIALS_VERSION };
  if (pgSecretsEnabled()) next.storage = "pg";
  delete next[name];
  writeCredentialsFile(dir, next);
}

function pgCachedSecret(name: CredentialSecretName): string {
  if (!pgSecretsEnabled() || !pgCacheReady || !pgSecretsCache) return "";
  return pgSecretsCache[name] ?? "";
}

function checkSecretFormat(name: CredentialSecretName, value: string): SecretFormatCheck {
  switch (name) {
    case "cursor_api_key":
      return validateCursorApiKeyFormat(value);
    case "anthropic_api_key":
      return validateAnthropicApiKeyFormat(value);
    case "claude_code_oauth_token":
      return validateClaudeOAuthTokenFormat(value);
    case "telegram_bot_token":
      return validateTelegramBotTokenFormat(value);
    case "openai_api_key":
      return validateOpenAiApiKeyFormat(value);
  }
}

const SECRET_RESAVE_HINT: Record<CredentialSecretName, string> = {
  cursor_api_key: "irida auth login --stdin",
  telegram_bot_token: "irida auth telegram login --stdin",
  anthropic_api_key: "irida auth anthropic login --stdin",
  claude_code_oauth_token: "irida auth claude token --stdin",
  openai_api_key: "irida auth openai login --stdin",
};

/**
 * Read-path format guard (I-136). A corrupt stored value (the I-132 incident:
 * a 6-char blob from credentials.json) passes `if (!token)` guards and reaches
 * the Telegram API as `bot<garbage>/…` → opaque 404. Scope, per the Arch-7 note
 * above: env is never validated (explicit user override, doctor flags shape),
 * and in file-only mode the lenient file API stays lenient on read too — the
 * garbage class this guards against is a PG-mode artifact (failed decrypt /
 * split-brain residue mirrored to the file fallback).
 */
function guardResolvedSecret(
  name: CredentialSecretName,
  value: string,
  source: "pg" | "file"
): string {
  if (!value) return "";
  if (source === "file" && !pgSecretsEnabled()) return value;
  const fmt = checkSecretFormat(name, value);
  if (fmt.ok) return value;
  const where = source === "pg" ? "postgres" : "credentials.json";
  const hint = SECRET_RESAVE_HINT[name];
  console.error(
    `[credentials] ${name} from ${where} is corrupt (${fmt.detail}) — ignoring; re-save with: ${hint}`
  );
  return "";
}

/** Load encrypted secrets from Postgres; migrate plaintext file on first run. */
export async function warmCredentialsCache(dir: string = process.cwd()): Promise<void> {
  if (!pgSecretsEnabled()) {
    pgSecretsCache = null;
    pgCacheReady = false;
    return;
  }
  try {
    // A transient PG blip at process start must not cold-cache secrets for the
    // whole process lifetime (gateway warms exactly once) — retry briefly (I-137).
    const loaded = await withPgRetry(() => loadPgCredentialSecrets(), { label: "credentials warm" });
    const file = readCredentialsFileFromDisk(dir);
    let migrated = false;
    for (const name of CREDENTIAL_SECRET_NAMES) {
      if (!loaded[name] && file[name]) {
        // Migration guard (I-136): never push a corrupt file value into PG —
        // this path bypasses persistSecret's validation and would launder the
        // I-132 garbage class into the "trusted" store.
        const fileFmt = checkSecretFormat(name, file[name]!);
        if (!fileFmt.ok) {
          console.error(
            `[credentials] skip migrating ${name} to postgres: file value is corrupt (${fileFmt.detail})`
          );
          continue;
        }
        await setPgCredentialSecret(name, file[name]!);
        loaded[name] = file[name];
        migrated = true;
        continue;
      }
      // Self-heal read path (postmortem 2026-06-12): PG holds a corrupt value
      // (short garbage that decrypts fine) while the file copy is valid —
      // prefer the valid file value and say so. Write-back stays explicit.
      if (loaded[name] && file[name]) {
        const fmt = checkSecretFormat(name, loaded[name]!);
        const fileFmt = checkSecretFormat(name, file[name]!);
        if (!fmt.ok && fileFmt.ok) {
          console.error(
            `[credentials] ${name} in postgres is corrupt (${fmt.detail}); using valid file value — re-save with: irida auth ${name === "cursor_api_key" ? "login" : "telegram login"} --stdin`
          );
          loaded[name] = file[name];
        }
      }
    }
    if (migrated) {
      writeCredentialsFile(dir, { version: CREDENTIALS_VERSION, storage: "pg" });
    } else if (Object.keys(loaded).length > 0 || file.storage === "pg") {
      const hasPlain = Boolean(file.cursor_api_key || file.telegram_bot_token);
      if (!hasPlain && file.storage !== "pg") {
        writeCredentialsFile(dir, { version: CREDENTIALS_VERSION, storage: "pg" });
      }
    }
    pgSecretsCache = loaded;
    pgCacheReady = true;
  } catch (e) {
    // Postgres unavailable — fall back to plaintext credentials.json if present.
    // Say so loudly (I-136): this silent catch was link #1 of the I-132 chain
    // (dead DB → cold cache → garbage file token → opaque Telegram 404).
    pgSecretsCache = null;
    pgCacheReady = false;
    console.error(
      `[credentials] warm cache failed — postgres unavailable, falling back to credentials.json: ${redact(
        e instanceof Error ? e.message : String(e)
      )}`
    );
  }
}

async function persistSecret(name: CredentialSecretName, value: string, dir: string): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("secret must be a non-empty string");
  const fmt = checkSecretFormat(name, trimmed);
  if (!fmt.ok) {
    throw new Error(`refusing to save ${name}: ${fmt.detail}`);
  }
  if (pgSecretsEnabled()) {
    await setPgCredentialSecret(name, trimmed);
    pgSecretsCache = { ...(pgSecretsCache ?? {}), [name]: trimmed };
    pgCacheReady = true;
    stripPlaintextSecretFromFile(dir, name);
    return;
  }
  const existing = readCredentialsFileFromDisk(dir);
  writeCredentialsFile(dir, { ...existing, [name]: trimmed });
}

/** Resolve API key: environment overrides postgres/file. */
export function resolveApiKey(dir: string = process.cwd()): ResolvedApiKey {
  const fromEnv = (process.env.CURSOR_API_KEY ?? "").trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  const fromPg = guardResolvedSecret("cursor_api_key", pgCachedSecret("cursor_api_key"), "pg");
  if (fromPg) return { key: fromPg, source: "pg" };
  const fromFile = guardResolvedSecret(
    "cursor_api_key",
    readCredentialsFileFromDisk(dir).cursor_api_key ?? "",
    "file"
  );
  if (fromFile) return { key: fromFile, source: "file" };
  return { key: "", source: "none" };
}

/**
 * Resolve the Anthropic API key for the claude-agent engine (I-100).
 * Env `ANTHROPIC_API_KEY` overrides postgres (pgcrypto, I-145) and the
 * plaintext credentials.json field — same precedence chain as cursor/telegram.
 */
export function resolveAnthropicKey(dir: string = process.cwd()): ResolvedApiKey {
  const fromEnv = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  const fromPg = guardResolvedSecret("anthropic_api_key", pgCachedSecret("anthropic_api_key"), "pg");
  if (fromPg) return { key: fromPg, source: "pg" };
  const fromFile = guardResolvedSecret(
    "anthropic_api_key",
    readCredentialsFileFromDisk(dir).anthropic_api_key ?? "",
    "file"
  );
  if (fromFile) return { key: fromFile, source: "file" };
  return { key: "", source: "none" };
}

/**
 * Resolve the OpenAI API key for the codex engine in auth=api-key mode (I-144).
 * Env `OPENAI_API_KEY` overrides postgres (pgcrypto) and the plaintext
 * credentials.json field — same precedence chain as the other secrets. Not
 * consulted in account mode, where the `codex login` session is the credential.
 */
export function resolveOpenAiKey(dir: string = process.cwd()): ResolvedApiKey {
  const fromEnv = (process.env.OPENAI_API_KEY ?? "").trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  const fromPg = guardResolvedSecret("openai_api_key", pgCachedSecret("openai_api_key"), "pg");
  if (fromPg) return { key: fromPg, source: "pg" };
  const fromFile = guardResolvedSecret(
    "openai_api_key",
    readCredentialsFileFromDisk(dir).openai_api_key ?? "",
    "file"
  );
  if (fromFile) return { key: fromFile, source: "file" };
  return { key: "", source: "none" };
}

/**
 * Whether the codex engine could run in ACCOUNT mode right now: a `codex login`
 * session on disk. Irida's adapter runs the CLI under its own CODEX_HOME and
 * symlinks this exact file in, so the operator's session is the single source
 * of truth (and the single refresher of its rotating token).
 */
export function codexAccountAvailable(): boolean {
  try {
    return existsSync(join(homedir(), ".codex", "auth.json"));
  } catch {
    return false;
  }
}

/**
 * Resolve the ACTIVE Claude account OAuth token for the claude-agent engine
 * (auth=account, I-100). Env `CLAUDE_CODE_OAUTH_TOKEN` (from `claude
 * setup-token`) overrides everything else. Otherwise resolves the pool
 * (I-169) and returns its first non-invalidated entry, sticky across calls —
 * a single legacy token behaves exactly as before (one-entry pool). May
 * legitimately return "none": when no token is stored/valid, the Agent SDK
 * falls back to an existing `claude login` session
 * (~/.claude/.credentials.json), so callers should NOT hard-fail on an empty
 * token in account mode.
 */
export function resolveClaudeOAuthToken(dir: string = process.cwd()): ResolvedApiKey {
  const { pool, source } = resolveClaudeOAuthTokenPool(dir);
  const active = pool.find((e) => !e.invalidAt);
  if (!active) return { key: "", source: "none" };
  return { key: active.token, source };
}

/**
 * Whether the claude-agent engine could run in ACCOUNT mode right now (I-156):
 * a stored/env OAuth token, or an existing `claude login` session that the
 * Agent SDK reads from ~/.claude/.credentials.json. Lets `/engine claude` fall
 * back to account instead of dead-ending on a missing ANTHROPIC_API_KEY.
 */
export function claudeAccountAvailable(dir: string = process.cwd()): boolean {
  if (resolveClaudeOAuthToken(dir).key) return true;
  try {
    return existsSync(join(homedir(), ".claude", ".credentials.json"));
  } catch {
    return false;
  }
}

/** Resolve Telegram bot token: environment overrides postgres/file. */
export function resolveTelegramBotToken(
  dir: string = process.cwd(),
  envName: string = "TELEGRAM_BOT_TOKEN"
): ResolvedSecret {
  const name = envName.trim() || "TELEGRAM_BOT_TOKEN";
  const fromEnv = (process.env[name] ?? "").trim();
  if (fromEnv) return { value: fromEnv, source: "env" };
  const fromPg = guardResolvedSecret("telegram_bot_token", pgCachedSecret("telegram_bot_token"), "pg");
  if (fromPg) return { value: fromPg, source: "pg" };
  const fromFile = guardResolvedSecret(
    "telegram_bot_token",
    readCredentialsFileFromDisk(dir).telegram_bot_token ?? "",
    "file"
  );
  if (fromFile) return { value: fromFile, source: "file" };
  return { value: "", source: "none" };
}

export function hasPlaintextCredentialsOnDisk(dir: string = process.cwd()): boolean {
  const file = readCredentialsFileFromDisk(dir);
  return Boolean(
    file.cursor_api_key ||
      file.telegram_bot_token ||
      file.anthropic_api_key ||
      file.claude_code_oauth_token ||
      file.openai_api_key
  );
}

export function hasStoredCredentials(dir: string = process.cwd()): boolean {
  if (pgSecretsEnabled() && pgCacheReady && pgSecretsCache && Object.keys(pgSecretsCache).length > 0) {
    return true;
  }
  return existsSync(credentialsPath(dir));
}

export function hasStoredTelegramToken(dir: string = process.cwd()): boolean {
  if (pgCachedSecret("telegram_bot_token")) return true;
  return Boolean(readCredentialsFileFromDisk(dir).telegram_bot_token);
}

/** Persist Cursor API key; preserves other secrets. */
export function saveCredentials(apiKey: string, dir: string = process.cwd()): void {
  const key = apiKey.trim();
  if (!key) throw new Error("API key must be a non-empty string");
  if (pgSecretsEnabled()) {
    throw new Error("saveCredentials: use persistCursorApiKey when CSAGENT_SECRETS_KEY is set");
  }
  const existing = readCredentialsFileFromDisk(dir);
  writeCredentialsFile(dir, { ...existing, cursor_api_key: key });
}

export async function persistCursorApiKey(apiKey: string, dir: string = process.cwd()): Promise<void> {
  await persistSecret("cursor_api_key", apiKey, dir);
}

/** Persist the Anthropic API key (claude-agent engine, file storage). Preserves other secrets. */
export function saveAnthropicApiKey(key: string, dir: string = process.cwd()): void {
  const v = key.trim();
  if (!v) throw new Error("Anthropic API key must be a non-empty string");
  if (pgSecretsEnabled()) {
    throw new Error("saveAnthropicApiKey: use persistAnthropicApiKey when the secrets key is set");
  }
  const existing = readCredentialsFileFromDisk(dir);
  writeCredentialsFile(dir, { ...existing, anthropic_api_key: v });
}

/** Persist the Anthropic API key to postgres (pgcrypto) or file — I-145 parity with cursor/telegram. */
export async function persistAnthropicApiKey(key: string, dir: string = process.cwd()): Promise<void> {
  await persistSecret("anthropic_api_key", key, dir);
}

export function clearAnthropicApiKey(dir: string = process.cwd()): boolean {
  const existing = readCredentialsFileFromDisk(dir);
  if (!existing.anthropic_api_key) return false;
  const next = { ...existing };
  delete next.anthropic_api_key;
  writeCredentialsFile(dir, next);
  return true;
}

/** Persist the OpenAI API key (codex engine auth=api-key, file storage). Preserves other secrets. */
export function saveOpenAiApiKey(key: string, dir: string = process.cwd()): void {
  const v = key.trim();
  if (!v) throw new Error("OpenAI API key must be a non-empty string");
  if (pgSecretsEnabled()) {
    throw new Error("saveOpenAiApiKey: use persistOpenAiApiKey when the secrets key is set");
  }
  const existing = readCredentialsFileFromDisk(dir);
  writeCredentialsFile(dir, { ...existing, openai_api_key: v });
}

/** Persist the OpenAI API key to postgres (pgcrypto) or file — parity with the other secrets. */
export async function persistOpenAiApiKey(key: string, dir: string = process.cwd()): Promise<void> {
  await persistSecret("openai_api_key", key, dir);
}

export function clearOpenAiApiKey(dir: string = process.cwd()): boolean {
  const existing = readCredentialsFileFromDisk(dir);
  if (!existing.openai_api_key) return false;
  const next = { ...existing };
  delete next.openai_api_key;
  writeCredentialsFile(dir, next);
  return true;
}

/** Persist the Claude account OAuth token (claude-agent engine, file storage). Preserves other secrets. */
export function saveClaudeOAuthToken(token: string, dir: string = process.cwd()): void {
  const v = token.trim();
  if (!v) throw new Error("Claude OAuth token must be a non-empty string");
  if (pgSecretsEnabled()) {
    throw new Error("saveClaudeOAuthToken: use persistClaudeOAuthToken when the secrets key is set");
  }
  const existing = readCredentialsFileFromDisk(dir);
  writeCredentialsFile(dir, { ...existing, claude_code_oauth_token: v });
}

/** Persist the Claude OAuth token to postgres (pgcrypto) or file — I-145 parity with cursor/telegram. */
export async function persistClaudeOAuthToken(token: string, dir: string = process.cwd()): Promise<void> {
  await persistSecret("claude_code_oauth_token", token, dir);
}

export function clearClaudeOAuthToken(dir: string = process.cwd()): boolean {
  const existing = readCredentialsFileFromDisk(dir);
  if (!existing.claude_code_oauth_token) return false;
  const next = { ...existing };
  delete next.claude_code_oauth_token;
  writeCredentialsFile(dir, next);
  return true;
}

/**
 * Multi-account Claude OAuth token pool (I-169), by analogy with LLMAPIProxy's
 * account rotation: several `claude setup-token` accounts, automatic failover
 * when the currently active one hits an auth error, no single-token outage.
 *
 * Storage: the pool is JSON-serialized into the SAME `claude_code_oauth_token`
 * secret slot used by the single-token API above — zero new schema, reuses the
 * existing pgcrypto/file/history machinery as-is. A legacy plaintext token
 * value (from before this feature, or written by the single-token
 * save/persist functions above) is auto-wrapped into a one-entry pool on read
 * — old installs keep working unchanged, `resolveClaudeOAuthToken` returns the
 * identical value/source it always did.
 *
 * Unlike LLMAPIProxy's Qwen tokens, Claude's `sk-ant-oat-…` OAuth token is not
 * a JWT — there's no local expiry to decode, so "invalid" can only be learned
 * reactively (an auth-classified SDK error), never predicted. And unlike
 * LLMAPIProxy's per-request round-robin (spreading load across many parallel
 * proxy calls), this is a single-user agent — the active token is STICKY (the
 * first non-invalidated pool entry, in insertion order) rather than rotated
 * per turn; only an auth failure or an explicit `use` advances it.
 */
export interface ClaudeOAuthTokenEntry {
  id: string;
  token: string;
  label?: string;
  addedAt: string;
  /** Set when an auth-classified SDK error was attributed to this token. */
  invalidAt?: string;
}

function parseClaudeOAuthTokenPool(raw: string): ClaudeOAuthTokenEntry[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (e): e is ClaudeOAuthTokenEntry =>
            Boolean(e) &&
            typeof e === "object" &&
            typeof (e as ClaudeOAuthTokenEntry).id === "string" &&
            typeof (e as ClaudeOAuthTokenEntry).token === "string" &&
            (e as ClaudeOAuthTokenEntry).token.trim() !== ""
        );
      }
    } catch {
      // Not valid JSON — fall through and treat the raw value as a legacy bare token.
    }
  }
  return [{ id: "legacy", token: trimmed, addedAt: new Date(0).toISOString() }];
}

function serializeClaudeOAuthTokenPool(pool: ClaudeOAuthTokenEntry[]): string {
  return JSON.stringify(pool);
}

/** Stored pool only — ignores the CLAUDE_CODE_OAUTH_TOKEN env override (mutation target). */
function loadStoredClaudeOAuthTokenPool(dir: string): ClaudeOAuthTokenEntry[] {
  const fromPg = guardResolvedSecret("claude_code_oauth_token", pgCachedSecret("claude_code_oauth_token"), "pg");
  if (fromPg) return parseClaudeOAuthTokenPool(fromPg);
  const fromFile = guardResolvedSecret(
    "claude_code_oauth_token",
    readCredentialsFileFromDisk(dir).claude_code_oauth_token ?? "",
    "file"
  );
  if (fromFile) return parseClaudeOAuthTokenPool(fromFile);
  return [];
}

async function persistClaudeOAuthTokenPool(pool: ClaudeOAuthTokenEntry[], dir: string): Promise<void> {
  const serialized = serializeClaudeOAuthTokenPool(pool);
  if (pgSecretsEnabled()) {
    await persistSecret("claude_code_oauth_token", serialized, dir);
    return;
  }
  const existing = readCredentialsFileFromDisk(dir);
  writeCredentialsFile(dir, { ...existing, claude_code_oauth_token: serialized });
}

/**
 * Resolve the full token pool for display/management (`irida auth claude token
 * list`, rotation). Env override short-circuits to a synthetic single-entry
 * pool, same precedence as `resolveClaudeOAuthToken` — env always wins, and
 * mutation commands (add/remove/use/invalidate) deliberately bypass it via
 * `loadStoredClaudeOAuthTokenPool` so they always target the real stored pool.
 */
export function resolveClaudeOAuthTokenPool(
  dir: string = process.cwd()
): { pool: ClaudeOAuthTokenEntry[]; source: SecretSource } {
  const fromEnv = (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
  if (fromEnv) {
    return { pool: [{ id: "env", token: fromEnv, addedAt: new Date(0).toISOString() }], source: "env" };
  }
  const stored = loadStoredClaudeOAuthTokenPool(dir);
  if (!stored.length) return { pool: [], source: "none" };
  const pgHas = Boolean(guardResolvedSecret("claude_code_oauth_token", pgCachedSecret("claude_code_oauth_token"), "pg"));
  return { pool: stored, source: pgHas ? "pg" : "file" };
}

/** Add a token to the pool. Rejects an exact duplicate already present. */
export async function addClaudeOAuthTokenToPool(
  token: string,
  dir: string = process.cwd(),
  label?: string
): Promise<{ id: string }> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("Claude OAuth token must be a non-empty string");
  const fmt = validateClaudeOAuthTokenFormat(trimmed);
  if (!fmt.ok) throw new Error(`refusing to add claude oauth token: ${fmt.detail}`);
  const pool = loadStoredClaudeOAuthTokenPool(dir);
  if (pool.some((e) => e.token === trimmed)) {
    throw new Error("this token is already in the pool");
  }
  const entry: ClaudeOAuthTokenEntry = {
    id: randomUUID().slice(0, 8),
    token: trimmed,
    addedAt: new Date().toISOString(),
  };
  if (label?.trim()) entry.label = label.trim();
  await persistClaudeOAuthTokenPool([...pool, entry], dir);
  return { id: entry.id };
}

/** Remove one token by id. Refuses to drop the last remaining entry (use `auth claude logout`). */
export async function removeClaudeOAuthTokenFromPool(id: string, dir: string = process.cwd()): Promise<boolean> {
  const pool = loadStoredClaudeOAuthTokenPool(dir);
  const idx = pool.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  if (pool.length === 1) {
    throw new Error("refusing to remove the last token — use `irida auth claude logout` to clear it entirely");
  }
  await persistClaudeOAuthTokenPool(pool.filter((e) => e.id !== id), dir);
  return true;
}

/**
 * Manually select a token: moves it to the front (making it the sticky active
 * entry) and clears any prior invalid mark — an operator picking a token by id
 * is asserting it's good now (e.g. after refreshing it out of band).
 */
export async function useClaudeOAuthTokenInPool(id: string, dir: string = process.cwd()): Promise<boolean> {
  const pool = loadStoredClaudeOAuthTokenPool(dir);
  const idx = pool.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  const rest = [...pool];
  const [entry] = rest.splice(idx, 1);
  const revived: ClaudeOAuthTokenEntry = { ...entry!, invalidAt: undefined };
  await persistClaudeOAuthTokenPool([revived, ...rest], dir);
  return true;
}

/**
 * Mark the pool entry matching this exact token value as invalid (auth error
 * attributed to it). Returns false when the token isn't found in the stored
 * pool (e.g. it came from the CLAUDE_CODE_OAUTH_TOKEN env override, or was
 * already marked) — callers should treat that as "nothing to rotate to".
 */
export async function markClaudeOAuthTokenInvalid(token: string, dir: string = process.cwd()): Promise<boolean> {
  const trimmed = token.trim();
  if (!trimmed) return false;
  const pool = loadStoredClaudeOAuthTokenPool(dir);
  const idx = pool.findIndex((e) => e.token === trimmed && !e.invalidAt);
  if (idx === -1) return false;
  const next = [...pool];
  next[idx] = { ...next[idx]!, invalidAt: new Date().toISOString() };
  await persistClaudeOAuthTokenPool(next, dir);
  return true;
}

/** Persist Telegram bot token; preserves other secrets. */
export function saveTelegramBotToken(token: string, dir: string = process.cwd()): void {
  const value = token.trim();
  if (!value) throw new Error("Telegram bot token must be a non-empty string");
  if (pgSecretsEnabled()) {
    throw new Error("saveTelegramBotToken: use persistTelegramBotToken when CSAGENT_SECRETS_KEY is set");
  }
  const existing = readCredentialsFileFromDisk(dir);
  writeCredentialsFile(dir, { ...existing, telegram_bot_token: value });
}

export async function persistTelegramBotToken(token: string, dir: string = process.cwd()): Promise<void> {
  await persistSecret("telegram_bot_token", token, dir);
}

export function clearCredentials(dir: string = process.cwd()): boolean {
  if (pgSecretsEnabled()) {
    throw new Error("clearCredentials: use clearAllStoredCredentials when CSAGENT_SECRETS_KEY is set");
  }
  const path = credentialsPath(dir);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export async function clearAllStoredCredentials(dir: string = process.cwd()): Promise<boolean> {
  let removed = false;
  if (pgSecretsEnabled()) {
    const n = await clearPgCredentialSecrets();
    pgSecretsCache = {};
    pgCacheReady = true;
    removed = n > 0;
  }
  const path = credentialsPath(dir);
  if (existsSync(path)) {
    unlinkSync(path);
    removed = true;
  }
  return removed;
}

export function clearTelegramBotToken(dir: string = process.cwd()): boolean {
  if (pgSecretsEnabled()) {
    throw new Error("clearTelegramBotToken: use clearStoredTelegramToken when CSAGENT_SECRETS_KEY is set");
  }
  const existing = readCredentialsFileFromDisk(dir);
  if (!existing.telegram_bot_token) return false;
  const next = { ...existing };
  delete next.telegram_bot_token;
  writeCredentialsFile(dir, next);
  return true;
}

export async function clearStoredTelegramToken(dir: string = process.cwd()): Promise<boolean> {
  let removed = false;
  if (pgSecretsEnabled()) {
    removed = (await deletePgCredentialSecret("telegram_bot_token")) || removed;
    if (pgSecretsCache) delete pgSecretsCache.telegram_bot_token;
    pgCacheReady = true;
    stripPlaintextSecretFromFile(dir, "telegram_bot_token");
  } else {
    removed = clearTelegramBotToken(dir);
  }
  return removed;
}

export function clearCursorApiKey(dir: string = process.cwd()): boolean {
  if (pgSecretsEnabled()) {
    throw new Error("clearCursorApiKey: use clearStoredCursorApiKey when CSAGENT_SECRETS_KEY is set");
  }
  const existing = readCredentialsFileFromDisk(dir);
  if (!existing.cursor_api_key) return false;
  const next = { ...existing };
  delete next.cursor_api_key;
  writeCredentialsFile(dir, next);
  return true;
}

export async function clearStoredCursorApiKey(dir: string = process.cwd()): Promise<boolean> {
  let removed = false;
  if (pgSecretsEnabled()) {
    removed = (await deletePgCredentialSecret("cursor_api_key")) || removed;
    if (pgSecretsCache) delete pgSecretsCache.cursor_api_key;
    pgCacheReady = true;
    stripPlaintextSecretFromFile(dir, "cursor_api_key");
  } else {
    removed = clearCursorApiKey(dir);
  }
  return removed;
}

/** Doctor-friendly label without exposing the secret. */
export function apiKeySourceLabel(source: SecretSource, dir: string = process.cwd()): string {
  switch (source) {
    case "env":
      return "set (environment)";
    case "pg":
      return "set (postgres credential_secrets, pgcrypto)";
    case "file":
      return `set (${loadConfig(dir).stateDir}/${CREDENTIALS_FILE})`;
    case "none":
      return `missing — export CURSOR_API_KEY or run irida auth login --stdin`;
  }
}

export function telegramTokenSourceLabel(
  source: SecretSource,
  dir: string = process.cwd(),
  envName: string = "TELEGRAM_BOT_TOKEN"
): string {
  switch (source) {
    case "env":
      return `set (environment ${envName})`;
    case "pg":
      return "set (postgres credential_secrets, pgcrypto)";
    case "file":
      return `set (${loadConfig(dir).stateDir}/${CREDENTIALS_FILE})`;
    case "none":
      return `missing — export ${envName} or run irida auth telegram login --stdin`;
  }
}
