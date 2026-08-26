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
  analysisId: string;
  snapshotId: string;
  datasetId: string;
  sourceDataVersion: string;
  datasetGeneration: number;
  schemaFingerprint: string;
  filterFingerprint: string;
  createdAt: string;
}

export interface DistributionProgressV1 {
  runId: string;
  phase: string;
  current: number;
  total: number;
  messageKey: string;
  percent: number;
}

export interface DistributionCancelTokenV1 {
  cancelToken: string;
}

export type DistributionRunStatusV1 =
  | "running"
  | "completed"
  | "cancelled"
  | "stale"
  | "failed";

export interface DistributionRunStateV1 {
  runId: string;
  status: DistributionRunStatusV1;
  progress: DistributionProgressV1 | null;
  snapshotId: string;
  cancelToken: string;
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

export interface DistributionDocV1 {
  schemaVersion: string;
  analysisId: string;
  name: string;
  sourceDatasetId: string;
  status: string;
  loadStatus: DistributionLoadStatusV1;
  currentConfig: Record<string, unknown>;
  rawEnvelope?: Record<string, unknown>;
  rawText?: string;
}

export type DistributionLoadStatusV1 = "ready" | "unknownVersion" | "missingSource" | "corrupt";

export interface DerivedFormulaDocV1 {
  formulaId: string;
  schemaVersion: DistributionSchemaVersionV1;
  analysisId: string;
  sourceDatasetId: string;
  sourceColumnIds: string[];
  outputColumnName: string;
  ast: Record<string, unknown>;
  fingerprint: string;
}

export interface DistributionIssueV1 {
  analysisId: string;
  kind: DistributionLoadStatusV1;
  messageKey: string;
  schemaVersion: string;
  sourceDatasetId?: string;
}