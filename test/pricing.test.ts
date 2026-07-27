import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateCostUsd,
  lookupModelRates,
  formatUsd,
  MODEL_RATES,
} from "../src/pricing.js";

describe("pricing", () => {
  it("prices input + output per the model table", () => {
    // opus-4-8: $5/MTok in, $25/MTok out
    const usd = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, "claude-opus-4-8");
    assert.equal(usd, 5 + 25);
  });

  it("prices cache read at 0.1x and cache write at 1.25x input", () => {
    const usd = estimateCostUsd(
      { cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 },
      "claude-opus-4-8"
    );
    assert.equal(usd, 0.5 + 6.25); // 5*0.1 + 5*1.25
  });

  it("maps the haiku alias and full id to the same rates", () => {
    assert.deepEqual(lookupModelRates("claude-haiku-4-5"), lookupModelRates("claude-haiku-4-5-20251001"));
  });

  it("returns null for an unknown model (e.g. cursor composer)", () => {
    assert.equal(estimateCostUsd({ inputTokens: 1000 }, "composer-2.5"), null);
    assert.equal(estimateCostUsd({ inputTokens: 1000 }, undefined), null);
  });

  it("treats missing token fields as zero", () => {
    assert.equal(estimateCostUsd({ inputTokens: 200_000 }, "claude-sonnet-4-6"), (200_000 * 3) / 1_000_000);
  });

  it("every model has output dearer than input (sanity)", () => {
    for (const [id, r] of Object.entries(MODEL_RATES)) {
      assert.ok(r.outputPerMTok > r.inputPerMTok, id);
      assert.ok(r.cacheReadPerMTok < r.inputPerMTok, id);
    }
  });

  it("formatUsd renders ranges", () => {
    assert.equal(formatUsd(0), "$0.00");
    assert.equal(formatUsd(0.00001), "<$0.0001");
    assert.match(formatUsd(0.0042), /\$0\.0042/);
    assert.match(formatUsd(1.235), /\$1\.24|\$1\.23/);
  });
});

describe("pricing — live model", () => {
  it("prices the model Irida actually runs", () => {
    // engine.model on prod is claude-opus-5. An unpriced model makes
    // estimateCostUsd return null, so cost tracking silently goes dark —
    // this test fails the day the running model leaves the table.
    const r = lookupModelRates("claude-opus-5");
    assert.ok(r, "claude-opus-5 must be in MODEL_RATES");
    assert.equal(r.inputPerMTok, 5);
    assert.equal(r.outputPerMTok, 25);
    assert.equal(r.cacheReadPerMTok, 0.5);
    assert.equal(estimateCostUsd({ inputTokens: 1_000_000 }, "claude-opus-5"), 5);
  });
});
