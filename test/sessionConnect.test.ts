import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connectAgentForSession } from "../src/sessionConnect.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import type { AgentLike, SdkCreateLike, SdkResumeLike } from "../src/host.js";

test("connectAgentForSession passes model on live resume", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sessconn-"));
  const cfg = loadConfig(dir);
  const store = new Store(dir, cfg.stateDir);
  await store.upsertSession({
    id: "sess_1",
    title: "t",
    cwd: dir,
    runtime: cfg.runtime,
    sdk_agent_id: "agent-live",
    last_status: "created",
    channel: "telegram",
  });

  let resumeOpts: unknown;
  const sdk: SdkCreateLike & SdkResumeLike = {
    resume: async (_id, opts) => {
      resumeOpts = opts;
      return { agentId: "agent-live", send: () => ({ wait: async () => ({ status: "finished" }) }) };
    },
    create: async () => {
      throw new Error("should not create when live resume succeeds");
    },
  };

  const session = (await store.getSession("sess_1"))!;
  const result = await connectAgentForSession(sdk, store, session, cfg, "key", {});
  assert.equal(result.mode, "resumed");
  assert.deepEqual((resumeOpts as { model?: { id: string } }).model, { id: cfg.model });
  await store.close();
});

test("replay preparation can stop fallback before fresh agent create", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sessconn-"));
  const cfg = loadConfig(dir);
  const store = new Store(dir, cfg.stateDir);
  await store.upsertSession({
    id: "sess_1",
    title: "t",
    cwd: dir,
    runtime: cfg.runtime,
    sdk_agent_id: "agent-stale",
    last_status: "created",
    channel: "",
  });

  const order: string[] = [];
  const sdk: SdkCreateLike & SdkResumeLike = {
    resume: async () => {
      order.push("resume");
      throw new Error("agent not found CURSOR_API_KEY=cursor_secret_value_123456");
    },
    create: async () => {
      order.push("create");
      return { send: () => ({ wait: async () => ({ status: "finished" }) }) };
    },
  };

  const session = (await store.getSession("sess_1"))!;
  await assert.rejects(
    connectAgentForSession(sdk, store, session, cfg, "key", {}, {
      beforeReplayCreate: async ({ liveResumeError }) => {
        order.push("prepare");
        assert.match(liveResumeError, /agent not found/);
        assert.match(liveResumeError, /<redacted>/);
        assert.doesNotMatch(liveResumeError, /cursor_secret_value/);
        throw new Error("blocked replay prompt");
      },
    }),
    /blocked replay prompt/
  );
  assert.deepEqual(order, ["resume", "prepare"]);
  await store.close();
});

test("fresh replay agent is disposed when transcript loading fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sessconn-"));
  const cfg = loadConfig(dir);
  const store = new Store(dir, cfg.stateDir);
  await store.upsertSession({
    id: "sess_1",
    title: "t",
    cwd: dir,
    runtime: cfg.runtime,
    sdk_agent_id: null,
    last_status: "created",
    channel: "",
  });

  let disposeCalls = 0;
  const createdAgent: AgentLike = {
    agentId: "agent-fresh",
    send: () => ({ wait: async () => ({ status: "finished" }) }),
    [Symbol.asyncDispose]: async () => {
      disposeCalls++;
    },
  };
  const sdk: SdkCreateLike & SdkResumeLike = {
    resume: async () => {
      throw new Error("resume should not run without a stored agent id");
    },
    create: async () => createdAgent,
  };
  store.listRuns = async () => {
    throw new Error("transcript unavailable");
  };

  const session = (await store.getSession("sess_1"))!;
  await assert.rejects(
    connectAgentForSession(sdk, store, session, cfg, "key", {}),
    /transcript unavailable/
  );
  assert.equal(disposeCalls, 1);
  await store.close();
});
