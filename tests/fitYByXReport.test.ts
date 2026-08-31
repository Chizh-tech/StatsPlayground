import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  FitYByXBivariateResult,
  FitYByXItem,
  FitYByXNotComputableResult,
  FitYByXOnewayResult,
} from "../src/types/fitYByX.ts";
import {
  createFitYByXReportViewModel,
  formatFitYByXReportPValue,
  formatFitYByXReportValue,
} from "../src/components/fitYByX/FitYByXReport.tsx";
import type { FitYByXReportState } from "../src/components/fitYByX/useFitYByXReport.ts";

const VIEW_SOURCE_PATH = path.resolve(
  process.cwd(),
  "src/components/fitYByX/FitYByXView.tsx",
);

type TranslationValues = Record<string, string | number | null | undefined>;

function t(key: string, values?: TranslationValues): string {
  if (values == null) {
    return key;
  }

  const sorted = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(",");
  return `${key}|${sorted}`;
}

function readViewSource(): string {
  return readFileSync(VIEW_SOURCE_PATH, "utf8").replace(/\r\n/g, "\n");
}

function createItem(overrides: Partial<FitYByXItem> = {}): FitYByXItem {
  return {
    id: "fit-1",
    name: "Diameter vs Supplier",
    sourceDatasetId: "dataset-1",
    response: { name: "diameter", type: "continuous" },
    factor: { name: "supplier", type: "nominal" },
    personality: "oneway",
    graph: {
      mode: "2d",
      modeStates: {
        twoD: {
          encoding: {},
          multiX: [],
          multiY: [],
          elements: [],
        },
        threeD: {
          encoding: {},
          elements: [],
        },
        multivariate: {
          columns: [],
          elements: [],
        },
      },
      filters: [],
      sampling: { mode: "full" },
    },
    createdAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}

function makeSuccessState(result: FitYByXBivariateResult | FitYByXOnewayResult | FitYByXNotComputableResult): FitYByXReportState {
  return {
    status: "success",
    itemId: "fit-1",
    datasetId: "dataset-1",
    request: {
      datasetId: "dataset-1",
      generation: 7,
      responseColumn: "diameter",
      factorColumn: "supplier",
      personality: result.kind === "notComputable" ? result.personality : result.kind,
      confidenceLevel: 0.95,
    },
    result,
  };
}

function makeBivariateResult(overrides: Partial<FitYByXBivariateResult> = {}): FitYByXBivariateResult {
  return {
    kind: "bivariate",
    usedRows: 12,
    excludedRows: 3,
    confidenceLevel: 0.95,
    intercept: 1.23456789,
    slope: 0.0000123456789,
    summaryOfFit: {
      rSquared: 0.9988776655,
      adjustedRSquared: 0.8877665544,
      rootMeanSquareError: 0.0000987654321,
      meanOfResponse: 14.67891234,
      observationCount: 12,
    },
    lackOfFit: {
      state: "available",
      rows: [
        {
          source: "Lack Of Fit",
          degreesOfFreedom: 4,
          sumOfSquares: 0.123456789,
          meanSquare: 0.03086419725,
          fRatio: 2.2222222,
          pValue: 0.000031,
        },
        {
          source: "Pure Error",
          degreesOfFreedom: 6,
          sumOfSquares: 0.012345678,
          meanSquare: 0.002057613,
          fRatio: null,
          pValue: null,
        },
      ],
    },
    anova: [
      {
        source: "Model",
        degreesOfFreedom: 1,
        sumOfSquares: 6.543210987,
        meanSquare: 6.543210987,
        fRatio: 123.456789,
        pValue: 0.000009,
      },
      {
        source: "Error",
        degreesOfFreedom: 10,
        sumOfSquares: 0.987654321,
        meanSquare: 0.0987654321,
        fRatio: null,
        pValue: null,
      },
    ],
    parameterEstimates: [
      {
        term: "Intercept",
        estimate: 1.23456789,
        standardError: 0.0123456789,
        tRatio: 100.123456,
        pValue: 0.00008,
        lowerConfidenceLimit: 1.111111111,
        upperConfidenceLimit: 1.357913579,
      },
      {
        term: "supplier",
        estimate: 0.0000123456789,
        standardError: 0,
        tRatio: null,
        pValue: undefined as unknown as null,
        lowerConfidenceLimit: null,
        upperConfidenceLimit: null,
      },
    ],
    ...overrides,
  };
}

function makeOnewayResult(overrides: Partial<FitYByXOnewayResult> = {}): FitYByXOnewayResult {
  return {
    kind: "oneway",
    usedRows: 9,
    excludedRows: 1,
    confidenceLevel: 0.95,
    groupSummaries: [
      {
        group: "A",
        count: 4,
        mean: 10.24681012,
        standardDeviation: 0.123456789,
        standardError: 0.0617283945,
        lowerConfidenceLimit: 10.111111111,
        upperConfidenceLimit: 10.382509129,
      },
      {
        group: "B",
        count: 5,
        mean: 9.87654321,
        standardDeviation: null,
        standardError: null,
        lowerConfidenceLimit: null,
        upperConfidenceLimit: null,
      },
    ],
    anova: [
      {
        source: "Group",
        degreesOfFreedom: 1,
        sumOfSquares: 1.23456789,
        meanSquare: 1.23456789,
        fRatio: 4.56789123,
        pValue: 0.0002,
      },
      {
        source: "Error",
        degreesOfFreedom: 7,
        sumOfSquares: 0.76543219,
        meanSquare: 0.1093474557,
        fRatio: null,
        pValue: null,
      },
    ],
    effectSizes: {
      etaSquared: 0.617283945,
      omegaSquared: null,
    },
    ...overrides,
  };
}

function makeNotComputableResult(overrides: Partial<FitYByXNotComputableResult> = {}): FitYByXNotComputableResult {
  return {
    kind: "notComputable",
    personality: "oneway",
    reason: "insufficientGroups",
    usedRows: 2,
    excludedRows: 5,
    confidenceLevel: 0.95,
    ...overrides,
  };
}

function testValueFormattingContracts(): void {
  assert.equal(formatFitYByXReportValue(123.456789), "123.457");
  assert.equal(formatFitYByXReportValue(0.000123456789), "0.000123457");
  assert.equal(formatFitYByXReportValue(Number.POSITIVE_INFINITY), "—");
  assert.equal(formatFitYByXReportPValue(0.01234), "0.0123");
  assert.equal(formatFitYByXReportPValue(0.000031), "<0.0001");
  assert.equal(formatFitYByXReportPValue(undefined), "—");
}

function testBivariateViewModelSectionsAndFormatting(): void {
  const model = createFitYByXReportViewModel({
    item: createItem({ personality: "bivariate", factor: { name: "temperature", type: "continuous" } }),
    state: makeSuccessState(makeBivariateResult()),
    t,
    datasetMissing: false,
  });

  assert.equal(model.summary.personality, "fitYByX.personality.bivariate");
  assert.equal(model.summary.usedRows, "12");
  assert.equal(model.summary.excludedRows, "3");
  assert.deepEqual(
    model.sections.map((section) => section.key),
    ["summaryOfFit", "lackOfFit", "analysisOfVariance", "parameterEstimates"],
  );
  assert.equal(model.sections.every((section) => section.open), true);
  assert.equal(model.sections[0]?.rows[0]?.values[1], "0.998878");
  assert.equal(model.sections[1]?.rows[0]?.values.at(-1), "<0.0001");
  assert.equal(model.sections[2]?.rows[1]?.values.at(-1), "—");
  assert.equal(model.sections[3]?.rows[0]?.values.at(-1), "1.35791");
  assert.equal(model.sections[3]?.rows[1]?.values[2], "0");
  assert.equal(model.sections[3]?.rows[1]?.values[4], "—");
}

function testBivariateNotIdentifiableKeepsLocalizedLackOfFitSection(): void {
  const model = createFitYByXReportViewModel({
    item: createItem({ personality: "bivariate", factor: { name: "temperature", type: "continuous" } }),
    state: makeSuccessState(makeBivariateResult({
      lackOfFit: { state: "notIdentifiable" },
    })),
    t,
    datasetMissing: false,
  });

  assert.deepEqual(
    model.sections.map((section) => section.key),
    ["summaryOfFit", "lackOfFit", "analysisOfVariance", "parameterEstimates"],
  );
  assert.equal(model.sections[1]?.rows.length, 1);
  assert.equal(model.sections[1]?.rows[0]?.values[0], "fitYByX.report.lackOfFit.notIdentifiable");
}

function testOnewayViewModelSectionsAndFormatting(): void {
  const model = createFitYByXReportViewModel({
    item: createItem({ personality: "oneway" }),
    state: makeSuccessState(makeOnewayResult()),
    t,
    datasetMissing: false,
  });

  assert.equal(model.summary.personality, "fitYByX.personality.oneway");
  assert.deepEqual(
    model.sections.map((section) => section.key),
    ["groupSummary", "analysisOfVariance", "effectSize"],
  );
  assert.equal(model.sections[0]?.rows[0]?.values[2], "10.2468");
  assert.equal(model.sections[0]?.rows[1]?.values.at(-1), "—");
  assert.equal(model.sections[1]?.rows[0]?.values.at(-1), "0.0002");
  assert.equal(model.sections[2]?.rows[1]?.values[1], "—");
}

function testNotComputableViewModelShowsLocalizedReasonAndRowCounts(): void {
  const model = createFitYByXReportViewModel({
    item: createItem({ personality: "oneway" }),
    state: makeSuccessState(makeNotComputableResult()),
    t,
    datasetMissing: false,
  });

  assert.equal(model.summary.personality, "fitYByX.personality.oneway");
  assert.deepEqual(model.sections.map((section) => section.key), ["notComputable"]);
  assert.equal(model.sections[0]?.rows[0]?.values[1], "fitYByX.report.reason.insufficientGroups");
  assert.equal(model.sections[0]?.rows[1]?.values[1], "2");
  assert.equal(model.sections[0]?.rows[2]?.values[1], "5");
}

function testViewSourceContractsReportOrderAndIndependentHookInvocation(): void {
  const source = readViewSource();

  assert.match(
    source,
    /useFitYByXReport\(dataset \? item : null, dataset\?\.updatedAt \?\? null\)/,
    "FitYByXView must call useFitYByXReport with the Task 4-approved dataset-gated API.",
  );
  assert.match(
    source,
    /<div className="sp-fit-y-by-x-graph-shell">[\s\S]*?<GraphRuntime[\s\S]*?<\/div>[\s\S]*?<FitYByXReport/s,
    "FitYByXView must render the graph shell first and the report after it.",
  );
  assert.match(
    source,
    /sp-fit-y-by-x-analysis-root/,
    "FitYByXView must own the analysis root scroll container.",
  );
  assert.match(
    source,
    /sp-fit-y-by-x-summary-row[\s\S]*?fitYByX.personality/s,
    "FitYByXView summary must include the localized personality row.",
  );
}

testValueFormattingContracts();
testBivariateViewModelSectionsAndFormatting();
testBivariateNotIdentifiableKeepsLocalizedLackOfFitSection();
testOnewayViewModelSectionsAndFormatting();
testNotComputableViewModelShowsLocalizedReasonAndRowCounts();
testViewSourceContractsReportOrderAndIndependentHookInvocation();

console.log("fitYByX report presentation contract passed");