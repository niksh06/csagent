import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  cogitBriefBlocks,
  formatCogitBrief,
  selectBriefFacts,
  type CogitFact,
} from "../src/cogitBrief.js";
import type { AgentConfig } from "../src/config.js";

// The belief half of the "briefing on arrival": top-K current facts pushed before
// the agent's first token, so recall stops depending on the agent remembering that
// it has something to recall. Read-only shell-out; a broken journal must cost the
// brief, never the turn.

function baseCfg(cogitBrief: AgentConfig["memory"] extends infer _ ? Record<string, unknown> : never): AgentConfig {
  return {
    model: "m",
    runtime: "local",
    cwd: "/tmp",
    skillsPath: "skills",
    stateDir: ".agent",
    mcpServers: {},
    safety: { allowCloud: false, allowAutoPr: false },
    memory: { cogitBrief } as AgentConfig["memory"],
    browser: {},
  };
}

/** Fake `cogit` CLI: prints the JSON we hand it, so no journal is needed. */
function fakeCogit(payload: unknown, opts: { exitCode?: number; sleepMs?: number } = {}): string {
  const dir = mkdtempSync(resolve(tmpdir(), "cogit-cli-"));
  const bin = join(dir, "fake-cogit");
  const body = [
    "#!/bin/sh",
    opts.sleepMs ? `sleep ${opts.sleepMs / 1000}` : "",
    `cat <<'JSON'`,
    JSON.stringify(payload),
    "JSON",
    `exit ${opts.exitCode ?? 0}`,
  ]
    .filter(Boolean)
    .join("\n");
  writeFileSync(bin, `${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const FACTS: CogitFact[] = [
  { subject: "irida:memory", predicate: "status", object: "autoRag on", asserted_at: "2026-07-25T01:00:00Z" },
  { subject: "irida:mcp", predicate: "root_cause", object: "settingSources unset", asserted_at: "2026-07-25T02:00:00Z" },
  { subject: "irida:old", predicate: "status", object: "ancient", asserted_at: "2026-01-01T00:00:00Z" },
];

test("selectBriefFacts keeps the newest and drops negated/retired", () => {
  const withNoise: CogitFact[] = [
    ...FACTS,
    { subject: "x", predicate: "p", object: "negated", asserted_at: "2026-07-26T00:00:00Z", negation: true },
    { subject: "y", predicate: "p", object: "retired", asserted_at: "2026-07-26T00:00:00Z", status: "retired" },
  ];
  const picked = selectBriefFacts(withNoise, 2);
  assert.equal(picked.length, 2);
  assert.equal(picked[0]!.subject, "irida:mcp", "newest first");
  assert.equal(picked[1]!.subject, "irida:memory");
  assert.ok(!picked.some((f) => f.object === "negated" || f.object === "retired"));
});

test("formatCogitBrief fences the journal text and labels it non-instructional", () => {
  const out = formatCogitBrief([{ project: "irida", facts: FACTS }]);
  assert.match(out, /NOT instructions/);
  assert.match(out, /```text/);
  assert.match(out, /\[irida\]/);
  assert.match(out, /settingSources unset/);
});

test("formatCogitBrief skips an over-budget fact instead of stopping", () => {
  const facts: CogitFact[] = [
    {
      subject: "b".repeat(80),
      predicate: "p".repeat(50),
      object: "x".repeat(400),
      asserted_at: "2026-07-25T03:00:00Z",
    },
    { subject: "small", predicate: "p", object: "keep me", asserted_at: "2026-07-25T02:00:00Z" },
  ];
  const out = formatCogitBrief([{ project: "irida", facts }], 100);
  assert.match(out, /keep me/, "a long fact must not hide the ones behind it");
  assert.match(out, /omitted for size/);
  // Per-field clipping is the first line of defence; the budget is the second.
  assert.ok(!out.includes("x".repeat(200)), "each field is clipped before the budget is applied");
});

test("cogitBriefBlocks returns nothing when disabled or unconfigured", async () => {
  assert.deepEqual(await cogitBriefBlocks(baseCfg({ enabled: false, projects: ["irida"] })), []);
  assert.deepEqual(await cogitBriefBlocks(baseCfg({ enabled: true })), []);
  assert.deepEqual(await cogitBriefBlocks(baseCfg({ enabled: true, projects: [] })), []);
});

test("cogitBriefBlocks renders facts from the CLI", async () => {
  const bin = fakeCogit({ facts: FACTS });
  const blocks = await cogitBriefBlocks(
    baseCfg({ enabled: true, projects: ["irida"], command: bin, args: [], limit: 2 })
  );
  assert.equal(blocks.length, 1);
  assert.match(blocks[0]!, /settingSources unset/);
  assert.ok(!blocks[0]!.includes("ancient"), "limit must be respected");
});

test("a failing journal degrades to no block, never an exception", async () => {
  const broken = await cogitBriefBlocks(
    baseCfg({ enabled: true, projects: ["irida"], command: "/nonexistent/cogit", args: [] })
  );
  assert.deepEqual(broken, [], "an unreachable CLI must not fail the turn");

  const garbage = fakeCogit("not json at all");
  writeFileSync(garbage, "#!/bin/sh\necho 'definitely not json'\n");
  chmodSync(garbage, 0o755);
  assert.deepEqual(
    await cogitBriefBlocks(baseCfg({ enabled: true, projects: ["irida"], command: garbage, args: [] })),
    [],
    "malformed CLI output must not fail the turn"
  );
});

test("one dead project does not lose the healthy ones", async () => {
  const bin = fakeCogit({ facts: FACTS });
  const blocks = await cogitBriefBlocks(
    baseCfg({ enabled: true, projects: ["", "irida"], command: bin, args: [], limit: 1 })
  );
  assert.equal(blocks.length, 1);
  assert.match(blocks[0]!, /\[irida\]/);
});
