import type { FilterExprV1 } from "./filter";

export type { FilterExprV1 } from "./filter";

export type DistributionSchemaVersionV1 = "1";
export type DistributionModeV1 =
  | "emptySystem"
  | "continuous"
  | "ordinal"
  | "nominal"
  | "discreteNumeric";
export type DistributionModelingTypeV1 = Exclude<DistributionModeV1, "emptySystem">;

export interface DistributionColumnRefV1 {
  columnId: string;
  modelingType: DistributionModelingTypeV1;
}

export interface AnalysisSnapshotV1 {
  schemaVersion: DistributionSchemaVersionV1;
  snapshotId: string;
  sourceDatasetId: string;
  sourceDataVersion: string;
  columnSchemaFingerprint: string;
  filterHash: string;
}

export interface ObservationContributionDimensionV1 {
  code: string;
  action: string;
}

export interface ObservationContributionPolicyV1 {
  schemaVersion: DistributionSchemaVersionV1;
  dimensions: ObservationContributionDimensionV1[];
}

export interface ResourceBudgetV1 {
  maxGroups: number;
  maxRowsPerGroup: number;
  maxTotalRows: number;
  maxTotalBytes: number;
  cancelToken: string | null;
}

export interface DistributionRequestV1 {
  schemaVersion: DistributionSchemaVersionV1;
  analysisId: string;
  configRevision: number;
  runId: string;
  sourceDatasetId: string | null;
  sourceDataVersion: string | null;
  mode: DistributionModeV1;
  yColumns: DistributionColumnRefV1[];
  weightColumnId: string | null;
  frequencyColumnId: string | null;
  byColumnIds: string[];
  filterExpr: FilterExprV1;
  observationPolicy: ObservationContributionPolicyV1;
  resourceBudget: ResourceBudgetV1;
  exact: boolean;
}

export type DistributionChartKindV1 =
  | "histogramData"
  | "boxPlotData"
  | "qqData"
  | "ppData"
  | "cdfData"
  | "fittedCurveData"
  | "diagnosticCoordinateData";

export interface DistributionChartProvenanceV1 {
  methodId: string;
  snapshotId: string;
}

export interface DistributionCoordinateV1 {
  x: number;
  y: number;
}

interface DistributionChartDataBaseV1 {
  schemaVersion: DistributionSchemaVersionV1;
  provenance: DistributionChartProvenanceV1;
}

export type DistributionChartDataV1 =
  | (DistributionChartDataBaseV1 & {
      kind: "histogramData";
      bins: Array<{ lower: number; upper: number; count: number }>;
    })
  | (DistributionChartDataBaseV1 & {
      kind: "boxPlotData";
      coordinates: {
        lowerWhisker: number;
        lowerQuartile: number;
        median: number;
        upperQuartile: number;
        upperWhisker: number;
        outliers: number[];
      };
    })
  | (DistributionChartDataBaseV1 & {
      kind: Exclude<DistributionChartKindV1, "histogramData" | "boxPlotData">;
      points: DistributionCoordinateV1[];
    });

export interface DistributionReportBlockV1 {
  schemaVersion: DistributionSchemaVersionV1;
  blockId: string;
  kind: string;
  titleKey: string;
  status: string;
  chartData: DistributionChartDataV1 | null;
}

export interface CapabilityDescriptorV1 {
  schemaVersion: DistributionSchemaVersionV1;
  capabilityId: string;
  methodSpecVersion: string;
  enabled: boolean;
}

export interface DistributionWorkspaceBootstrapV1 {
  schemaVersion: DistributionSchemaVersionV1;
  mode: DistributionModeV1;
  canRun: boolean;
  datasetCount: number;
  capabilities: CapabilityDescriptorV1[];
  observationPolicy: ObservationContributionPolicyV1;
  resourceBudget: ResourceBudgetV1;
}

export type BlackBoxValueV1 =
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "code"; value: string }
  | { kind: "numberList"; value: number[] }
  | { kind: "codeList"; value: string[] }
  | { kind: "null" };

export type BlackBoxStatusV1 = "available" | "unavailable" | "warning" | "error";
export type BlackBoxObservationV1 =
  | { kind: "numeric"; outputId: string; value: number }
  | { kind: "enumeration"; outputId: string; value: string }
  | { kind: "status"; outputId: string; value: BlackBoxStatusV1 };

export interface BlackBoxProvenanceV1 {
  toolVersion: string;
  inputHash: string;
  outputHash: string;
  legalReviewStatus: string;
}

export interface BlackBoxCaseV1 {
  schemaVersion: DistributionSchemaVersionV1;
  caseId: string;
  actionId: string;
  parameters: Record<string, BlackBoxValueV1>;
  observations: BlackBoxObservationV1[];
  warningCodes: string[];
  provenance: BlackBoxProvenanceV1;
}