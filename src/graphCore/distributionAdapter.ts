import type { DistributionChartDataV1 } from "@/types/distribution";

export interface DistributionGraphInputV1 {
  schemaVersion: "1";
  source: "distribution";
  chartKind: DistributionChartDataV1["kind"];
  payload: DistributionChartDataV1;
  display: {
    role: "distribution";
    interactive: true;
    exportable: true;
  };
}

export function toGraphBuilderInput(
  block: DistributionChartDataV1,
): DistributionGraphInputV1 {
  return {
    schemaVersion: "1",
    source: "distribution",
    chartKind: block.kind,
    payload: structuredClone(block),
    display: {
      role: "distribution",
      interactive: true,
      exportable: true,
    },
  };
}