/**
 * `irida auth` — store secrets locally (chmod 600, gitignored .agent/credentials.json).
 */
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import {
  API_KEY_HELP,
  TELEGRAM_TOKEN_HELP,
  apiKeySourceLabel,
  clearAnthropicApiKey,
  clearOpenAiApiKey,
  clearClaudeOAuthToken,
  resolveAnthropicKey,
  resolveClaudeOAuthToken,
  resolveClaudeOAuthTokenPool,
  addClaudeOAuthTokenToPool,
  removeClaudeOAuthTokenFromPool,
  useClaudeOAuthTokenInPool,
  saveAnthropicApiKey,
  saveOpenAiApiKey,
  saveClaudeOAuthToken,
  clearAllStoredCredentials,
  clearStoredTelegramToken,
  credentialsPath,
  hasStoredCredentials,
  hasStoredTelegramToken,
  persistAnthropicApiKey,
  persistOpenAiApiKey,
  persistClaudeOAuthToken,
  persistCursorApiKey,
  persistTelegramBotToken,
  pgSecretsEnabled,
  resolveApiKey,
  resolveTelegramBotToken,
  saveCredentials,
  saveTelegramBotToken,
  telegramTokenSourceLabel,
  validateAnthropicApiKeyFormat,
  validateOpenAiApiKeyFormat,
  validateClaudeOAuthTokenFormat,
  validateCursorApiKeyFormat,
  validateTelegramBotTokenFormat,
  warmCredentialsCache,
} from "./credentials.js";
import { deletePgCredentialSecret, listPgCredentialHistory, readPgCredentialHistoryValue } from "./credentialsPg.js";
import type { CredentialSecretName } from "./credentialsPg.js";
import { EXIT, type ExitCode } from "./exit.js";

const AUTH_HELP = `irida auth — local secrets storage (.agent/credentials.json or postgres pgcrypto)

Usage:
  irida auth login --stdin              Cursor API key (stdin or prompt)
  irida auth login --from-env           copy CURSOR_API_KEY from environment to file
  irida auth anthropic login --stdin    Anthropic API key (claude-agent engine, auth=api-key)
  irida auth anthropic logout           remove stored Anthropic API key
  irida auth claude token --stdin       Claude OAuth token from \`claude setup-token\` (auth=account)
  irida auth claude token-add --stdin   add another account to the pool (I-169 failover)
  irida auth claude token-list          show pool + active/invalid status
  irida auth claude token-use <id>      make this token active
  irida auth claude token-remove <id>   drop one from the pool
  irida auth claude logout              remove all stored Claude OAuth token(s)
  irida auth openai login --stdin       OpenAI API key (codex engine, auth=api-key)
  irida auth openai logout              remove stored OpenAI API key
                                        (codex auth=account needs none — run \`codex login\`)
  irida auth telegram login --stdin     Telegram bot token
  irida auth telegram login --from-env  copy TELEGRAM_BOT_TOKEN from environment
  irida auth logout                     remove stored secrets
  irida auth telegram logout            remove telegram token only
  irida auth status                     key + telegram configured? (never prints secrets)
  irida auth history                    archived secret versions in postgres (no values)
  irida auth restore <id>               restore an archived version by history id

Environment overrides stored secrets for both CURSOR_API_KEY and TELEGRAM_BOT_TOKEN.
With CSAGENT_DATABASE_URL + CSAGENT_SECRETS_KEY, secrets are encrypted in Postgres (pgcrypto).
`;

async function readStdinLine(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      data += chunk;
    });
    input.on("end", () => resolve(data.trim()));
    input.on("error", reject);
    if (input.isPaused()) input.resume();
  });
}

async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });
  } finally {
    rl.close();
  }
}

/** Read a secret from --from-env / --stdin / inline arg. */
async function readSecretArg(
  rest: string[],
  envName: string,
  label: string
): Promise<{ value: string } | { error: ExitCode }> {
  const fromEnv = rest.includes("--from-env");
  const useStdin = rest.includes("--stdin") || (!fromEnv && rest.length === 0);
  const inline = rest.find((a) => !a.startsWith("--"));
  let value = "";
  if (fromEnv) {
    value = (process.env[envName] ?? "").trim();
    if (!value) {
      console.error(`${label}: ${envName} is not set in the environment`);
      return { error: EXIT.config };
    }
  } else if (useStdin && !inline) {
    value = input.isTTY ? await promptLine(`${label}: `) : await readStdinLine();
  } else if (inline) {
    value = inline.trim();
  } else {
    console.error(`${label}: provide --stdin, --from-env, or a value argument`);
    return { error: EXIT.usage };
  }
  if (!value) {
    console.error(`${label}: empty value`);
    return { error: EXIT.usage };
  }
  return { value };
}

/** `irida auth anthropic …` — Anthropic API key for the claude-agent engine (auth=api-key). */
async function cmdAuthAnthropic(args: string[], dir: string): Promise<ExitCode> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "login": {
      const r = await readSecretArg(rest, "ANTHROPIC_API_KEY", "auth anthropic login");
      if ("error" in r) return r.error;
      if (pgSecretsEnabled()) await persistAnthropicApiKey(r.value, dir);
      else saveAnthropicApiKey(r.value, dir);
      console.log(
        pgSecretsEnabled()
          ? "auth: anthropic API key saved (postgres credential_secrets, pgcrypto)"
          : `auth: anthropic API key saved to ${credentialsPath(dir)} (mode 600)`
      );
      return EXIT.ok;
    }
    case "logout": {
      let removed = clearAnthropicApiKey(dir);
      if (pgSecretsEnabled()) {
        removed = (await deletePgCredentialSecret("anthropic_api_key")) || removed;
      }
      console.log(removed ? "auth: anthropic API key removed" : "auth: no stored anthropic API key");
      return EXIT.ok;
    }
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(AUTH_HELP);
      return EXIT.ok;
    default:
      console.error(`auth anthropic: unknown subcommand '${sub}'\n\n${AUTH_HELP}`);
      return EXIT.usage;
  }
}

/**
 * `irida auth openai …` — OpenAI API key for the codex engine (auth=api-key).
 * Account mode needs nothing here: `codex login` owns that session on disk.
 */
async function cmdAuthOpenAi(args: string[], dir: string): Promise<ExitCode> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "login": {
      const r = await readSecretArg(rest, "OPENAI_API_KEY", "auth openai login");
      if ("error" in r) return r.error;
      if (pgSecretsEnabled()) await persistOpenAiApiKey(r.value, dir);
      else saveOpenAiApiKey(r.value, dir);
      console.log(
        pgSecretsEnabled()
          ? "auth: openai API key saved (postgres credential_secrets, pgcrypto)"
          : `auth: openai API key saved to ${credentialsPath(dir)} (mode 600)`
      );
      return EXIT.ok;
    }
    case "logout": {
      let removed = clearOpenAiApiKey(dir);
      if (pgSecretsEnabled()) {
        removed = (await deletePgCredentialSecret("openai_api_key")) || removed;
      }
      console.log(removed ? "auth: openai API key removed" : "auth: no stored openai API key");
      return EXIT.ok;
    }
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(AUTH_HELP);
      return EXIT.ok;
    default:
      console.error(`auth openai: unknown subcommand '${sub}'\n\n${AUTH_HELP}`);
      return EXIT.usage;
  }
}

/** first 10 + last 4 chars — enough to tell tokens apart without exposing the secret. */
function maskToken(token: string): string {
  if (token.length <= 18) return `${token.slice(0, 4)}…`;
  return `${token.slice(0, 10)}…${token.slice(-4)}`;
}

/** `irida auth claude …` — Claude account OAuth token(s) for the claude-agent engine (auth=account). */
async function cmdAuthClaude(args: string[], dir: string): Promise<ExitCode> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "token": {
      // Bare `token --stdin` replaces the WHOLE pool with a single entry — kept
      // for backward compat with pre-I-169 single-token installs/scripts. Use
      // `token add` to grow a multi-account pool instead.
      const r = await readSecretArg(rest, "CLAUDE_CODE_OAUTH_TOKEN", "auth claude token");
      if ("error" in r) return r.error;
      if (pgSecretsEnabled()) await persistClaudeOAuthToken(r.value, dir);
      else saveClaudeOAuthToken(r.value, dir);
      console.log(
        pgSecretsEnabled()
          ? "auth: claude OAuth token saved (postgres credential_secrets, pgcrypto)"
          : `auth: claude OAuth token saved to ${credentialsPath(dir)} (mode 600)`
      );
      return EXIT.ok;
    }
    case "token-add": {
      const labelFlag = rest.indexOf("--label");
      let label: string | undefined;
      let restArgs = rest;
      if (labelFlag >= 0) {
        label = rest[labelFlag + 1];
        restArgs = rest.filter((_, i) => i !== labelFlag && i !== labelFlag + 1);
        // Guard against `--label <the-actual-token>` — an easy mistake (the
        // token ends up stored as a plaintext-ish label instead of the secret
        // field, and --stdin/inline never receives a real value). Labels are
        // short human names; anything token-shaped is almost certainly a
        // misplaced secret, not a label.
        if (label && (label.length > 40 || /^sk-/i.test(label))) {
          console.error(
            "auth claude token-add: --label value looks like a secret token, not a label.\n" +
              "Usage: irida auth claude token-add <token> --label <short-name>\n" +
              "   or: irida auth claude token-add --stdin --label <short-name>   (then paste the token when prompted)"
          );
          return EXIT.usage;
        }
      }
      const r = await readSecretArg(restArgs, "CLAUDE_CODE_OAUTH_TOKEN", "auth claude token-add");
      if ("error" in r) return r.error;
      try {
        const { id } = await addClaudeOAuthTokenToPool(r.value, dir, label);
        console.log(`auth: claude OAuth token added to pool — id=${id}${label ? ` label=${label}` : ""}`);
        return EXIT.ok;
      } catch (e) {
        console.error(`auth claude token-add: ${e instanceof Error ? e.message : String(e)}`);
        return EXIT.usage;
      }
    }
    case "token-list": {
      await warmCredentialsCache(dir);
      const { pool, source } = resolveClaudeOAuthTokenPool(dir);
      if (!pool.length) {
        console.log("auth: no claude OAuth tokens stored");
        return EXIT.ok;
      }
      console.log(`auth: claude OAuth token pool (source=${source})`);
      console.log("ACTIVE  ID        LABEL              TOKEN                 STATUS");
      let sawActive = false;
      for (const e of pool) {
        const isActive = !sawActive && !e.invalidAt;
        if (isActive) sawActive = true;
        const status = e.invalidAt ? `invalid since ${e.invalidAt.slice(0, 19).replace("T", " ")}` : "ok";
        console.log(
          `${(isActive ? "*" : " ").padEnd(7)} ${e.id.padEnd(9)} ${(e.label ?? "").padEnd(18)} ${maskToken(e.token).padEnd(21)} ${status}`
        );
      }
      if (!sawActive) {
        console.log("\nauth: WARNING — every pooled token is marked invalid; add a fresh one or `token-use <id>`");
      }
      return EXIT.ok;
    }
    case "token-remove": {
      const id = rest[0];
      if (!id) {
        console.error("auth claude token-remove: usage — irida auth claude token-remove <id> (see token-list)");
        return EXIT.usage;
      }
      try {
        const removed = await removeClaudeOAuthTokenFromPool(id, dir);
        console.log(removed ? `auth: removed token ${id}` : `auth: no token with id ${id}`);
        return EXIT.ok;
      } catch (e) {
        console.error(`auth claude token-remove: ${e instanceof Error ? e.message : String(e)}`);
        return EXIT.usage;
      }
    }
    case "token-use": {
      const id = rest[0];
      if (!id) {
        console.error("auth claude token-use: usage — irida auth claude token-use <id> (see token-list)");
        return EXIT.usage;
      }
      const used = await useClaudeOAuthTokenInPool(id, dir);
      console.log(used ? `auth: token ${id} is now active` : `auth: no token with id ${id}`);
      return used ? EXIT.ok : EXIT.usage;
    }
    case "logout": {
      let removed = clearClaudeOAuthToken(dir);
      if (pgSecretsEnabled()) {
        removed = (await deletePgCredentialSecret("claude_code_oauth_token")) || removed;
      }
      console.log(removed ? "auth: claude OAuth token(s) removed" : "auth: no stored claude OAuth token");
      return EXIT.ok;
    }
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(
        "To connect your Claude account: run `claude setup-token` then `irida auth claude token --stdin`,\n" +
          "or run `claude login` (the Agent SDK reads the keychain / ~/.claude/.credentials.json).\n\n" +
          "Multiple accounts (I-169) — automatic failover when one hits an auth error:\n" +
          "  irida auth claude token-add --stdin [--label work]   add another account to the pool\n" +
          "  irida auth claude token-list                         show pool + active/invalid status\n" +
          "  irida auth claude token-use <id>                     make this one active, clear invalid mark\n" +
          "  irida auth claude token-remove <id>                  drop one (refuses to drop the last)\n\n" +
          AUTH_HELP
      );
      return EXIT.ok;
    default:
      console.error(`auth claude: unknown subcommand '${sub}'\n\n${AUTH_HELP}`);
      return EXIT.usage;
  }
}

async function cmdAuthTelegram(args: string[], dir: string): Promise<ExitCode> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "login": {
      const fromEnv = rest.includes("--from-env");
      const useStdin = rest.includes("--stdin") || (!fromEnv && rest.length === 0);
      const inline = rest.find((a) => !a.startsWith("--"));

      let token = "";
      if (fromEnv) {
        token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
        if (!token) {
          console.error("auth telegram login: TELEGRAM_BOT_TOKEN is not set in the environment");
          return EXIT.config;
        }
      } else if (useStdin && !inline) {
        if (input.isTTY) {
          token = await promptLine("Telegram bot token: ");
        } else {
          token = await readStdinLine();
        }
      } else if (inline) {
        token = inline.trim();
      } else {
        console.error("auth telegram login: provide --stdin, --from-env, or a token argument");
        console.error(TELEGRAM_TOKEN_HELP);
        return EXIT.usage;
      }

      if (!token) {
        console.error("auth telegram login: empty token");
        return EXIT.usage;
      }

      if (pgSecretsEnabled()) await persistTelegramBotToken(token, dir);
      else saveTelegramBotToken(token, dir);
      console.log(
        pgSecretsEnabled()
          ? "auth: telegram token saved (postgres credential_secrets, pgcrypto)"
          : `auth: telegram token saved to ${credentialsPath(dir)} (mode 600)`
      );
      return EXIT.ok;
    }
    case "logout": {
      if (await clearStoredTelegramToken(dir)) {
        console.log("auth: telegram token removed");
      } else {
        console.log("auth: no stored telegram token");
      }
      return EXIT.ok;
    }
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(AUTH_HELP);
      return EXIT.ok;
    default:
      console.error(`auth telegram: unknown subcommand '${sub}'\n\n${AUTH_HELP}`);
      return EXIT.usage;
  }
}

export async function cmdAuth(args: string[], dir: string = process.cwd()): Promise<ExitCode> {
  if (args[0] === "telegram") {
    return cmdAuthTelegram(args.slice(1), dir);
  }
  if (args[0] === "anthropic") {
    return cmdAuthAnthropic(args.slice(1), dir);
  }
  if (args[0] === "claude") {
    return cmdAuthClaude(args.slice(1), dir);
  }
  if (args[0] === "openai" || args[0] === "codex") {
    return cmdAuthOpenAi(args.slice(1), dir);
  }
  const [sub, ...rest] = args;
  switch (sub) {
    case "login": {
      const fromEnv = rest.includes("--from-env");
      const useStdin = rest.includes("--stdin") || (!fromEnv && rest.length === 0);
      const inline = rest.find((a) => !a.startsWith("--"));

      let key = "";
      if (fromEnv) {
        key = (process.env.CURSOR_API_KEY ?? "").trim();
        if (!key) {
          console.error("auth login: CURSOR_API_KEY is not set in the environment");
          return EXIT.config;
        }
      } else if (useStdin && !inline) {
        if (input.isTTY) {
          key = await promptLine("Cursor API key: ");
        } else {
          key = await readStdinLine();
        }
      } else if (inline) {
        key = inline.trim();
      } else {
        console.error("auth login: provide --stdin, --from-env, or a key argument");
        console.error(API_KEY_HELP);
        return EXIT.usage;
      }

      if (!key) {
        console.error("auth login: empty API key");
        return EXIT.usage;
      }

      if (pgSecretsEnabled()) await persistCursorApiKey(key, dir);
      else saveCredentials(key, dir);
      console.log(
        pgSecretsEnabled()
          ? "auth: cursor API key saved (postgres credential_secrets, pgcrypto)"
          : `auth: saved to ${credentialsPath(dir)} (mode 600)`
      );
      return EXIT.ok;
    }
    case "logout": {
      if (await clearAllStoredCredentials(dir)) {
        console.log("auth: credentials removed");
      } else {
        console.log("auth: no stored credentials");
      }
      return EXIT.ok;
    }
    case "status": {
      await warmCredentialsCache(dir);
      const api = resolveApiKey(dir);
      const tg = resolveTelegramBotToken(dir);
      console.log(
        `auth: CURSOR_API_KEY — ${api.source === "none" ? "not configured" : apiKeySourceLabel(api.source, dir)}`
      );
      console.log(`auth: TELEGRAM_BOT_TOKEN — ${telegramTokenSourceLabel(tg.source, dir)}`);
      const ant = resolveAnthropicKey(dir);
      const oauth = resolveClaudeOAuthToken(dir);
      const oauthPool = resolveClaudeOAuthTokenPool(dir);
      console.log(
        `auth: ANTHROPIC_API_KEY — ${ant.source === "none" ? "not configured" : `set (${ant.source})`} [claude-agent engine, auth=api-key]`
      );
      const invalidCount = oauthPool.pool.filter((e) => e.invalidAt).length;
      const poolNote =
        oauthPool.pool.length > 1
          ? ` · pool: ${oauthPool.pool.length} token(s)${invalidCount ? `, ${invalidCount} invalid` : ""} (irida auth claude token-list)`
          : "";
      console.log(
        `auth: CLAUDE_CODE_OAUTH_TOKEN — ${oauth.source === "none" ? "not configured (account mode may still use a `claude login` session)" : `set (${oauth.source})`} [claude-agent engine, auth=account]${poolNote}`
      );
      if (hasStoredCredentials(dir) && !pgSecretsEnabled()) {
        console.log(`auth: file ${credentialsPath(dir)}`);
      }
      if ((api.source === "file" || api.source === "pg") && (process.env.CURSOR_API_KEY ?? "").trim()) {
        console.log("auth: note — environment CURSOR_API_KEY overrides stored secret at runtime");
      }
      if ((tg.source === "file" || tg.source === "pg") && (process.env.TELEGRAM_BOT_TOKEN ?? "").trim()) {
        console.log("auth: note — environment TELEGRAM_BOT_TOKEN overrides stored secret at runtime");
      }
      if (api.source === "none" && tg.source === "none") {
        console.log(API_KEY_HELP);
        return EXIT.config;
      }
      return EXIT.ok;
    }
    case "history": {
      if (!pgSecretsEnabled()) {
        console.error("auth history: requires CSAGENT_DATABASE_URL + CSAGENT_SECRETS_KEY (postgres store)");
        return EXIT.config;
      }
      const entries = await listPgCredentialHistory(validateSecretFormat);
      if (entries.length === 0) {
        console.log("auth: no archived secret versions");
        return EXIT.ok;
      }
      console.log("ID    NAME                 REPLACED AT            LEN  FORMAT");
      for (const e of entries) {
        console.log(
          `${String(e.id).padEnd(5)} ${e.name.padEnd(20)} ${e.replaced_at.slice(0, 19).replace("T", " ")}  ${String(e.valueLength).padEnd(4)} ${e.formatOk ? "ok" : "INVALID"}`
        );
      }
      console.log("\nRestore a valid version: irida auth restore <id>");
      return EXIT.ok;
    }
    case "restore": {
      if (!pgSecretsEnabled()) {
        console.error("auth restore: requires CSAGENT_DATABASE_URL + CSAGENT_SECRETS_KEY (postgres store)");
        return EXIT.config;
      }
      const id = Number(rest[0]);
      if (!Number.isInteger(id) || id <= 0) {
        console.error("auth restore: usage — irida auth restore <history-id> (see auth history)");
        return EXIT.usage;
      }
      const entry = await readPgCredentialHistoryValue(id);
      if (!entry) {
        console.error(`auth restore: history id ${id} not found`);
        return EXIT.usage;
      }
      // persistSecret re-validates format and archives the current value first.
      switch (entry.name) {
        case "cursor_api_key":
          await persistCursorApiKey(entry.value, dir);
          break;
        case "telegram_bot_token":
          await persistTelegramBotToken(entry.value, dir);
          break;
        case "anthropic_api_key":
          await persistAnthropicApiKey(entry.value, dir);
          break;
        case "claude_code_oauth_token":
          await persistClaudeOAuthToken(entry.value, dir);
          break;
        case "openai_api_key":
          await persistOpenAiApiKey(entry.value, dir);
          break;
      }
      console.log(`auth: restored ${entry.name} from history #${id} (previous value archived)`);
      return EXIT.ok;
    }
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(AUTH_HELP);
      return EXIT.ok;
    default:
      console.error(`auth: unknown subcommand '${sub}'\n\n${AUTH_HELP}`);
      return EXIT.usage;
  }
}

function validateSecretFormat(name: CredentialSecretName, value: string): boolean {
  switch (name) {
    case "cursor_api_key":
      return validateCursorApiKeyFormat(value).ok;
    case "anthropic_api_key":
      return validateAnthropicApiKeyFormat(value).ok;
    case "claude_code_oauth_token":
      return validateClaudeOAuthTokenFormat(value).ok;
    case "telegram_bot_token":
      return validateTelegramBotTokenFormat(value).ok;
    case "openai_api_key":
      return validateOpenAiApiKeyFormat(value).ok;
  }
}
