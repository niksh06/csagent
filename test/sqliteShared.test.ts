import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMemoryStore } from "../src/memoryStore.js";
import { createStore } from "../src/store.js";
import {
  acquireSharedSqliteDb,
  releaseSharedSqliteDb,
  resetSharedSqlitePoolsForTests,
} from "../src/sqliteShared.js";

function tmp(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "sqlite-shared-"));
  mkdirSync(join(dir, ".agent"), { recursive: true });
  writeFileSync(
    join(dir, "agent.config.json"),
    JSON.stringify({ model: "m", runtime: "local", cwd: dir, stateDir: ".agent" }),
    "utf8"
  );
  return dir;
}

test("acquireSharedSqliteDb returns same DatabaseSync for one path", () => {
  resetSharedSqlitePoolsForTests();
  const root = join(tmp(), ".agent");
  const a = acquireSharedSqliteDb(root);
  const b = acquireSharedSqliteDb(root);
  assert.equal(a, b);
  releaseSharedSqliteDb(root);
  releaseSharedSqliteDb(root);
  resetSharedSqlitePoolsForTests();
});

test("createStore + createMemoryStore use shared sqlite pool", async () => {
  resetSharedSqlitePoolsForTests();
  const dir = tmp();
  const stateRoot = resolve(dir, ".agent");
  const session = createStore(dir, ".agent");
  const memory = createMemoryStore(dir);
  await memory.upsertNote({ name: "shared-note", body: "body" });
  await session.close();
  await memory.close();

  const session2 = createStore(dir, ".agent");
  const memory2 = createMemoryStore(dir);
  const note = await memory2.getNote("shared-note");
  await session2.close();
  await memory2.close();
  assert.equal(note?.body, "body");
  resetSharedSqlitePoolsForTests();
  assert.ok(stateRoot);
});

test("SqliteStore close is idempotent while another shared owner is live", async () => {
  resetSharedSqlitePoolsForTests();
  const dir = tmp();
  const session = createStore(dir, ".agent");
  const memory = createMemoryStore(dir);
  try {
    await session.close();
    await session.close();
    await memory.upsertNote({ name: "still-open", body: "body" });
    assert.equal((await memory.getNote("still-open"))?.body, "body");
  } finally {
    await memory.close();
    resetSharedSqlitePoolsForTests();
  }
});

test("SqliteMemoryStore close is idempotent while another shared owner is live", async () => {
  resetSharedSqlitePoolsForTests();
  const dir = tmp();
  const session = createStore(dir, ".agent");
  const memory = createMemoryStore(dir);
  try {
    await memory.close();
    await memory.close();
    assert.deepEqual(await session.listSessions(), []);
  } finally {
    await session.close();
    resetSharedSqlitePoolsForTests();
  }
});
