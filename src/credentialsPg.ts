/**
 * Postgres credential store — pgp_sym_encrypt / pgp_sym_decrypt (pgcrypto).
 * Active when CSAGENT_DATABASE_URL and CSAGENT_SECRETS_KEY are both set.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { acquirePgPool, pgConfigured, pgConnectionString, releasePgPool } from "./pg/pool.js";
import { runPgMigrations } from "./pg/migrations.js";
import { dualEnv } from "./env.js";

/** Canonical secrets-key env var. The legacy CSAGENT_SECRETS_KEY is still read via dualEnv. */
export const SECRETS_KEY_ENV = "IRIDA_SECRETS_KEY";

export const CREDENTIAL_SECRET_NAMES = [
  "cursor_api_key",
  "telegram_bot_token",
  "anthropic_api_key",
  "claude_code_oauth_token",
  "openai_api_key",
] as const;
export type CredentialSecretName = (typeof CREDENTIAL_SECRET_NAMES)[number];

const CREDENTIALS_MIGRATION = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../deploy/postgres/migrations/004_credentials.sql"),
  "utf8"
);
// (Full schema comes from the tracked runner — src/pg/migrations.ts, I-141.
// CREDENTIALS_MIGRATION above stays for the standalone doctor probe pool.)

let pool: pg.Pool | null = null;

export function pgSecretsEnabled(): boolean {
  return pgConfigured() && Boolean(secretsKey());
}

export function secretsKey(): string {
  return dualEnv("SECRETS_KEY") ?? ""; // IRIDA_SECRETS_KEY, legacy CSAGENT_SECRETS_KEY
}

/** Minimum acceptable length for the pgcrypto passphrase (brute-force floor). */
export const SECRETS_KEY_MIN_LENGTH = 24;

/**
 * Returns a warning string when the configured key is too weak, else null.
 * pgcrypto treats the key as a passphrase and derives it with a low-iteration
 * s2k — a short key makes the ciphertext at rest cheaply brute-forceable.
 */
export function secretsKeyStrengthIssue(): string | null {
  const key = secretsKey();
  if (!key) return null;
  if (key.length < SECRETS_KEY_MIN_LENGTH) {
    return `${SECRETS_KEY_ENV} is only ${key.length} chars — use >= ${SECRETS_KEY_MIN_LENGTH} (e.g. openssl rand -base64 32)`;
  }
  return null;
}

function getPool(): pg.Pool {
  if (!pool) {
    pool = acquirePgPool(pgConnectionString());
  }
  return pool;
}

let migrated = false;

async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  await runPgMigrations(getPool(), pgConnectionString());
  migrated = true;
}

export async function loadPgCredentialSecrets(): Promise<Partial<Record<CredentialSecretName, string>>> {
  if (!pgSecretsEnabled()) return {};
  const key = secretsKey();
  await ensureMigrated();
  const res = await getPool().query(
    `SELECT name, pgp_sym_decrypt(ciphertext, $1) AS value
     FROM credential_secrets`,
    [key]
  );
  const out: Partial<Record<CredentialSecretName, string>> = {};
  for (const row of res.rows as Array<{ name: string; value: string | null }>) {
    const name = row.name as CredentialSecretName;
    const value = typeof row.value === "string" ? row.value.trim() : "";
    if (value) out[name] = value;
  }
  return out;
}

export async function setPgCredentialSecret(name: CredentialSecretName, value: string): Promise<void> {
  if (!pgSecretsEnabled()) {
    throw new Error(`${SECRETS_KEY_ENV} and CSAGENT_DATABASE_URL required for postgres credential store`);
  }
  // Enforce on WRITE (I-142): a weak passphrase makes every ciphertext at rest
  // cheaply brute-forceable — a warning alone let it through (audit H-13).
  const weak = secretsKeyStrengthIssue();
  if (weak) throw new Error(`refusing to store secret with a weak key: ${weak}`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error("secret value must be non-empty");
  const key = secretsKey();
  await ensureMigrated();
  // Archive the previous ciphertext before overwriting — a bad login (dev
  // clone on prod PG, truncated stdin) must be reversible via auth restore.
  await getPool().query(
    `INSERT INTO credential_secrets_history (name, ciphertext)
     SELECT name, ciphertext FROM credential_secrets WHERE name = $1`,
    [name]
  );
  await getPool().query(
    `INSERT INTO credential_secrets (name, ciphertext, updated_at)
     VALUES ($1, pgp_sym_encrypt($2, $3), NOW())
     ON CONFLICT (name) DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext,
       updated_at = EXCLUDED.updated_at`,
    [name, trimmed, key]
  );
}

export interface CredentialHistoryEntry {
  id: number;
  name: string;
  replaced_at: string;
  /** Decrypted length only — values never leave this module via history list. */
  valueLength: number;
  formatOk: boolean;
}

/** List archived secret versions (newest first); never returns values. */
export async function listPgCredentialHistory(
  validate: (name: CredentialSecretName, value: string) => boolean
): Promise<CredentialHistoryEntry[]> {
  if (!pgSecretsEnabled()) return [];
  await ensureMigrated();
  const res = await getPool().query(
    `SELECT id, name, replaced_at, pgp_sym_decrypt(ciphertext, $1) AS value
     FROM credential_secrets_history
     ORDER BY replaced_at DESC
     LIMIT 20`,
    [secretsKey()]
  );
  return (res.rows as Array<{ id: number; name: string; replaced_at: Date; value: string | null }>).map(
    (r) => ({
      id: Number(r.id),
      name: r.name,
      replaced_at: r.replaced_at.toISOString(),
      valueLength: (r.value ?? "").length,
      formatOk: validate(r.name as CredentialSecretName, r.value ?? ""),
    })
  );
}

/** Read one archived value by history id (for auth restore). */
export async function readPgCredentialHistoryValue(id: number): Promise<{ name: CredentialSecretName; value: string } | null> {
  if (!pgSecretsEnabled()) return null;
  await ensureMigrated();
  const res = await getPool().query(
    `SELECT name, pgp_sym_decrypt(ciphertext, $1) AS value
     FROM credential_secrets_history WHERE id = $2`,
    [secretsKey(), id]
  );
  const row = res.rows[0] as { name: string; value: string | null } | undefined;
  if (!row || !row.value) return null;
  return { name: row.name as CredentialSecretName, value: row.value };
}

export async function deletePgCredentialSecret(name: CredentialSecretName): Promise<boolean> {
  if (!pgSecretsEnabled()) return false;
  await ensureMigrated();
  const res = await getPool().query(`DELETE FROM credential_secrets WHERE name = $1`, [name]);
  return (res.rowCount ?? 0) > 0;
}

export async function clearPgCredentialSecrets(): Promise<number> {
  if (!pgSecretsEnabled()) return 0;
  await ensureMigrated();
  const res = await getPool().query(`DELETE FROM credential_secrets`);
  return res.rowCount ?? 0;
}

export async function probePgCredentialStore(
  databaseUrl: string,
  secretsKeyValue: string
): Promise<{ ok: boolean; detail: string }> {
  const key = secretsKeyValue.trim();
  if (!key) return { ok: false, detail: `${SECRETS_KEY_ENV} empty` };
  const probePool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await probePool.query(CREDENTIALS_MIGRATION);
    const roundtrip = await probePool.query(
      `SELECT pgp_sym_decrypt(pgp_sym_encrypt($1, $2), $2) AS value`,
      ["probe", key]
    );
    const got = (roundtrip.rows[0] as { value?: string } | undefined)?.value;
    if (got !== "probe") {
      return { ok: false, detail: "pgcrypto roundtrip failed" };
    }
    return { ok: true, detail: "credential_secrets + pgcrypto ok" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    await probePool.end();
  }
}

/** Re-exported for back-compat; the implementation lives in pg/pool.ts (Arch-1). */
export { probePgReachable } from "./pg/pool.js";

export async function closePgCredentialPool(): Promise<void> {
  if (!pool) return;
  await releasePgPool(pgConnectionString());
  pool = null;
  migrated = false;
}
