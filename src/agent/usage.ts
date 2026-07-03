/**
 * Per-session usage tracking. AgentRunner already computes detailed usage
 * per run (including cache-read tokens on the Anthropic path) and previously
 * discarded it after each turn. This accumulates it into session metadata so
 * it survives restarts and can be queried via the /usage command or the API
 * response's usage field.
 */

import type { Session } from "../session/manager.js";
import { estimateCostUsd } from "../providers/pricing.js";

const USAGE_METADATA_KEY = "usage";

export interface SessionUsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  costUsd: number;
  /** True if every call so far had a known price; false once any model was unpriced. */
  costKnown: boolean;
  callCount: number;
  lastModel: string;
  lastUpdatedAt: string;
}

function isSessionUsageTotals(v: unknown): v is SessionUsageTotals {
  return typeof v === "object" && v !== null && typeof (v as SessionUsageTotals).callCount === "number";
}

export function getSessionUsage(session: Session): SessionUsageTotals | null {
  const raw = session.metadata[USAGE_METADATA_KEY];
  return isSessionUsageTotals(raw) ? raw : null;
}

/**
 * Fold one turn's usage into the session's running totals (mutates
 * session.metadata in place; caller is responsible for persisting the
 * session afterward, same as any other metadata/message change).
 */
export function recordTurnUsage(
  session: Session,
  usage: Record<string, number>,
  model: string,
): SessionUsageTotals {
  const prev = getSessionUsage(session);

  const promptTokens = usage["prompt_tokens"] ?? 0;
  const completionTokens = usage["completion_tokens"] ?? 0;
  const totalTokens = usage["total_tokens"] ?? promptTokens + completionTokens;
  const cachedTokens = usage["cached_tokens"] ?? 0;

  const callCost = estimateCostUsd(model, { promptTokens, completionTokens, cachedTokens });
  const callCostKnown = callCost > 0 || (promptTokens === 0 && completionTokens === 0);

  const next: SessionUsageTotals = {
    promptTokens: (prev?.promptTokens ?? 0) + promptTokens,
    completionTokens: (prev?.completionTokens ?? 0) + completionTokens,
    totalTokens: (prev?.totalTokens ?? 0) + totalTokens,
    cachedTokens: (prev?.cachedTokens ?? 0) + cachedTokens,
    costUsd: (prev?.costUsd ?? 0) + callCost,
    costKnown: (prev?.costKnown ?? true) && callCostKnown,
    callCount: (prev?.callCount ?? 0) + 1,
    lastModel: model,
    lastUpdatedAt: new Date().toISOString(),
  };

  session.metadata[USAGE_METADATA_KEY] = next;
  return next;
}

export function formatUsageSummary(usage: SessionUsageTotals | null): string {
  if (!usage || usage.callCount === 0) {
    return "No usage recorded yet for this session.";
  }

  const lines = [
    `Session usage (${usage.callCount} call${usage.callCount === 1 ? "" : "s"}, last model: ${usage.lastModel}):`,
    `  Prompt tokens:     ${usage.promptTokens.toLocaleString()}`,
    `  Completion tokens: ${usage.completionTokens.toLocaleString()}`,
    `  Total tokens:      ${usage.totalTokens.toLocaleString()}`,
  ];
  if (usage.cachedTokens > 0) {
    lines.push(`  Cached tokens:     ${usage.cachedTokens.toLocaleString()}`);
  }
  lines.push(
    usage.costKnown
      ? `  Estimated cost:    $${usage.costUsd.toFixed(4)}`
      : `  Estimated cost:    unknown (no pricing data for one or more models used)`,
  );
  return lines.join("\n");
}
