/**
 * Doctor checks as data (shared by CLI and TUI).
 */
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { iridaHome } from "./env.js";
import { CONFIG_FILE, ConfigError, loadConfig, resolveMemoryRoot, validateMcpServers } from "./config.js";
import { browserMcpEnabled, resolveMcpServers } from "./mcpServers.js";
import { resolveBrowserRoot } from "./mcp/browserContext.js";
import {
  apiKeySourceLabel,
  hasPlaintextCredentialsOnDisk,
  pgSecretsEnabled,
  resolveApiKey,
  resolveAnthropicKey,
  resolveClaudeOAuthToken,
  resolveClaudeOAuthTokenPool,
  resolveTelegramBotToken,
  telegramTokenSourceLabel,
  validateAnthropicApiKeyFormat,
  validateClaudeOAuthTokenFormat,
  validateCursorApiKeyFormat,
  validateTelegramBotTokenFormat,
} from "./credentials.js";
import { probePgCredentialStore, SECRETS_KEY_ENV, secretsKey, secretsKeyStrengthIssue } from "./credentialsPg.js";
import { probePgGatewayAllowlist } from "./gatewayAllowedPg.js";
import { pgUrl } from "./pg/pool.js";
import {
  gatewayAllowlistHasTestIds,
  hasPlaintextGatewayAllowlist,
  pgAllowlistCacheReady,
  resolveAllowedChatIds,
  warmGatewayAllowlistCache,
} from "./gatewayAllowlist.js";
import { probePostgresStore } from "./store.js";
import {
  findLatestCronJobsBackup,
  loadCronJobs,
  validateCronJobsFile,
  cronJobsPath,
} from "./cronJobs.js";
import { gatherCronPromptDrift } from "./cronPromptDrift.js";
import { gatherCronContextDirIssue } from "./cronContextArtifact.js";
import { loadGatewayConfig, validateGatewayConfig, gatewayConfigPath } from "./gatewayConfig.js";
import { assessTelegramAllowedUpdates, telegramBotToken } from "./gatewayTelegram.js";
import { gatherMemorySilos, siloIsAligned } from "./memorySiloOps.js";
import { gatherCronPromptGuardIssues } from "./cronPromptGuard.js";
import {
  listSkills,
  loadSkill,
  resolveSkillsRoot,
  scanSkillThreat,
  skillExists,
} from "./skills.js";
import { loadRunMetrics } from "./runMetrics.js";
import { gatherStaleDistChecks } from "./doctorDistStale.js";
import { createMemoryStore } from "./memoryStore.js";
import {
  embeddingsEnabled,
  EMBEDDINGS_DEFAULT_MODEL,
  EMBEDDINGS_DEFAULT_URL,
  EMBEDDINGS_DIM,
} from "./embeddings.js";

/** Probe budget for the embedding round-trip — a hung service must not hang doctor. */
const DOCTOR_EMBED_TIMEOUT_MS = 5_000;

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** Copy-paste remediation shown under a failed check (A4). */
  fix?: string;
}

export function gatherDoctorChecks(dir: string = process.cwd()): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  // Engine selection (I-100): which runtime + credential the active config uses.
  let engineProvider = "cursor";
  let engineAuth = "api-key";
  try {
    const c0 = loadConfig(dir);
    engineProvider = c0.engine.provider;
    engineAuth = c0.engine.auth ?? "api-key";
  } catch {
    /* config errors surface in the config check below */
  }
  checks.push({
    name: "engine",
    ok: true,
    detail: engineProvider === "claude-agent" ? `claude-agent (auth=${engineAuth})` : "cursor",
  });

  if (engineProvider === "claude-agent" && engineAuth === "account") {
    const t = resolveClaudeOAuthToken(dir);
    const { pool } = resolveClaudeOAuthTokenPool(dir);
    const invalidCount = pool.filter((e) => e.invalidAt).length;
    let detail: string;
    if (t.source === "none" && pool.length === 0) {
      detail = "not set — using `claude login` session if present";
    } else if (t.source === "none") {
      detail = `all ${pool.length} pooled token(s) invalid — using \`claude login\` session if present`;
    } else if (pool.length > 1) {
      detail = `set (${t.source}) — pool: ${pool.length} token(s)${invalidCount ? `, ${invalidCount} invalid` : ""}`;
    } else {
      detail = `set (${t.source})`;
    }
    checks.push({
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      // Empty/all-invalid is fine — account mode falls back to a `claude login`
      // session; warn (not fail) when the pool exists but every entry is dead,
      // since that's silently degraded rather than a hard config error.
      ok: pool.length === 0 || invalidCount < pool.length,
      detail,
      fix:
        pool.length > 1
          ? "irida auth claude token-list   # then token-use <id> or token-add --stdin"
          : "claude setup-token   # then: irida auth claude token --stdin (or token-add --stdin for a 2nd account)",
    });
  } else if (engineProvider === "claude-agent") {
    const a = resolveAnthropicKey(dir);
    checks.push({
      name: "ANTHROPIC_API_KEY",
      ok: a.key.length > 0,
      detail: a.source === "none" ? "missing" : `set (${a.source})`,
      fix: 'printf %s "sk-ant-..." | irida auth anthropic login --stdin',
    });
  } else {
    const resolved = resolveApiKey(dir);
    checks.push({
      name: "CURSOR_API_KEY",
      ok: resolved.key.length > 0,
      detail: apiKeySourceLabel(resolved.source, dir),
      fix: 'printf %s "cursor_..." | irida auth login --stdin',
    });
  }

  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node >= 20", ok: major >= 20, detail: `v${process.versions.node}` });
  checks.push({ name: "cwd", ok: true, detail: dir });
  const home = iridaHome();
  if (home) {
    checks.push({ name: "CSAGENT_HOME", ok: true, detail: home });
  }

  let cfgOk = true;
  let cfgDetail = `defaults (no ${CONFIG_FILE})`;
  let mcpErrs: string[] = [];
  let mcpCount = 0;
  try {
    const c = loadConfig(dir);
    if (existsSync(resolve(dir, CONFIG_FILE))) {
      cfgDetail = `loaded (model=${c.model}, runtime=${c.runtime})`;
    }
    const merged = resolveMcpServers(c, dir);
    mcpCount = Object.keys(merged).length;
    mcpErrs = validateMcpServers(merged);
  } catch (e) {
    cfgOk = false;
    cfgDetail = e instanceof ConfigError ? e.message : String(e);
  }
  checks.push({ name: "config", ok: cfgOk, detail: cfgDetail });
  if (cfgOk) {
    checks.push({
      name: "mcp config",
      ok: mcpErrs.length === 0,
      detail: mcpErrs.length ? mcpErrs.join("; ") : `${mcpCount} server(s), parse ok`,
    });
  }

  let writeOk = true;
  let writeDetail = "state dir writable (created on first run)";
  let stateRoot = resolveMemoryRoot(dir);
  const probeTarget = existsSync(stateRoot) ? stateRoot : dir;
  try {
    accessSync(probeTarget, constants.W_OK);
    if (existsSync(stateRoot)) writeDetail = `${stateRoot} writable`;
  } catch {
    writeOk = false;
    writeDetail = `${probeTarget} not writable`;
  }
  checks.push({ name: "state writable", ok: writeOk, detail: writeDetail });

  const ctxIssue = gatherCronContextDirIssue(dir);
  if (ctxIssue) {
    checks.push({ name: "cron context dir", ok: false, detail: ctxIssue });
  }

  checks.push(...gatherMemoryEnvChecks(dir));
  checks.push(...gatherBrowserEnvChecks(dir));
  checks.push(...gatherGatewaySkillsChecks(dir));
  checks.push(...gatherCredentialsEnvChecks(dir));
  checks.push(...gatherDoctorSecretFormatChecks(dir));
  checks.push(...gatherRunLogChecks(dir));
  checks.push(...gatherStaleDistChecks(dir));

  const cronPath = cronJobsPath(dir);
  if (existsSync(cronPath)) {
    const cronErrs = validateCronJobsFile(dir);
    const bak = cronErrs.length ? findLatestCronJobsBackup(dir) : null;
    const fixBase = "compare with deploy/cron.jobs.example.json, then: irida cron list";
    checks.push({
      name: "cron jobs",
      ok: cronErrs.length === 0,
      detail: cronErrs.length ? cronErrs.join("; ") : "cron.jobs.json valid",
      fix: bak ? `${fixBase}; restore: cp "${bak}" "${cronPath}"` : fixBase,
    });
    if (cronErrs.length === 0) {
      const drift = gatherCronPromptDrift(dir);
      checks.push({
        name: "cron prompts",
        ok: drift.ok,
        detail: drift.ok ? "deploy/runtime prompts aligned" : drift.warnings.join("; "),
      });
      const guard = gatherCronPromptGuardIssues(dir);
      checks.push({
        name: "cron prompt guard",
        ok: guard.length === 0,
        detail: guard.length ? guard.join("; ") : "no injection patterns",
      });
    }
  }

  const gwPath = gatewayConfigPath(dir);
  if (existsSync(gwPath)) {
    const gwErrs = validateGatewayConfig(dir);
    checks.push({
      name: "gateway",
      ok: gwErrs.length === 0,
      detail: gwErrs.length ? gwErrs.join("; ") : "gateway.json valid",
      fix: "cp deploy/gateway.json.example .agent/gateway.json  # then set allowedChatIds + token: irida auth telegram login --stdin",
    });
  }

  return checks;
}

function gatherRunLogChecks(dir: string): DoctorCheck[] {
  let stateDir = ".agent";
  try {
    stateDir = loadConfig(dir).stateDir;
  } catch {
    return [];
  }
  const metrics = loadRunMetrics(dir, stateDir, 24);
  if (metrics.runs === 0) {
    return [{ name: "run log tokens", ok: true, detail: "no runs in last 24h" }];
  }
  const hasTokens = metrics.inputTokens > 0 || metrics.outputTokens > 0;
  return [
    {
      name: "run log tokens",
      ok: hasTokens,
      detail: hasTokens
        ? `tokens in/out ${metrics.inputTokens}/${metrics.outputTokens} (${metrics.runs} runs 24h)`
        : `${metrics.runs} run(s) in 24h with null token fields — SDK usage may not be captured (I-33)`,
    },
  ];
}

function gatherDoctorSecretFormatChecks(dir: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const api = resolveApiKey(dir);
  if (api.key) {
    const fmt = validateCursorApiKeyFormat(api.key);
    checks.push({
      name: "CURSOR_API_KEY format",
      ok: fmt.ok,
      detail: fmt.ok
        ? `ok (${api.key.length} chars, ${apiKeySourceLabel(api.source, dir)})`
        : `${fmt.detail} — ${apiKeySourceLabel(api.source, dir)}`,
    });
  }
  const tg = resolveTelegramBotToken(dir);
  if (tg.value) {
    const fmt = validateTelegramBotTokenFormat(tg.value);
    checks.push({
      name: "TELEGRAM_BOT_TOKEN format",
      ok: fmt.ok,
      detail: fmt.ok
        ? `ok (${tg.value.length} chars, ${telegramTokenSourceLabel(tg.source, dir)})`
        : `${fmt.detail} — ${telegramTokenSourceLabel(tg.source, dir)}`,
    });
  }
  // claude-agent engine credentials (I-145 — pgcrypto parity with cursor/telegram).
  const anthropic = resolveAnthropicKey(dir);
  if (anthropic.key) {
    const fmt = validateAnthropicApiKeyFormat(anthropic.key);
    checks.push({
      name: "ANTHROPIC_API_KEY format",
      ok: fmt.ok,
      detail: fmt.ok
        ? `ok (${anthropic.key.length} chars, ${anthropic.source})`
        : `${fmt.detail} — ${anthropic.source}`,
    });
  }
  const oauth = resolveClaudeOAuthToken(dir);
  if (oauth.key) {
    const fmt = validateClaudeOAuthTokenFormat(oauth.key);
    checks.push({
      name: "CLAUDE_CODE_OAUTH_TOKEN format",
      ok: fmt.ok,
      detail: fmt.ok
        ? `ok (${oauth.key.length} chars, ${oauth.source})`
        : `${fmt.detail} — ${oauth.source}`,
    });
  }
  return checks;
}

function gatherCredentialsEnvChecks(dir: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const pg = pgUrl();
  const key = secretsKey();
  if (pg && !key) {
    checks.push({
      name: "credentials store",
      ok: true,
      detail: `plaintext ${loadConfig(dir).stateDir}/credentials.json (set ${SECRETS_KEY_ENV} for pgcrypto)`,
    });
    return checks;
  }
  if (pg && key) {
    const plain = hasPlaintextCredentialsOnDisk(dir);
    checks.push({
      name: "credentials plaintext",
      ok: !plain,
      detail: plain
        ? "credentials.json still has plaintext — run auth login to migrate"
        : "no plaintext secrets on disk",
      fix: 'printf %s "cursor_..." | irida auth login --stdin  # re-save migrates to pgcrypto',
    });
    const weak = secretsKeyStrengthIssue();
    checks.push({
      name: "secrets key strength",
      ok: !weak,
      detail: weak ?? `${SECRETS_KEY_ENV} length ok`,
      fix: weak ? `export ${SECRETS_KEY_ENV}="$(openssl rand -base64 32)"  # then re-save secrets` : undefined,
    });
  }
  return checks;
}

function gatherBrowserEnvChecks(dir: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  let cfg;
  try {
    cfg = loadConfig(dir);
  } catch {
    return checks;
  }
  if (!browserMcpEnabled(cfg)) return checks;

  const browserRoot = resolveBrowserRoot(dir);
  let writable = true;
  try {
    accessSync(existsSync(browserRoot) ? browserRoot : resolveMemoryRoot(dir), constants.W_OK);
  } catch {
    writable = false;
  }
  checks.push({
    name: "browser profile",
    ok: writable,
    detail: writable
      ? `${browserRoot} (profile=${cfg.browser?.profile || "default"})`
      : `${browserRoot} not writable`,
  });
  return checks;
}

function gatherMemoryEnvChecks(dir: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const pg = pgUrl();
  const home = iridaHome();
  const canonical = resolveMemoryRoot(dir);

  checks.push({
    name: "memory root",
    ok: true,
    detail: `${canonical}/memory`,
  });

  if (pg && !home) {
    checks.push({
      name: "memory env",
      ok: false,
      detail: "CSAGENT_DATABASE_URL set without CSAGENT_HOME — dev may read a different silo than gateway",
    });
  }

  const { canonical: memoryDir, silos } = gatherMemorySilos(dir);
  for (const silo of silos) {
    const aligned = siloIsAligned(silo.path, memoryDir);
    checks.push({
      name: silo.label === "repo" ? "memory silo" : `memory silo (${silo.label})`,
      ok: aligned,
      detail: aligned
        ? `${silo.path} aligned with ${memoryDir}`
        : `${silo.count} note(s) in ${silo.path} — run: irida memory align-silo`,
      fix: "irida memory align-silo",
    });
  }

  try {
    const cfg = loadConfig(dir);
    const ar = cfg.memory?.autoRag;
    if (ar?.enabled) {
      const wings = ar.wings ?? [];
      const hasMeta = wings.includes("meta");
      checks.push({
        name: "autoRag",
        ok: !hasMeta,
        detail: hasMeta
          ? "wings includes meta — use preTurn for profiles, not autoRag"
          : `enabled · limit=${ar.limit ?? 3} · wings=${wings.length ? wings.join(",") : "all"}`,
        fix: hasMeta ? 'remove "meta" from memory.autoRag.wings or set enabled: false' : undefined,
      });
    } else {
      checks.push({
        name: "autoRag",
        ok: true,
        detail: "disabled (MCP-first); pilot: deploy/PERSONAL-OPS.md#autorag-pilot",
      });
    }
  } catch {
    /* config check reported separately */
  }

  return checks;
}

function gatherGatewaySkillsChecks(dir: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const gwPath = gatewayConfigPath(dir);
  if (!existsSync(gwPath)) return checks;
  try {
    const gw = loadGatewayConfig(dir);
    const cfg = loadConfig(dir);
    const skillsRoot = resolveSkillsRoot(dir, cfg.skillsPath);
    const bundled = listSkills(dir, cfg.skillsPath);
    const rootOk = existsSync(skillsRoot) && bundled.length > 0;
    checks.push({
      name: "skills root",
      ok: rootOk,
      detail: rootOk
        ? `${skillsRoot} (${bundled.length} bundled)`
        : `${skillsRoot} missing or empty — run deploy/setup-home.sh`,
      fix: rootOk ? undefined : "bash deploy/setup-home.sh",
    });

    if (gw.skills.length === 0) return checks;

    const missing = gw.skills.filter((s) => !skillExists(dir, cfg.skillsPath, s));
    checks.push({
      name: "gateway skills",
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `${gw.skills.length} at ${skillsRoot}: ${gw.skills.join(", ")}`
          : `missing at ${skillsRoot}: ${missing.join(", ")}`,
      fix: missing.length === 0 ? undefined : "bash deploy/setup-home.sh",
    });
    const allowUnsafe = cfg.skillPolicy?.allowUnsafe ?? [];
    const threatFails: string[] = [];
    for (const name of gw.skills) {
      try {
        const skill = loadSkill(dir, cfg.skillsPath, name, { allowUnsafe });
        const hits = scanSkillThreat(skill, allowUnsafe);
        if (hits.length) threatFails.push(name);
      } catch (e) {
        threatFails.push(`${name} (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    checks.push({
      name: "skills threat scan",
      ok: threatFails.length === 0,
      detail:
        threatFails.length === 0
          ? `${gw.skills.length} skill(s) ok at ${skillsRoot}`
          : `FAIL at ${skillsRoot}: ${threatFails.join(", ")}`,
    });
  } catch {
    /* gateway parse errors surfaced elsewhere */
  }
  return checks;
}

export function doctorAllOk(checks: DoctorCheck[]): boolean {
  return checks.every((c) => c.ok);
}

export type ModelsListFn = (opts: { apiKey: string }) => Promise<Array<{ id?: string }>>;

export async function gatherDoctorStoreChecks(dir: string = process.cwd()): Promise<DoctorCheck[]> {
  const url = pgUrl();
  const checks: DoctorCheck[] = [];
  if (!url) {
    checks.push({ name: "store", ok: true, detail: "sqlite (CSAGENT_DATABASE_URL unset)" });
  } else {
    const probe = await probePostgresStore(url);
    checks.push({ name: "CSAGENT_DATABASE_URL", ok: probe.ok, detail: probe.detail });
    if (pgSecretsEnabled()) {
      const cred = await probePgCredentialStore(url, secretsKey());
      checks.push({ name: "credential_secrets", ok: cred.ok, detail: cred.detail });
      const allow = await probePgGatewayAllowlist(url, secretsKey());
      checks.push({ name: "gateway allowlist", ok: allow.ok, detail: allow.detail });
    }
  }

  await warmGatewayAllowlistCache(dir);
  const gwPath = gatewayConfigPath(dir);
  if (existsSync(gwPath) && pgSecretsEnabled()) {
    if (hasPlaintextGatewayAllowlist(dir)) {
      checks.push({
        name: "gateway allowlist plaintext",
        ok: false,
        detail: "allowedChatIds still in gateway.json — should migrate to postgres",
        fix: "irida gateway run  # auto-migrates, or clear allowedChatIds and set allowedChatIdsStorage: pg",
      });
    }
    try {
      const cfg = loadGatewayConfig(dir);
      const resolved = resolveAllowedChatIds(cfg, dir);
      const testIds = gatewayAllowlistHasTestIds(resolved);
      if (testIds.length > 0) {
        checks.push({
          name: "gateway allowlist sanity",
          ok: false,
          detail: `test chat id(s) in allowlist: ${testIds.join(", ")}`,
          fix: "remove test ids from postgres gateway_allowed_chats or restore prod chat ids",
        });
      } else if (resolved.length === 0 && pgAllowlistCacheReady()) {
        checks.push({
          name: "gateway allowlist sanity",
          ok: false,
          detail: "postgres allowlist empty",
          fix: "irida gateway peers add <chatId> or restore gateway.json then gateway run",
        });
      } else if (resolved.length > 0) {
        checks.push({
          name: "gateway allowlist sanity",
          ok: true,
          detail: `${resolved.length} peer(s) (${pgAllowlistCacheReady() ? "postgres" : "file"})`,
        });
      }
    } catch {
      /* gateway.json parse errors covered by gateway check */
    }
  }

  const store = createMemoryStore(dir);
  try {
    const malformed = await store.countMalformedSubjectFacts();
    checks.push({
      name: "fact hygiene",
      ok: malformed === 0,
      detail:
        malformed === 0
          ? "no malformed --* fact fields"
          : `${malformed} fact(s) with subject/predicate starting with "--"`,
      fix: "irida memory fact purge-malformed-subjects",
    });
  } catch (e) {
    checks.push({
      name: "fact hygiene",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  } finally {
    await store.close();
  }

  return checks;
}

/** Tier-1 Cursor API probe (models list). Skipped when key is unset. */
export async function gatherDoctorApiChecks(
  dir: string = process.cwd(),
  deps?: { listModels?: ModelsListFn }
): Promise<DoctorCheck[]> {
  void dir;
  const resolved = resolveApiKey(dir);
  const key = resolved.key;
  if (!key) return [];

  const listModels =
    deps?.listModels ??
    (async (opts: { apiKey: string }) => {
      const { Cursor } = await import("@cursor/sdk");
      return Cursor.models.list(opts);
    });

  try {
    const list = await listModels({ apiKey: key });
    const count = list.filter((m) => typeof m.id === "string" && m.id.trim()).length;
    if (count === 0) {
      return [{ name: "Cursor API (models)", ok: false, detail: "empty model list" }];
    }
    return [{ name: "Cursor API (models)", ok: true, detail: `${count} model(s) visible` }];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const lower = msg.toLowerCase();
    const detail =
      lower.includes("fetch") || lower.includes("network") || lower.includes("econnrefused")
        ? `network error — ${msg}`
        : msg.includes("Authentication") || lower.includes("unauthenticated") || lower.includes("not logged in")
          ? `authentication failed — refresh CURSOR_API_KEY in Cursor Integrations`
          : msg;
    return [{ name: "Cursor API (models)", ok: false, detail }];
  }
}

const TELEGRAM_ALLOWED_UPDATES_FIX =
  "gateway getUpdates must include message — see deploy/PERSONAL-OPS.md (inbound silent / allowed_updates)";

/** Telegram Bot API global filter must include private/group messages (I-83). */
export async function gatherDoctorTelegramChecks(dir: string = process.cwd()): Promise<DoctorCheck[]> {
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
      fix: TELEGRAM_ALLOWED_UPDATES_FIX,
    },
  ];
}

/**
 * Embedding service reachability (I-172).
 *
 * `makeEmbedder` fails soft by design — a dead service returns `null` and the turn
 * carries on without memory. That is right for a chat turn and wrong for diagnosis:
 * on 2026-07-26 the embedder was down for hours and nothing said so, because the one
 * place that would have noticed swallows the reason on purpose.
 *
 * This probe does a real round-trip rather than a liveness ping. A `/healthz` 200
 * only proves the process is up; an embedder serving a DIFFERENT model answers 200
 * with a vector of the wrong width, which silently poisons a corpus whose stored
 * vectors were built at 768 dims — a failure that liveness can never catch.
 */
export async function gatherDoctorEmbedderChecks(
  dir: string = process.cwd(),
  fetchFn: typeof fetch = fetch
): Promise<DoctorCheck[]> {
  let embCfg;
  try {
    embCfg = loadConfig(dir).memory?.embeddings;
  } catch {
    return [];
  }
  if (!embeddingsEnabled(embCfg)) {
    return [{ name: "embeddings", ok: true, detail: "disabled (memory.embeddings.enabled != true)" }];
  }

  const url = (embCfg?.url ?? EMBEDDINGS_DEFAULT_URL).replace(/\/$/, "");
  const provider = embCfg?.provider ?? "ollama";
  const endpoint = provider === "embed-service" ? `${url}/embed` : `${url}/api/embeddings`;
  const payload =
    provider === "embed-service"
      ? { text: "doctor probe" }
      : { model: embCfg?.model ?? EMBEDDINGS_DEFAULT_MODEL, prompt: "doctor probe" };
  const fix =
    provider === "embed-service"
      ? "docker compose -f deploy/docker-compose.irida.yml up -d embedder  # then: docker logs irida-embedder"
      : `check the embeddings service at ${url}`;

  try {
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DOCTOR_EMBED_TIMEOUT_MS),
    });
    if (!res.ok) {
      return [{ name: "embeddings", ok: false, detail: `${provider} ${url} → HTTP ${res.status}`, fix }];
    }
    const body = (await res.json()) as { embedding?: unknown; vector?: unknown };
    const vec = provider === "embed-service" ? body.vector : body.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      return [{ name: "embeddings", ok: false, detail: `${provider} ${url} → no vector in response`, fix }];
    }
    if (vec.length !== EMBEDDINGS_DIM) {
      return [
        {
          name: "embeddings",
          ok: false,
          detail: `${provider} ${url} → ${vec.length}-dim, expected ${EMBEDDINGS_DIM} — stored vectors were built with a different model`,
          fix: "align memory.embeddings.model with the deployed service, then reindex",
        },
      ];
    }
    return [{ name: "embeddings", ok: true, detail: `${provider} ${url} → ${vec.length}-dim ok` }];
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return [{ name: "embeddings", ok: false, detail: `${provider} ${url} unreachable — ${why}`, fix }];
  }
}
