/**
 * Claude model pricing for cost estimation (I-116). USD per 1M tokens.
 *
 * Rates are a snapshot — Anthropic changes prices and ships models over time.
 * Source: the `claude-api` skill model table (do not hand-edit from memory;
 * refresh via that skill). Cache rates follow the documented multipliers:
 * 5-minute cache write = input × 1.25, cache read = input × 0.1.
 *
 * Only the claude-agent (Anthropic) engine is priced. The cursor engine's model
 * is unknown here → `estimateCostUsd` returns null (we show usage, not $).
 */
export const RATES_AS_OF = "2026-07-28";

export interface ModelRates {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  /** USD per 1M tokens written to the 5-minute cache (input × 1.25). */
  cacheWrite5mPerMTok: number;
  /** USD per 1M tokens read from cache (input × 0.1). */
  cacheReadPerMTok: number;
}

function rates(input: number, output: number): ModelRates {
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    cacheWrite5mPerMTok: input * 1.25,
    cacheReadPerMTok: input * 0.1,
  };
}

/** Per-model rates, keyed by the exact model id (aliases mapped to the same rates). */
export const MODEL_RATES: Record<string, ModelRates> = {
  // Opus 5 is a drop-in upgrade at Opus 4.8's price — same $5/$25.
  // (Fast mode is billed at $10/$50, but Irida does not request it.)
  "claude-opus-5": rates(5, 25),
  "claude-opus-4-8": rates(5, 25),
  "claude-sonnet-4-6": rates(3, 15),
  "claude-haiku-4-5": rates(1, 5),
  "claude-haiku-4-5-20251001": rates(1, 5),
  "claude-fable-5": rates(10, 50),
};

export function lookupModelRates(model: string | undefined | null): ModelRates | null {
  if (!model) return null;
  return MODEL_RATES[model.trim()] ?? null;
}

export interface UsageTokens {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
}

/**
 * Estimate USD cost for one run's usage on a given model. Returns null when the
 * model is unknown (e.g. cursor's composer, or a model added after this snapshot)
 * — callers should then show tokens only, not a dollar figure.
 */
export function estimateCostUsd(usage: UsageTokens, model: string | undefined | null): number | null {
  const r = lookupModelRates(model);
  if (!r) return null;
  const inp = usage.inputTokens ?? 0;
  const out = usage.outputTokens ?? 0;
  const cr = usage.cacheReadTokens ?? 0;
  const cw = usage.cacheCreationTokens ?? 0;
  return (
    (inp * r.inputPerMTok +
      out * r.outputPerMTok +
      cr * r.cacheReadPerMTok +
      cw * r.cacheWrite5mPerMTok) /
    1_000_000
  );
}

/** Format a USD cost compactly: `$0.0042`, `$1.23`, or `<$0.0001` for tiny non-zero. */
export function formatUsd(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.0001) return "<$0.0001";
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
