import { SCATTER_RENDER_BUDGET } from "../../graphCore/scatterBudget.ts";
import type { GraphRawPointDisposition } from "../../types/graphData.ts";

export const DEFAULT_GRAPH_SAMPLE_SIZE = Math.min(20_000, SCATTER_RENDER_BUDGET);

export function clampSampleSize(raw: number): number {
  const size = Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_GRAPH_SAMPLE_SIZE;
  return Math.min(SCATTER_RENDER_BUDGET, Math.max(1, size));
}

export interface RawPointBudgetNotice {
  kind: "pointBudgetExceeded";
  validRows: number;
  budget: number;
}

export function getRawPointNotice(
  disposition: GraphRawPointDisposition | undefined,
): RawPointBudgetNotice | null {
  if (disposition?.status !== "omitted") return null;
  return {
    kind: "pointBudgetExceeded",
    validRows: disposition.validRows,
    budget: disposition.budget,
  };
}
