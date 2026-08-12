import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherGatewayStatus, gatherGatewayStoreStatusLines } from "../src/gatewayStatus.js";
import { cmdGatewayStatus } from "../src/gateway_cmd.js";
import { writeExampleGatewayConfig } from "./helpers/gatewayConfig.js";
import { enqueueOutbox } from "../src/gatewayOutbox.js";
import { probePgReachable } from "../src/pg/pool.js";

async function withDbUrl<T>(url: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CSAGENT_DATABASE_URL;
  if (url === undefined) delete process.env.CSAGENT_DATABASE_URL;
  else process.env.CSAGENT_DATABASE_URL = url;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CSAGENT_DATABASE_URL;
    else process.env.CSAGENT_DATABASE_URL = prev;
  }
}

test("probePgReachable: sqlite note when no DATABASE_URL", async () => {
  await withDbUrl(undefined, async () => {
    const r = await probePgReachable(500);
    assert.equal(r.ok, true);
    assert.match(r.detail, /sqlite/);
  });
});

test("probePgReachable: FAIL + redacted password when PG unreachable (postmortem PG down)", async () => {
  // Port 1 → immediate ECONNREFUSED; password must not leak into the detail.
  const bad = await withDbUrl("postgres://u:secretpw@127.0.0.1:1/db", () => probePgReachable(800));
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /unreachable/);
  assert.doesNotMatch(bad.detail, /secretpw/);
});

test("gatherGatewayStoreStatusLines: empty on sqlite, FAIL line when PG down", async () => {
  await withDbUrl(undefined, async () => {
    assert.deepEqual(await gatherGatewayStoreStatusLines(), []);
  });
  await withDbUrl("postgres://u:secretpw@127.0.0.1:1/db", async () => {
    const rows = await gatherGatewayStoreStatusLines();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, "store (postgres)");
    assert.equal(rows[0]!.ok, false);
    assert.doesNotMatch(rows[0]!.detail, /secretpw/);
  });
});

test("gatherGatewayStatus reports gateway config when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "gwstat-"));
  writeExampleGatewayConfig(dir);
  const rows = gatherGatewayStatus(dir);
  const cfg = rows.find((r) => r.name === "gateway config");
  assert.ok(cfg);
  assert.equal(cfg!.ok, true);
});

test("gatherGatewayStatus engine row follows the chat's sticky engine", async () => {
  const { setChatEngine } = await import("../src/gatewayEngineStore.js");
  const dir = mkdtempSync(join(tmpdir(), "gwstat-eng-"));
  writeExampleGatewayConfig(dir);

  const before = gatherGatewayStatus(dir, { adapter: "telegram", chatId: "42" }).find((r) => r.name === "engine");
  assert.ok(before);
  assert.doesNotMatch(before!.detail, /sticky/);

  setChatEngine(dir, "telegram", "42", "codex");
  const after = gatherGatewayStatus(dir, { adapter: "telegram", chatId: "42" }).find((r) => r.name === "engine");
  assert.ok(after);
  assert.match(after!.detail, /codex/);
  assert.match(after!.detail, /sticky для чата/);

  // Another chat is untouched by the sticky choice.
  const other = gatherGatewayStatus(dir, { adapter: "telegram", chatId: "7" }).find((r) => r.name === "engine");
  assert.doesNotMatch(other!.detail, /sticky/);
});

test("gatherGatewayStatus reads gateway.log for operational health", () => {
  const dir = mkdtempSync(join(tmpdir(), "gwstat-err-"));
  const home = join(dir, "home");
  const logs = join(home, "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "gateway.error.log"), "");
  writeFileSync(
    join(logs, "gateway.log"),
    "[gateway] telegram long-poll started (interval=1500ms)\n[chat] sendTurn ok status=finished\n"
  );
  const prev = process.env.CSAGENT_HOME;
  process.env.CSAGENT_HOME = home;
  writeExampleGatewayConfig(dir);
  const health = gatherGatewayStatus(dir).find((r) => r.name === "gateway health");
  assert.ok(health);
  assert.equal(health!.ok, true);
  assert.match(health!.detail, /stdout/);
  assert.match(health!.detail, /long-poll started|sendTurn ok/);
  if (prev === undefined) delete process.env.CSAGENT_HOME;
  else process.env.CSAGENT_HOME = prev;
});

test("gatherGatewayStatus reports outbox pending count", () => {
  const dir = mkdtempSync(join(tmpdir(), "gwstat-outbox-"));
  writeExampleGatewayConfig(dir);
  enqueueOutbox(dir, { chatId: "99", text: "pending reply" });
  const row = gatherGatewayStatus(dir).find((r) => r.name === "outbox");
  assert.ok(row);
  assert.equal(row!.ok, true);
  assert.match(row!.detail, /1 pending/);
});

test("cmdGatewayStatus resolves async exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gwstat-cmd-"));
  writeExampleGatewayConfig(dir, { adapter: "webhook" });
  const code = await cmdGatewayStatus({ dir });
  assert.equal(typeof code, "number");
});
