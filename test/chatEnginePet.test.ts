import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openChatSession } from "../src/chatEngine.js";
import { readPetStateSnapshot } from "../src/petRuntime.js";
import { createStore, type IStore } from "../src/store.js";
import type { RunLike, SdkCreateLike } from "../src/host.js";

// I-146: every surface funnels through sendTurn, so the Wisp bridge there must
// feed .agent/pet-state.json (begin → activity → end) unless pet.enabled=false.

function withKey(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = "test-key";
  return fn().finally(() => {
    if (prev === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prev;
  });
}

/** One tool call (grep → "search" bucket), then text. */
function runWithTool(text: string): RunLike {
  return {
    stream: async function* () {
      yield { type: "tool_call", name: "grep", status: "running", call_id: "c1", args: { pattern: "x" } };
      yield { type: "text", text };
    },
    wait: async () => ({ status: "finished", id: "r-ok" }),
  };
}

function sdkOf(): SdkCreateLike {
  return {
    create: async () => ({
      agentId: "agent-1",
      send: async () => runWithTool("answered"),
    }),
  };
}

describe("Wisp bridge in sendTurn (I-146)", () => {
  it("does not mutate a frozen caller options object while wiring pet callbacks", async () => {
    await withKey(async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "pet-frozen-"));
      let disposeCalls = 0;
      const sdk: SdkCreateLike = {
        create: async () => ({
          agentId: "agent-frozen",
          send: async () => runWithTool("answered"),
          [Symbol.asyncDispose]: async () => {
            disposeCalls++;
          },
        }),
      };
      const opts = Object.freeze({
        sdk,
        dir,
        interactive: false,
        onTurnRetry: () => {},
        onStoreDegraded: () => {},
      });

      const opened = await openChatSession(opts);
      assert.equal(opened.ok, true);
      if (!opened.ok) return;
      await opened.session.close();
      assert.equal(disposeCalls, 1);
    });
  });

  it("a completed turn persists the snapshot: activity seen, happy at end", async () => {
    await withKey(async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "pet-wire-"));
      const opened = await openChatSession({ sdk: sdkOf(), dir, interactive: false });
      assert.equal(opened.ok, true);
      if (!opened.ok) return;
      const out = await opened.session.sendTurn("hello");
      assert.equal(out.kind, "ok");
      const snap = readPetStateSnapshot(dir);
      assert.ok(snap, "pet-state.json must exist after a turn");
      assert.equal(snap!.state, "happy");
      assert.equal(snap!.lastTurnOk, true);
      assert.equal(snap!.activity, "search"); // the grep call was classified
      await opened.session.close();
    });
  });

  it("a store outage during an OK turn leaves the pet worried (I-150)", async () => {
    await withKey(async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "pet-degrade-"));
      const real = createStore(dir, ".agent");
      const broken = Object.create(real) as IStore;
      (broken as unknown as Record<string, unknown>).recordRun = async () => {
        throw new Error("connect ECONNREFUSED (simulated PG outage)");
      };
      const opened = await openChatSession({ sdk: sdkOf(), dir, interactive: false, store: broken });
      assert.equal(opened.ok, true);
      if (!opened.ok) return;
      const out = await opened.session.sendTurn("hello");
      assert.equal(out.kind, "ok"); // outcome preserved (I-137)…
      const snap = readPetStateSnapshot(dir);
      assert.equal(snap!.storeDegraded, true); // …but the pet knows (worried > happy)
      assert.equal(snap!.state, "worried");
      await opened.session.close();
    });
  });

  it('pet.enabled=false disables the bridge entirely', async () => {
    await withKey(async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "pet-off-"));
      writeFileSync(
        join(dir, "agent.config.json"),
        JSON.stringify({ pet: { enabled: false } }),
        "utf8"
      );
      const opened = await openChatSession({ sdk: sdkOf(), dir, interactive: false });
      assert.equal(opened.ok, true);
      if (!opened.ok) return;
      const out = await opened.session.sendTurn("hello");
      assert.equal(out.kind, "ok");
      assert.equal(existsSync(join(dir, ".agent", "pet-state.json")), false);
      await opened.session.close();
    });
  });
});
