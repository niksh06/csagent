/**
 * Session/run persistence: SQLite (default) or Postgres via CSAGENT_DATABASE_URL.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { acquireSharedSqliteDb, releaseSharedSqliteDb } from "./sqliteShared.js";
import { acquirePgPool, pgUrl, releasePgPool } from "./pg/pool.js";
import { runPgMigrations } from "./pg/migrations.js";
import { redact } from "./redact.js";
import { appendRunLog } from "./runLog.js";
import { nowIso } from "./util.js";

export interface SessionRecord {
  id: string;
  title: string;
  cwd: string;
  runtime: string;
  sdk_agent_id: string | null;
  created_at: string;
  updated_at: string;
  last_status: string;
  selected_skills: string;
  mcp_server_names: string;
  /** Entry channel: telegram, tui, cli, … — empty = legacy. */
  channel: string;
  /** Engine that created the session: cursor | claude-agent (I-100). Empty/absent = legacy cursor. */
  engine?: string;
}

export interface ListSessionsOptions {
  /** Only sessions with this channel, plus legacy rules below. */
  channel?: string;
  /** When channel is tui: also include unassigned ('') not in excludeIds. */
  includeUnassigned?: boolean;
  excludeIds?: string[];
}

export interface RunRecord {
  id: string;
  session_id: string;
  sdk_agent_id: string | null;
  sdk_run_id: string | null;
  prompt_preview: string;
  result_preview: string;
  status: string;
  error_kind: string | null;
  /** Redacted SDK/run failure detail (rotation debugging). */
  error_detail?: string | null;
  started_at: string;
  finished_at: string | null;
  cwd: string;
  runtime: string;
  model: string;
  /** Stream usage for the ops run log (I-33); not persisted in DB columns. */
  input_tokens?: number | null;
  output_tokens?: number | null;
  /** Cache usage for cost estimation (I-116); jsonl only. */
  cache_read_tokens?: number | null;
  cache_creation_tokens?: number | null;
  /** Run log metadata (I-68); jsonl only — not persisted in DB columns. */
  channel?: string | null;
  cron_job?: string | null;
  is_test?: boolean;
}

export interface IStore {
  upsertSession(s: {
    id: string;
    title: string;
    cwd: string;
    runtime: string;
    sdk_agent_id?: string | null;
    last_status?: string;
    selected_skills?: string;
    mcp_server_names?: string;
    channel?: string;
    /** Engine that owns the session (I-100). Empty preserves the existing value. */
    engine?: string;
  }): Promise<void>;
  recordRun(r: RunRecord): Promise<void>;
  listSessions(limit?: number, opts?: ListSessionsOptions): Promise<SessionRecord[]>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  updateSessionTitle(id: string, title: string): Promise<boolean>;
  listRuns(sessionId: string): Promise<RunRecord[]>;
  close(): Promise<void>;
}

// Schema is applied by the tracked runner (src/pg/migrations.ts, I-141) — the
// per-module hardcoded .sql lists it replaced live in git history.

function buildListSessionsSql(opts: ListSessionsOptions | undefined, limit: number): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let n = 1;
  const clauses: string[] = [];

  if (opts?.excludeIds?.length) {
    const placeholders = opts.excludeIds.map(() => `$${n++}`).join(", ");
    clauses.push(`id NOT IN (${placeholders})`);
    params.push(...opts.excludeIds);
  }

  if (opts?.channel) {
    if (opts.includeUnassigned) {
      clauses.push(`(channel = $${n++} OR channel = '')`);
      params.push(opts.channel);
    } else {
      clauses.push(`channel = $${n++}`);
      params.push(opts.channel);
    }
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit);
  const sql = `SELECT * FROM sessions ${where} ORDER BY updated_at DESC LIMIT $${n}`;
  return { sql, params };
}

function buildListSessionsSqlite(opts: ListSessionsOptions | undefined, limit: number): { sql: string; params: (string | number)[] } {
  const params: (string | number)[] = [];
  const clauses: string[] = [];

  if (opts?.excludeIds?.length) {
    clauses.push(`id NOT IN (${opts.excludeIds.map(() => "?").join(", ")})`);
    params.push(...opts.excludeIds);
  }

  if (opts?.channel) {
    if (opts.includeUnassigned) {
      clauses.push(`(channel = ? OR channel = '')`);
      params.push(opts.channel);
    } else {
      clauses.push(`channel = ?`);
      params.push(opts.channel);
    }
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit);
  return { sql: `SELECT * FROM sessions ${where} ORDER BY updated_at DESC LIMIT ?`, params };
}

/** SQLite under <stateDir>/state.sqlite (Node >= 22.5). */
export class SqliteStore implements IStore {
  private db: DatabaseSync;
  private readonly stateRoot: string;
  private closed = false;

  constructor(dir: string, stateDir: string) {
    this.stateRoot = resolve(dir, stateDir);
    mkdirSync(this.stateRoot, { recursive: true });
    this.db = acquireSharedSqliteDb(this.stateRoot);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL DEFAULT '',
        runtime TEXT NOT NULL DEFAULT 'local',
        sdk_agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_status TEXT NOT NULL DEFAULT '',
        selected_skills TEXT NOT NULL DEFAULT '',
        mcp_server_names TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sdk_agent_id TEXT,
        sdk_run_id TEXT,
        prompt_preview TEXT NOT NULL DEFAULT '',
        result_preview TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        error_kind TEXT,
        error_detail TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        cwd TEXT NOT NULL DEFAULT '',
        runtime TEXT NOT NULL DEFAULT 'local',
        model TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
    `);
    try {
      this.db.exec(`ALTER TABLE runs ADD COLUMN result_preview TEXT NOT NULL DEFAULT ''`);
    } catch {
      /* column exists */
    }
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN channel TEXT NOT NULL DEFAULT ''`);
    } catch {
      /* column exists */
    }
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel, updated_at DESC)`);
    } catch {
      /* index exists */
    }
    try {
      this.db.exec(`ALTER TABLE runs ADD COLUMN error_detail TEXT`);
    } catch {
      /* column exists */
    }
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN engine TEXT NOT NULL DEFAULT 'cursor'`);
    } catch {
      /* column exists */
    }
  }

  async upsertSession(s: Parameters<IStore["upsertSession"]>[0]): Promise<void> {
    const now = nowIso();
    const title = redact(s.title);
    this.db
      .prepare(
        `INSERT INTO sessions (id,title,cwd,runtime,sdk_agent_id,created_at,updated_at,last_status,selected_skills,mcp_server_names,channel,engine)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, cwd=excluded.cwd, runtime=excluded.runtime,
           sdk_agent_id=COALESCE(excluded.sdk_agent_id, sessions.sdk_agent_id),
           updated_at=excluded.updated_at, last_status=excluded.last_status,
           channel=CASE WHEN excluded.channel != '' THEN excluded.channel ELSE sessions.channel END,
           engine=CASE WHEN excluded.engine != '' THEN excluded.engine ELSE sessions.engine END`
      )
      .run(
        s.id,
        title,
        s.cwd,
        s.runtime,
        s.sdk_agent_id ?? null,
        now,
        now,
        s.last_status ?? "",
        s.selected_skills ?? "",
        s.mcp_server_names ?? "",
        s.channel ?? "",
        s.engine ?? ""
      );
  }

  async recordRun(r: RunRecord): Promise<void> {
    const rec = {
      ...r,
      prompt_preview: redact(r.prompt_preview),
      result_preview: redact(r.result_preview ?? ""),
      error_detail: r.error_detail ? redact(r.error_detail) : null,
    };
    this.db
      .prepare(
        `INSERT INTO runs (id,session_id,sdk_agent_id,sdk_run_id,prompt_preview,result_preview,status,error_kind,error_detail,started_at,finished_at,cwd,runtime,model)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        rec.id,
        rec.session_id,
        rec.sdk_agent_id,
        rec.sdk_run_id,
        rec.prompt_preview,
        rec.result_preview,
        rec.status,
        rec.error_kind,
        rec.error_detail,
        rec.started_at,
        rec.finished_at,
        rec.cwd,
        rec.runtime,
        rec.model
      );
  }

  async listSessions(limit = 50, opts?: ListSessionsOptions): Promise<SessionRecord[]> {
    const { sql, params } = buildListSessionsSqlite(opts, limit);
    return this.db.prepare(sql).all(...params) as unknown as SessionRecord[];
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    return this.db.prepare(`SELECT * FROM sessions WHERE id=?`).get(id) as SessionRecord | undefined;
  }

  async updateSessionTitle(id: string, title: string): Promise<boolean> {
    const row = await this.getSession(id);
    if (!row) return false;
    await this.upsertSession({
      id: row.id,
      title: redact(title.trim() || row.title),
      cwd: row.cwd,
      runtime: row.runtime,
      sdk_agent_id: row.sdk_agent_id,
      last_status: row.last_status,
      selected_skills: row.selected_skills,
      mcp_server_names: row.mcp_server_names,
      channel: row.channel ?? "",
      engine: row.engine ?? "",
    });
    return true;
  }

  async listRuns(sessionId: string): Promise<RunRecord[]> {
    return this.db
      .prepare(`SELECT * FROM runs WHERE session_id=? ORDER BY started_at`)
      .all(sessionId) as unknown as RunRecord[];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    releaseSharedSqliteDb(this.stateRoot);
  }
}

/** @deprecated use SqliteStore or createStore */
export const Store = SqliteStore;

/** Postgres backend (Phase 1). */
export class PostgresStore implements IStore {
  private readonly connectionString: string;
  private pool: pg.Pool;
  private migrated = false;
  private closed = false;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
    this.pool = acquirePgPool(connectionString);
  }

  private async ensureMigrated(): Promise<void> {
    if (this.migrated) return;
    await runPgMigrations(this.pool, this.connectionString);
    this.migrated = true;
  }

  async upsertSession(s: Parameters<IStore["upsertSession"]>[0]): Promise<void> {
    await this.ensureMigrated();
    const now = nowIso();
    const title = redact(s.title);
    await this.pool.query(
      `INSERT INTO sessions (id,title,cwd,runtime,sdk_agent_id,created_at,updated_at,last_status,selected_skills,mcp_server_names,channel,engine)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(id) DO UPDATE SET
         title=EXCLUDED.title, cwd=EXCLUDED.cwd, runtime=EXCLUDED.runtime,
         sdk_agent_id=COALESCE(EXCLUDED.sdk_agent_id, sessions.sdk_agent_id),
         updated_at=EXCLUDED.updated_at, last_status=EXCLUDED.last_status,
         channel=CASE WHEN EXCLUDED.channel != '' THEN EXCLUDED.channel ELSE sessions.channel END,
         engine=CASE WHEN EXCLUDED.engine != '' THEN EXCLUDED.engine ELSE sessions.engine END`,
      [
        s.id,
        title,
        s.cwd,
        s.runtime,
        s.sdk_agent_id ?? null,
        now,
        now,
        s.last_status ?? "",
        s.selected_skills ?? "",
        s.mcp_server_names ?? "",
        s.channel ?? "",
        s.engine ?? "",
      ]
    );
  }

  async recordRun(r: RunRecord): Promise<void> {
    await this.ensureMigrated();
    const rec = {
      ...r,
      prompt_preview: redact(r.prompt_preview),
      result_preview: redact(r.result_preview ?? ""),
      error_detail: r.error_detail ? redact(r.error_detail) : null,
    };
    await this.pool.query(
      `INSERT INTO runs (id,session_id,sdk_agent_id,sdk_run_id,prompt_preview,result_preview,status,error_kind,error_detail,started_at,finished_at,cwd,runtime,model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO NOTHING`,
      [
        rec.id,
        rec.session_id,
        rec.sdk_agent_id,
        rec.sdk_run_id,
        rec.prompt_preview,
        rec.result_preview,
        rec.status,
        rec.error_kind,
        rec.error_detail,
        rec.started_at,
        rec.finished_at,
        rec.cwd,
        rec.runtime,
        rec.model,
      ]
    );
  }

  async listSessions(limit = 50, opts?: ListSessionsOptions): Promise<SessionRecord[]> {
    await this.ensureMigrated();
    const { sql, params } = buildListSessionsSql(opts, limit);
    const res = await this.pool.query(sql, params);
    return res.rows as SessionRecord[];
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    await this.ensureMigrated();
    const res = await this.pool.query(`SELECT * FROM sessions WHERE id=$1`, [id]);
    return (res.rows[0] as SessionRecord | undefined) ?? undefined;
  }

  async updateSessionTitle(id: string, title: string): Promise<boolean> {
    const row = await this.getSession(id);
    if (!row) return false;
    await this.upsertSession({
      id: row.id,
      title: redact(title.trim() || row.title),
      cwd: row.cwd,
      runtime: row.runtime,
      sdk_agent_id: row.sdk_agent_id,
      last_status: row.last_status,
      selected_skills: row.selected_skills,
      mcp_server_names: row.mcp_server_names,
      channel: row.channel ?? "",
      engine: row.engine ?? "",
    });
    return true;
  }

  async listRuns(sessionId: string): Promise<RunRecord[]> {
    await this.ensureMigrated();
    const res = await this.pool.query(`SELECT * FROM runs WHERE session_id=$1 ORDER BY started_at`, [sessionId]);
    return res.rows as RunRecord[];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await releasePgPool(this.connectionString);
  }
}

/** Delegating wrapper: every recorded run also lands in logs/runs.jsonl (I-19). */
function withRunLog(store: IStore, dir: string, stateDir: string): IStore {
  return {
    upsertSession: (s) => store.upsertSession(s),
    recordRun: async (r) => {
      await store.recordRun(r);
      appendRunLog(dir, stateDir, r);
    },
    listSessions: (limit, opts) => store.listSessions(limit, opts),
    getSession: (id) => store.getSession(id),
    updateSessionTitle: (id, title) => store.updateSessionTitle(id, title),
    listRuns: (sessionId) => store.listRuns(sessionId),
    close: () => store.close(),
  };
}

export function createStore(dir: string, stateDir: string): IStore {
  const url = pgUrl();
  const store = url ? new PostgresStore(url) : new SqliteStore(dir, stateDir);
  return withRunLog(store, dir, stateDir);
}

/** Ping Postgres when CSAGENT_DATABASE_URL is set (doctor). */
export async function probePostgresStore(connectionString: string): Promise<{ ok: boolean; detail: string }> {
  const store = new PostgresStore(connectionString);
  try {
    await store.listSessions(1);
    return { ok: true, detail: "connected, schema ready" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    await store.close();
  }
}
