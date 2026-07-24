/**
 * csagent-memory: verbatim notes + temporal facts in SQLite or Postgres.
 * Replaces external MemPalace; shares CSAGENT_DATABASE_URL with session store.
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
import { newId, nowIso } from "./util.js";
import { loadConfig, resolveMemoryRoot } from "./config.js";
import { postgresFtsQuery, sqliteFtsMatchQuery } from "./memorySearch.js";
import {
  effectiveSearchExcludeWings,
  resolveEmbedExcludeWings,
  resolveSearchExcludeWings,
  resolveSearchWingFilter,
  resolveSqliteSearchWingFilter,
  shouldEmbedNote,
  type MemorySearchOptions,
  wingNotInSql,
} from "./memorySearchPolicy.js";
import { titleFromOkfOrBody } from "./okf.js";
import { secretsKey, SECRETS_KEY_ENV } from "./credentialsPg.js";
import { makeEmbedder, toVectorLiteral, type EmbedFn } from "./embeddings.js";
import { MALFORMED_FACT_WHERE, validateFactTriple } from "./memoryFactValidate.js";
import { reciprocalRankFusion, resolveHybridWeights, type HybridSearchWeights } from "./memorySearchHybrid.js";

/**
 * Notes in this wing are pgcrypto-encrypted at rest (Postgres only, I-20).
 * Body is decrypted only by getNote; list/search show a placeholder.
 */
export const SECURE_WING = "secure";
export const SECURE_BODY_PLACEHOLDER = "(encrypted — use memory show)";

export interface MemoryNote {
  name: string;
  wing: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryFact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  valid_from: string | null;
  valid_to: string | null;
  source: string;
  created_at: string;
}

export interface UpsertNoteInput {
  name: string;
  body: string;
  wing?: string;
  title?: string;
}

export interface AddFactInput {
  subject: string;
  predicate: string;
  object: string;
  valid_from?: string | null;
  source?: string;
}

export interface QueryFactsInput {
  subject: string;
  predicate?: string;
  object?: string;
  as_of?: string;
  currentOnly?: boolean;
}

export interface FactSubjectStats {
  subject: string;
  current: number;
  invalidated: number;
}

export interface MemoryFactAuditSummary {
  currentTotal: number;
  invalidatedTotal: number;
  subjects: FactSubjectStats[];
}

export interface PruneFactsInput {
  subject: string;
  olderThanDays: number;
  dryRun?: boolean;
}

export interface PruneFactsResult {
  matched: number;
  pruned: number;
}

export interface IMemoryStore {
  upsertNote(input: UpsertNoteInput): Promise<MemoryNote>;
  getNote(name: string): Promise<MemoryNote | undefined>;
  listNotes(wing?: string): Promise<MemoryNote[]>;
  deleteNote(name: string): Promise<boolean>;
  searchNotes(query: string, limit?: number, opts?: MemorySearchOptions): Promise<MemoryNote[]>;
  /** Cosine search over pgvector embeddings (Postgres + embeddings enabled). */
  searchNotesSemantic?(query: string, limit?: number, opts?: MemorySearchOptions): Promise<MemoryNote[]>;
  /** RRF merge of FTS + vector (Postgres + embeddings enabled, I-72). */
  searchNotesHybrid?(query: string, limit?: number, opts?: MemorySearchOptions): Promise<MemoryNote[]>;
  /**
   * Compute and store embeddings; returns updated count. Default: only notes
   * missing a vector (self-heal). `all:true` re-embeds every embeddable note —
   * needed after an embedding-model change (I-131) so stale vectors are replaced.
   */
  reindexEmbeddings?(opts?: { all?: boolean }): Promise<number>;
  addFact(input: AddFactInput): Promise<MemoryFact>;
  queryFacts(input: QueryFactsInput): Promise<MemoryFact[]>;
  factAuditSummary(): Promise<MemoryFactAuditSummary>;
  invalidateFact(id: string, ended?: string): Promise<boolean>;
  pruneCurrentFacts(input: PruneFactsInput): Promise<PruneFactsResult>;
  countMalformedSubjectFacts(): Promise<number>;
  purgeMalformedSubjectFacts(opts?: { dryRun?: boolean }): Promise<PruneFactsResult>;
  close(): Promise<void>;
}

// Schema is applied by the tracked runner (src/pg/migrations.ts, I-141). The
// pgvector migration (008) is feature-gated there: applied when the extension
// is available, skipped (with a log) on plain installs — matching the old
// "vector column only when the embedder is on" behavior at the schema level.

function titleFromBody(name: string, body: string): string {
  return titleFromOkfOrBody(name, body);
}

const SQLITE_MEMORY_DDL = `
  CREATE TABLE IF NOT EXISTS memory_notes (
    name TEXT PRIMARY KEY,
    wing TEXT NOT NULL DEFAULT 'default',
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_notes_wing ON memory_notes(wing, updated_at DESC);
  CREATE TABLE IF NOT EXISTS memory_facts (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    valid_from TEXT,
    valid_to TEXT,
    source TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_facts_subject ON memory_facts(subject, predicate);
  CREATE INDEX IF NOT EXISTS idx_memory_facts_lookup ON memory_facts(subject, predicate, object);
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(
    name UNINDEXED,
    title,
    body,
    tokenize='porter ascii'
  );
`;

function syncSqliteNoteFts(
  db: DatabaseSync,
  name: string,
  title: string,
  body: string
): void {
  db.prepare(`DELETE FROM memory_notes_fts WHERE name=?`).run(name);
  db.prepare(`INSERT INTO memory_notes_fts (name, title, body) VALUES (?, ?, ?)`).run(name, title, body);
}

export class SqliteMemoryStore implements IMemoryStore {
  private db: DatabaseSync;
  private readonly stateRoot: string;
  private readonly searchExcludeWings: readonly string[];
  private closed = false;

  constructor(stateRoot: string, opts: { searchExcludeWings?: readonly string[] } = {}) {
    this.stateRoot = resolve(stateRoot);
    this.searchExcludeWings = opts.searchExcludeWings ?? resolveSearchExcludeWings();
    mkdirSync(this.stateRoot, { recursive: true });
    this.db = acquireSharedSqliteDb(this.stateRoot);
    this.db.exec(SQLITE_MEMORY_DDL);
    const existing = this.db.prepare(`SELECT name, title, body FROM memory_notes`).all() as Array<{
      name: string;
      title: string;
      body: string;
    }>;
    for (const row of existing) syncSqliteNoteFts(this.db, row.name, row.title, row.body);
  }

  async upsertNote(input: UpsertNoteInput): Promise<MemoryNote> {
    const now = nowIso();
    const name = input.name.trim();
    const wing = input.wing?.trim() || "default";
    if (wing === SECURE_WING) {
      // No pgcrypto in the sqlite path — refuse loudly instead of storing plaintext.
      throw new Error(
        "secure wing requires the Postgres store (CSAGENT_DATABASE_URL + CSAGENT_SECRETS_KEY)"
      );
    }
    const body = redact(input.body.trim());
    const title = redact(input.title?.trim() || titleFromBody(name, body));
    const existing = await this.getNote(name);
    this.db
      .prepare(
        `INSERT INTO memory_notes (name, wing, title, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           wing=excluded.wing, title=excluded.title, body=excluded.body, updated_at=excluded.updated_at`
      )
      .run(name, wing, title, body, existing?.created_at ?? now, now);
    syncSqliteNoteFts(this.db, name, title, body);
    return (await this.getNote(name))!;
  }

  async getNote(name: string): Promise<MemoryNote | undefined> {
    return this.db.prepare(`SELECT * FROM memory_notes WHERE name=?`).get(name.trim()) as MemoryNote | undefined;
  }

  async listNotes(wing?: string): Promise<MemoryNote[]> {
    if (wing?.trim()) {
      return this.db
        .prepare(`SELECT * FROM memory_notes WHERE wing=? ORDER BY updated_at DESC`)
        .all(wing.trim()) as unknown as MemoryNote[];
    }
    return this.db
      .prepare(`SELECT * FROM memory_notes ORDER BY updated_at DESC`)
      .all() as unknown as MemoryNote[];
  }

  async deleteNote(name: string): Promise<boolean> {
    const trimmed = name.trim();
    const r = this.db.prepare(`DELETE FROM memory_notes WHERE name=?`).run(trimmed);
    if (r.changes > 0) this.db.prepare(`DELETE FROM memory_notes_fts WHERE name=?`).run(trimmed);
    return r.changes > 0;
  }

  async searchNotes(query: string, limit = 20, opts?: MemorySearchOptions): Promise<MemoryNote[]> {
    const exclude = effectiveSearchExcludeWings(this.searchExcludeWings, opts);
    const wingFilter = resolveSqliteSearchWingFilter(exclude, opts);
    const ftsQ = sqliteFtsMatchQuery(query);
    if (ftsQ) {
      try {
        return this.db
          .prepare(
            `SELECT n.* FROM memory_notes_fts f
             JOIN memory_notes n ON n.name = f.name
             WHERE memory_notes_fts MATCH ?${wingFilter.clause}
             ORDER BY n.updated_at DESC LIMIT ?`
          )
          .all(ftsQ, ...wingFilter.params, limit) as unknown as MemoryNote[];
      } catch {
        /* fall through to LIKE */
      }
    }
    const q = `%${query.trim()}%`;
    return this.db
      .prepare(
        `SELECT * FROM memory_notes
         WHERE (name LIKE ? OR title LIKE ? OR body LIKE ?)${wingFilter.clause}
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(q, q, q, ...wingFilter.params, limit) as unknown as MemoryNote[];
  }

  async addFact(input: AddFactInput): Promise<MemoryFact> {
    validateFactTriple(input.subject, input.predicate, input.object);
    const now = nowIso();
    const row: MemoryFact = {
      id: newId("fact"),
      subject: input.subject.trim(),
      predicate: input.predicate.trim(),
      object: input.object.trim(),
      valid_from: input.valid_from?.trim() || null,
      valid_to: null,
      source: redact(input.source?.trim() || ""),
      created_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO memory_facts (id, subject, predicate, object, valid_from, valid_to, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.subject,
        row.predicate,
        row.object,
        row.valid_from,
        row.valid_to,
        row.source,
        row.created_at
      );
    return row;
  }

  async queryFacts(input: QueryFactsInput): Promise<MemoryFact[]> {
    const params: (string | number)[] = [input.subject.trim()];
    const clauses = [`subject = ?`];
    if (input.predicate?.trim()) {
      clauses.push(`predicate = ?`);
      params.push(input.predicate.trim());
    }
    if (input.object?.trim()) {
      clauses.push(`object = ?`);
      params.push(input.object.trim());
    }
    if (input.currentOnly !== false) {
      clauses.push(`(valid_to IS NULL OR valid_to = '')`);
    }
    if (input.as_of?.trim()) {
      clauses.push(`(valid_from IS NULL OR valid_from = '' OR valid_from <= ?)`);
      params.push(input.as_of.trim());
      clauses.push(`(valid_to IS NULL OR valid_to = '' OR valid_to >= ?)`);
      params.push(input.as_of.trim());
    }
    const sql = `SELECT * FROM memory_facts WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`;
    return this.db.prepare(sql).all(...params) as unknown as MemoryFact[];
  }

  async factAuditSummary(): Promise<MemoryFactAuditSummary> {
    const rows = this.db
      .prepare(
        `SELECT subject,
                SUM(CASE WHEN valid_to IS NULL OR valid_to = '' THEN 1 ELSE 0 END) AS current,
                SUM(CASE WHEN valid_to IS NOT NULL AND valid_to != '' THEN 1 ELSE 0 END) AS invalidated
         FROM memory_facts
         GROUP BY subject
         ORDER BY current DESC, subject ASC`
      )
      .all() as Array<{ subject: string; current: number; invalidated: number }>;
    let currentTotal = 0;
    let invalidatedTotal = 0;
    const subjects: FactSubjectStats[] = rows.map((r) => {
      currentTotal += r.current;
      invalidatedTotal += r.invalidated;
      return { subject: r.subject, current: r.current, invalidated: r.invalidated };
    });
    return { currentTotal, invalidatedTotal, subjects };
  }

  async invalidateFact(id: string, ended?: string): Promise<boolean> {
    const when = ended?.trim() || nowIso().slice(0, 10);
    const r = this.db
      .prepare(`UPDATE memory_facts SET valid_to=? WHERE id=? AND (valid_to IS NULL OR valid_to='')`)
      .run(when, id.trim());
    return r.changes > 0;
  }

  async pruneCurrentFacts(input: PruneFactsInput): Promise<PruneFactsResult> {
    const subject = input.subject.trim();
    const days = Math.max(1, Math.floor(input.olderThanDays));
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const when = nowIso().slice(0, 10);
    const countRow = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_facts
         WHERE subject=? AND (valid_to IS NULL OR valid_to='') AND created_at < ?`
      )
      .get(subject, cutoff) as { n: number };
    const matched = countRow?.n ?? 0;
    if (input.dryRun || matched === 0) return { matched, pruned: 0 };
    const r = this.db
      .prepare(
        `UPDATE memory_facts SET valid_to=?
         WHERE subject=? AND (valid_to IS NULL OR valid_to='') AND created_at < ?`
      )
      .run(when, subject, cutoff);
    return { matched, pruned: Number(r.changes) };
  }

  async countMalformedSubjectFacts(): Promise<number> {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM memory_facts WHERE ${MALFORMED_FACT_WHERE}`)
      .get() as { n: number };
    return row?.n ?? 0;
  }

  async purgeMalformedSubjectFacts(opts: { dryRun?: boolean } = {}): Promise<PruneFactsResult> {
    const matched = await this.countMalformedSubjectFacts();
    if (opts.dryRun || matched === 0) return { matched, pruned: 0 };
    const when = nowIso().slice(0, 10);
    const r = this.db
      .prepare(`UPDATE memory_facts SET valid_to=? WHERE ${MALFORMED_FACT_WHERE}`)
      .run(when);
    return { matched, pruned: Number(r.changes) };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    releaseSharedSqliteDb(this.stateRoot);
  }
}

export class PostgresMemoryStore implements IMemoryStore {
  private readonly connectionString: string;
  private pool: pg.Pool;
  private migrated = false;
  private closed = false;
  private embedder?: EmbedFn;
  private readonly searchExcludeWings: readonly string[];
  private readonly embedExcludeWings: readonly string[];
  private readonly hybridWeights: HybridSearchWeights;

  constructor(
    connectionString: string,
    opts: {
      embedder?: EmbedFn;
      searchExcludeWings?: readonly string[];
      embedExcludeWings?: readonly string[];
      hybridWeights?: HybridSearchWeights;
    } = {}
  ) {
    this.connectionString = connectionString;
    this.pool = acquirePgPool(connectionString);
    this.embedder = opts.embedder;
    this.searchExcludeWings = opts.searchExcludeWings ?? resolveSearchExcludeWings();
    this.embedExcludeWings = opts.embedExcludeWings ?? resolveEmbedExcludeWings();
    this.hybridWeights = opts.hybridWeights ?? resolveHybridWeights();
  }

  private async ensureMigrated(): Promise<void> {
    if (this.migrated) return;
    await runPgMigrations(this.pool, this.connectionString);
    this.migrated = true;
  }

  /** Best-effort embedding update; never fails the save. */
  private async updateEmbedding(name: string, wing: string, title: string, body: string): Promise<void> {
    if (!this.embedder || !shouldEmbedNote(wing, this.embedExcludeWings)) return;
    const emb = await this.embedder(`${title}\n\n${body}`);
    if (!emb) return;
    try {
      await this.pool.query(`UPDATE memory_notes SET embedding=$1::vector WHERE name=$2`, [
        toVectorLiteral(emb),
        name,
      ]);
    } catch {
      /* embedding is an enhancement, not a dependency */
    }
  }

  /** Column list with body resolved for reads; decrypts only when asked and key set. */
  private noteSelect(decrypt: boolean): { expr: string; params: unknown[] } {
    const key = secretsKey();
    if (decrypt && key) {
      return {
        expr: `name, wing, title,
               CASE WHEN body_enc IS NOT NULL THEN pgp_sym_decrypt(body_enc, $1) ELSE body END AS body,
               created_at, updated_at`,
        params: [key],
      };
    }
    return {
      expr: `name, wing, title,
             CASE WHEN body_enc IS NOT NULL THEN '${SECURE_BODY_PLACEHOLDER}' ELSE body END AS body,
             created_at, updated_at`,
      params: [],
    };
  }

  async upsertNote(input: UpsertNoteInput): Promise<MemoryNote> {
    await this.ensureMigrated();
    const now = nowIso();
    const name = input.name.trim();
    const wing = input.wing?.trim() || "default";
    const existing = await this.getNote(name);

    if (wing === SECURE_WING) {
      const key = secretsKey();
      if (!key) {
        throw new Error(`secure wing requires ${SECRETS_KEY_ENV} (pgcrypto encryption key)`);
      }
      // Encryption replaces redaction here — secure notes exist to hold secrets.
      const rawBody = input.body.trim();
      const title = redact(input.title?.trim() || titleFromBody(name, rawBody));
      // body='' keeps the generated FTS vector free of secret content.
      await this.pool.query(
        `INSERT INTO memory_notes (name, wing, title, body, body_enc, created_at, updated_at)
         VALUES ($1,$2,$3,'',pgp_sym_encrypt($4,$5),$6,$7)
         ON CONFLICT(name) DO UPDATE SET
           wing=EXCLUDED.wing, title=EXCLUDED.title, body='', body_enc=EXCLUDED.body_enc, updated_at=EXCLUDED.updated_at`,
        [name, wing, title, rawBody, key, existing?.created_at ?? now, now]
      );
      return (await this.getNote(name))!;
    }

    const body = redact(input.body.trim());
    const title = redact(input.title?.trim() || titleFromBody(name, body));
    await this.pool.query(
      `INSERT INTO memory_notes (name, wing, title, body, body_enc, created_at, updated_at)
       VALUES ($1,$2,$3,$4,NULL,$5,$6)
       ON CONFLICT(name) DO UPDATE SET
         wing=EXCLUDED.wing, title=EXCLUDED.title, body=EXCLUDED.body, body_enc=NULL, updated_at=EXCLUDED.updated_at`,
      [name, wing, title, body, existing?.created_at ?? now, now]
    );
    await this.updateEmbedding(name, wing, title, body);
    return (await this.getNote(name))!;
  }

  async searchNotesSemantic(query: string, limit = 10, opts?: MemorySearchOptions): Promise<MemoryNote[]> {
    await this.ensureMigrated();
    if (!this.embedder) return [];
    const emb = await this.embedder(query);
    if (!emb) return [];
    const exclude = effectiveSearchExcludeWings(this.searchExcludeWings, opts);
    const sel = this.noteSelect(false);
    const wingFilter = resolveSearchWingFilter(exclude, opts, sel.params.length + 1);
    const n = sel.params.length;
    const res = await this.pool.query(
      `SELECT ${sel.expr} FROM memory_notes
       WHERE embedding IS NOT NULL${wingFilter.clause}
       ORDER BY embedding <=> $${n + wingFilter.params.length + 1}::vector
       LIMIT $${n + wingFilter.params.length + 2}`,
      [...sel.params, ...wingFilter.params, toVectorLiteral(emb), limit]
    );
    return res.rows as MemoryNote[];
  }

  async searchNotesHybrid(query: string, limit = 10, opts?: MemorySearchOptions): Promise<MemoryNote[]> {
    await this.ensureMigrated();
    if (!this.embedder) return this.searchNotes(query, limit, opts);
    const emb = await this.embedder(query);
    if (!emb) return this.searchNotes(query, limit, opts);
    const candidateLimit = Math.min(Math.max(limit * 3, limit), 50);
    const [ftsHits, vecHits] = await Promise.all([
      this.searchNotes(query, candidateLimit, opts),
      this.searchNotesSemantic(query, candidateLimit, opts),
    ]);
    if (vecHits.length === 0) return ftsHits.slice(0, limit);
    if (ftsHits.length === 0) return vecHits.slice(0, limit);
    return reciprocalRankFusion(
      [
        { items: ftsHits, weight: this.hybridWeights.fts },
        { items: vecHits, weight: this.hybridWeights.vector },
      ],
      limit
    );
  }

  async reindexEmbeddings(opts: { all?: boolean } = {}): Promise<number> {
    await this.ensureMigrated();
    if (!this.embedder) return 0;
    const wingFilter = wingNotInSql(this.embedExcludeWings, 1);
    // Default: backfill only missing vectors (self-heal cron). all:true re-embeds
    // every embeddable note — used once after a model change to replace stale vectors.
    const missingOnly = opts.all ? "" : "embedding IS NULL AND ";
    const res = await this.pool.query(
      `SELECT name, title, body, wing FROM memory_notes
       WHERE ${missingOnly}body_enc IS NULL AND body != ''${wingFilter.clause}`,
      wingFilter.params
    );
    let updated = 0;
    for (const row of res.rows as Array<{ name: string; title: string; body: string; wing: string }>) {
      if (!shouldEmbedNote(row.wing, this.embedExcludeWings)) continue;
      const emb = await this.embedder(`${row.title}\n\n${row.body}`);
      if (!emb) continue;
      await this.pool.query(`UPDATE memory_notes SET embedding=$1::vector WHERE name=$2`, [
        toVectorLiteral(emb),
        row.name,
      ]);
      updated++;
    }
    return updated;
  }

  async getNote(name: string): Promise<MemoryNote | undefined> {
    await this.ensureMigrated();
    const sel = this.noteSelect(true);
    const res = await this.pool.query(
      `SELECT ${sel.expr} FROM memory_notes WHERE name=$${sel.params.length + 1}`,
      [...sel.params, name.trim()]
    );
    return (res.rows[0] as MemoryNote | undefined) ?? undefined;
  }

  async listNotes(wing?: string): Promise<MemoryNote[]> {
    await this.ensureMigrated();
    const sel = this.noteSelect(false);
    if (wing?.trim()) {
      const res = await this.pool.query(
        `SELECT ${sel.expr} FROM memory_notes WHERE wing=$${sel.params.length + 1} ORDER BY updated_at DESC`,
        [...sel.params, wing.trim()]
      );
      return res.rows as MemoryNote[];
    }
    const res = await this.pool.query(`SELECT ${sel.expr} FROM memory_notes ORDER BY updated_at DESC`);
    return res.rows as MemoryNote[];
  }

  async deleteNote(name: string): Promise<boolean> {
    await this.ensureMigrated();
    const res = await this.pool.query(`DELETE FROM memory_notes WHERE name=$1`, [name.trim()]);
    return (res.rowCount ?? 0) > 0;
  }

  async searchNotes(query: string, limit = 20, opts?: MemorySearchOptions): Promise<MemoryNote[]> {
    await this.ensureMigrated();
    const exclude = effectiveSearchExcludeWings(this.searchExcludeWings, opts);
    const sel = this.noteSelect(false);
    const ftsQ = postgresFtsQuery(query);
    if (ftsQ.length >= 2) {
      try {
        const wingFilter = resolveSearchWingFilter(exclude, opts, sel.params.length + 2);
        const limitIdx = 1 + sel.params.length + wingFilter.params.length + 1;
        const res = await this.pool.query(
          `SELECT ${sel.expr} FROM memory_notes
           WHERE search_vector @@ plainto_tsquery('simple', $1)${wingFilter.clause}
           ORDER BY ts_rank(search_vector, plainto_tsquery('simple', $1)) DESC, updated_at DESC
           LIMIT $${limitIdx}`,
          [ftsQ, ...sel.params, ...wingFilter.params, limit]
        );
        if (res.rows.length > 0) return res.rows as MemoryNote[];
      } catch {
        /* fall through to ILIKE */
      }
    }
    const wingFilter = resolveSearchWingFilter(exclude, opts, sel.params.length + 2);
    const limitIdx = 1 + sel.params.length + wingFilter.params.length + 1;
    const res = await this.pool.query(
      `SELECT ${sel.expr} FROM memory_notes
       WHERE (name ILIKE $1 OR title ILIKE $1 OR body ILIKE $1)${wingFilter.clause}
       ORDER BY updated_at DESC LIMIT $${limitIdx}`,
      [`%${query.trim()}%`, ...sel.params, ...wingFilter.params, limit]
    );
    return res.rows as MemoryNote[];
  }

  async addFact(input: AddFactInput): Promise<MemoryFact> {
    await this.ensureMigrated();
    validateFactTriple(input.subject, input.predicate, input.object);
    const now = nowIso();
    const row: MemoryFact = {
      id: newId("fact"),
      subject: input.subject.trim(),
      predicate: input.predicate.trim(),
      object: input.object.trim(),
      valid_from: input.valid_from?.trim() || null,
      valid_to: null,
      source: redact(input.source?.trim() || ""),
      created_at: now,
    };
    await this.pool.query(
      `INSERT INTO memory_facts (id, subject, predicate, object, valid_from, valid_to, source, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        row.id,
        row.subject,
        row.predicate,
        row.object,
        row.valid_from,
        row.valid_to,
        row.source,
        row.created_at,
      ]
    );
    return row;
  }

  async queryFacts(input: QueryFactsInput): Promise<MemoryFact[]> {
    await this.ensureMigrated();
    const params: unknown[] = [input.subject.trim()];
    const clauses = [`subject = $1`];
    let n = 2;
    if (input.predicate?.trim()) {
      clauses.push(`predicate = $${n++}`);
      params.push(input.predicate.trim());
    }
    if (input.object?.trim()) {
      clauses.push(`object = $${n++}`);
      params.push(input.object.trim());
    }
    if (input.currentOnly !== false) {
      clauses.push(`(valid_to IS NULL OR valid_to = '')`);
    }
    if (input.as_of?.trim()) {
      clauses.push(`(valid_from IS NULL OR valid_from = '' OR valid_from <= $${n++})`);
      params.push(input.as_of.trim());
      clauses.push(`(valid_to IS NULL OR valid_to = '' OR valid_to >= $${n++})`);
      params.push(input.as_of.trim());
    }
    const sql = `SELECT * FROM memory_facts WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`;
    const res = await this.pool.query(sql, params);
    return res.rows as MemoryFact[];
  }

  async factAuditSummary(): Promise<MemoryFactAuditSummary> {
    await this.ensureMigrated();
    const res = await this.pool.query(
      `SELECT subject,
              COUNT(*) FILTER (WHERE valid_to IS NULL OR valid_to = '')::int AS current,
              COUNT(*) FILTER (WHERE valid_to IS NOT NULL AND valid_to != '')::int AS invalidated
       FROM memory_facts
       GROUP BY subject
       ORDER BY current DESC, subject ASC`
    );
    let currentTotal = 0;
    let invalidatedTotal = 0;
    const subjects: FactSubjectStats[] = (res.rows as FactSubjectStats[]).map((r) => {
      currentTotal += r.current;
      invalidatedTotal += r.invalidated;
      return r;
    });
    return { currentTotal, invalidatedTotal, subjects };
  }

  async invalidateFact(id: string, ended?: string): Promise<boolean> {
    await this.ensureMigrated();
    const when = ended?.trim() || nowIso().slice(0, 10);
    const res = await this.pool.query(
      `UPDATE memory_facts SET valid_to=$1 WHERE id=$2 AND (valid_to IS NULL OR valid_to='')`,
      [when, id.trim()]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async pruneCurrentFacts(input: PruneFactsInput): Promise<PruneFactsResult> {
    await this.ensureMigrated();
    const subject = input.subject.trim();
    const days = Math.max(1, Math.floor(input.olderThanDays));
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const when = nowIso().slice(0, 10);
    const countRes = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM memory_facts
       WHERE subject=$1 AND (valid_to IS NULL OR valid_to='') AND created_at < $2`,
      [subject, cutoff]
    );
    const matched = (countRes.rows[0] as { n: number } | undefined)?.n ?? 0;
    if (input.dryRun || matched === 0) return { matched, pruned: 0 };
    const updateRes = await this.pool.query(
      `UPDATE memory_facts SET valid_to=$1
       WHERE subject=$2 AND (valid_to IS NULL OR valid_to='') AND created_at < $3`,
      [when, subject, cutoff]
    );
    return { matched, pruned: updateRes.rowCount ?? 0 };
  }

  async countMalformedSubjectFacts(): Promise<number> {
    await this.ensureMigrated();
    const res = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM memory_facts WHERE ${MALFORMED_FACT_WHERE}`
    );
    return (res.rows[0] as { n: number } | undefined)?.n ?? 0;
  }

  async purgeMalformedSubjectFacts(opts: { dryRun?: boolean } = {}): Promise<PruneFactsResult> {
    await this.ensureMigrated();
    const matched = await this.countMalformedSubjectFacts();
    if (opts.dryRun || matched === 0) return { matched, pruned: 0 };
    const when = nowIso().slice(0, 10);
    const updateRes = await this.pool.query(
      `UPDATE memory_facts SET valid_to=$1 WHERE ${MALFORMED_FACT_WHERE}`,
      [when]
    );
    return { matched, pruned: updateRes.rowCount ?? 0 };
  }

  async close(): Promise<void> {
    // Guard against double-release (I-142): pools are ref-counted per
    // connection string, so a second close() here would decrement ANOTHER
    // holder's ref and could end a shared pool under live queries.
    if (this.closed) return;
    this.closed = true;
    await releasePgPool(this.connectionString);
  }
}

export function createMemoryStore(projectDir: string, _stateDir?: string): IMemoryStore {
  const url = pgUrl();
  let memoryCfg;
  try {
    memoryCfg = loadConfig(projectDir).memory;
  } catch {
    memoryCfg = undefined;
  }
  const searchExcludeWings = resolveSearchExcludeWings(memoryCfg);
  const embedExcludeWings = resolveEmbedExcludeWings(memoryCfg);
  if (url) {
    let embedder: EmbedFn | undefined;
    try {
      embedder = makeEmbedder(memoryCfg?.embeddings);
    } catch {
      /* config errors surface elsewhere; embeddings stay off */
    }
    return new PostgresMemoryStore(url, {
      embedder,
      searchExcludeWings,
      embedExcludeWings,
      hybridWeights: resolveHybridWeights(memoryCfg?.search?.hybridWeights),
    });
  }
  return new SqliteMemoryStore(resolveMemoryRoot(projectDir), { searchExcludeWings });
}
