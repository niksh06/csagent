import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { agentLogEnabled, agentLogVerbose, resolveAgentLogger } from "../src/agentLog.js";

test("agentLogEnabled respects CSAGENT_LOG", () => {
  const prev = process.env.CSAGENT_LOG;
  delete process.env.CSAGENT_DEBUG;
  process.env.CSAGENT_LOG = "1";
  assert.equal(agentLogEnabled(), true);
  process.env.CSAGENT_LOG = "0";
  assert.equal(agentLogEnabled(), false);
  if (prev === undefined) delete process.env.CSAGENT_LOG;
  else process.env.CSAGENT_LOG = prev;
});

test("agentLogVerbose respects CSAGENT_LOG_VERBOSE", () => {
  const prev = process.env.CSAGENT_LOG_VERBOSE;
  process.env.CSAGENT_LOG_VERBOSE = "yes";
  assert.equal(agentLogVerbose(), true);
  if (prev === undefined) delete process.env.CSAGENT_LOG_VERBOSE;
  else process.env.CSAGENT_LOG_VERBOSE = prev;
});

test("resolveAgentLogger forwards to onLog when CSAGENT_LOG off", () => {
  const prev = process.env.CSAGENT_LOG;
  delete process.env.CSAGENT_LOG;
  delete process.env.CSAGENT_DEBUG;
  const lines: string[] = [];
  const log = resolveAgentLogger({ component: "test", onLog: (l) => lines.push(l) });
  log("[chat] hello");
  assert.deepEqual(lines, ["[chat] hello"]);
  if (prev === undefined) delete process.env.CSAGENT_LOG;
  else process.env.CSAGENT_LOG = prev;
});

test("resolveAgentLogger isolates failures in the diagnostic sink", () => {
  const log = resolveAgentLogger({
    component: "test",
    onLog: () => {
      throw new Error("log sink failed");
    },
  });
  assert.doesNotThrow(() => log("[chat] opened"));
});

test("resolveAgentLogger handles rejected promises from an asynchronous diagnostic sink", () => {
  let rejectionHandled = false;
  const rejected = Promise.reject(new Error("async log sink failed"));
  const originalCatch = rejected.catch.bind(rejected);
  rejected.catch = ((onRejected?: (reason: unknown) => unknown) => {
    rejectionHandled = true;
    return originalCatch(onRejected);
  }) as typeof rejected.catch;
  const log = resolveAgentLogger({ component: "test", onLog: () => rejected });

  log("[chat] opened");
  // Keep the RED implementation from leaking an unhandled rejection into the
  // test runner while still proving that the logger attached its own handler.
  if (!rejectionHandled) void originalCatch(() => undefined);
  assert.equal(rejectionHandled, true);
});

test("resolveAgentLogger writes to logFile instead of stdout (TUI, I-17)", () => {
  const prev = process.env.CSAGENT_LOG;
  process.env.CSAGENT_LOG = "1";
  const dir = mkdtempSync(resolve(tmpdir(), "tuilog-"));
  const logFile = resolve(dir, ".agent", "tui.log");
  const log = resolveAgentLogger({ component: "tui", logFile });
  log("[chat] rotate start reason=test");
  log("[chat] sendTurn failed boom");
  assert.ok(existsSync(logFile));
  const body = readFileSync(logFile, "utf8");
  assert.match(body, /\[tui\] .*rotate start/);
  assert.match(body, /^ERROR \[tui\] .*sendTurn failed/m);
  if (prev === undefined) delete process.env.CSAGENT_LOG;
  else process.env.CSAGENT_LOG = prev;
});
