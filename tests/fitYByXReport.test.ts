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
const LOCALES_DIR = path.resolve(process.cwd(), "src/i18n/locales");

type TranslationValues = Record<string, string | number | null | undefined>;

type LocaleTree = Record<string, LocaleTree | string>;

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

function readLocale(locale: string): LocaleTree {
  const localePath = path.join(LOCALES_DIR, `${locale}.json`);
  return JSON.parse(readFileSync(localePath, "utf8")) as LocaleTree;
}

function resolveLocaleValue(locale: LocaleTree, key: string): string | undefined {
  const value = key.split(".").reduce<LocaleTree | string | undefined>((current, segment) => {
    if (current == null || typeof current === "string") {
      return undefined;
    }
    return current[segment];
  }, locale);

  return typeof value === "string" ? value : undefined;
}

function createLocaleTranslator(locale: string): (key: string, values?: TranslationValues) => string {
  const messages = readLocale(locale);
  return (key: string, values?: TranslationValues): string => {
    const template = resolveLocaleValue(messages, key);
    if (template == null) {
      return key;
    }

    if (values == null) {
      return template;
    }

    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => {
      const value = values[name];
      return value == null ? "" : String(value);
    });
  };
}

function requireLocaleValue(locale: string, key: string): string {
  const value = resolveLocaleValue(readLocale(locale), key);
  assert.ok(value, `Missing locale key ${locale}:${key}`);
  return value;
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
    effectSummary: [
      {
        term: "Slope",
        estimate: 0.0000123456789,
        standardError: 0,
        tRatio: null,
        pValue: null,
        isSignificant: null,
      },
      {
        term: "Intercept",
        estimate: 1.23456789,
        standardError: 0.0123456789,
        tRatio: 100.123456,
        pValue: 0.00008,
        isSignificant: true,
      },
    ],
    predictionProfiler: [
      { label: "Low", factorValue: 10, predictedResponse: 1.23469135 },
      { label: "Center", factorValue: 20, predictedResponse: 1.2348148 },
      { label: "High", factorValue: 30, predictedResponse: 1.23493826 },
    ],
    actualByPredicted: [
      { predicted: 1.23469135, actual: 1.236 },
      { predicted: 1.2348148, actual: 1.2347 },
    ],
    residualByPredicted: [
      { predicted: 1.23469135, residual: 0.00130865 },
      { predicted: 1.2348148, residual: -0.0001148 },
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
    [
      "summaryOfFit",
      "effectSummary",
      "predictionProfiler",
      "lackOfFit",
      "analysisOfVariance",
      "parameterEstimates",
      "actualByPredicted",
      "residualByPredicted",
    ],
  );
  assert.equal(model.sections.every((section) => section.open), true);
  assert.equal(model.sections[0]?.rows[0]?.numericColumns, undefined);
  assert.deepEqual(model.sections[0]?.rows[1]?.numericColumns, [1]);
  assert.deepEqual(model.sections[0]?.rows[0]?.values, [
    "fitYByX.report.summaryOfFit.fittedEquation",
    "fitYByX.report.summaryOfFit.equationTemplate|factor=temperature,intercept=1.23457,response=diameter,slope=0.0000123457",
  ]);
  assert.equal(model.sections[0]?.rows[1]?.values[1], "0.998878");
  assert.equal(model.sections[1]?.rows[0]?.values.at(-1), "—");
  assert.equal(model.sections[1]?.rows[1]?.values.at(-1), "fitYByX.report.boolean.yes");
  assert.equal(model.sections[2]?.rows[1]?.values[0], "fitYByX.report.profiler.Center");
  assert.equal(model.sections[3]?.rows[0]?.values.at(-1), "<0.0001");
  assert.equal(model.sections[4]?.rows[1]?.values.at(-1), "—");
  assert.equal(model.sections[5]?.rows[0]?.values.at(-1), "1.35791");
  assert.equal(model.sections[5]?.rows[1]?.values[2], "0");
  assert.equal(model.sections[5]?.rows[1]?.values[4], "—");
  assert.equal(model.sections[6]?.rows[0]?.values[0], "1.23469");
  assert.equal(model.sections[7]?.rows[1]?.values[1], "-0.0001148");
}

function testBivariateEquationRowFormatsPositiveAndNegativeSlopes(): void {
  const positiveModel = createFitYByXReportViewModel({
    item: createItem({
      personality: "bivariate",
      response: { name: "diameter", type: "continuous" },
      factor: { name: "temperature", type: "continuous" },
    }),
    state: makeSuccessState(makeBivariateResult({ intercept: 1.23456789, slope: 0.0000123456789 })),
    t,
    datasetMissing: false,
  });
  const negativeModel = createFitYByXReportViewModel({
    item: createItem({
      personality: "bivariate",
      response: { name: "torque", type: "continuous" },
      factor: { name: "speed", type: "continuous" },
    }),
    state: makeSuccessState(makeBivariateResult({ intercept: 4.56789123, slope: -0.0000123456789 })),
    t,
    datasetMissing: false,
  });

  assert.deepEqual(positiveModel.sections[0]?.rows[0]?.values, [
    "fitYByX.report.summaryOfFit.fittedEquation",
    "fitYByX.report.summaryOfFit.equationTemplate|factor=temperature,intercept=1.23457,response=diameter,slope=0.0000123457",
  ]);
  assert.deepEqual(negativeModel.sections[0]?.rows[0]?.values, [
    "fitYByX.report.summaryOfFit.fittedEquation",
    "fitYByX.report.summaryOfFit.equationTemplate|factor=speed,intercept=4.56789,response=torque,slope=-0.0000123457",
  ]);
  assert.doesNotMatch(
    negativeModel.sections[0]?.rows[0]?.values[1] ?? "",
    /\+\s+-/,
    "Negative slopes must not render with a '+ -' sequence.",
  );
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
    [
      "summaryOfFit",
      "effectSummary",
      "predictionProfiler",
      "lackOfFit",
      "analysisOfVariance",
      "parameterEstimates",
      "actualByPredicted",
      "residualByPredicted",
    ],
  );
  assert.equal(model.sections[3]?.rows.length, 1);
  assert.equal(model.sections[3]?.rows[0]?.values[0], "fitYByX.report.lackOfFit.notIdentifiable");
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

function testLocaleParityForKnownReportLabels(): void {
  const keys = [
    "fitYByX.report.summaryOfFit.fittedEquation",
    "fitYByX.report.summaryOfFit.equationTemplate",
    "fitYByX.report.source.Between",
    "fitYByX.report.source.Within",
    "fitYByX.report.source.Total",
    "fitYByX.report.source.Model",
    "fitYByX.report.source.Error",
    "fitYByX.report.source.Lack Of Fit",
    "fitYByX.report.source.Pure Error",
    "fitYByX.report.source.Total Error",
    "fitYByX.report.term.Intercept",
    "fitYByX.report.term.Slope",
    "fitYByX.report.section.effectSummary",
    "fitYByX.report.section.predictionProfiler",
    "fitYByX.report.section.actualByPredicted",
    "fitYByX.report.section.residualByPredicted",
    "fitYByX.report.boolean.yes",
    "fitYByX.report.boolean.no",
    "fitYByX.report.profiler.Low",
    "fitYByX.report.profiler.Center",
    "fitYByX.report.profiler.High",
  ];

  for (const locale of ["en", "vi", "zh-CN", "zh-TW"]) {
    for (const key of keys) {
      requireLocaleValue(locale, key);
    }
  }
}

function testKnownBivariateLabelsLocalizeOutsideEnglishAndUnknownLabelsPassThrough(): void {
  const zhCN = createLocaleTranslator("zh-CN");
  const model = createFitYByXReportViewModel({
    item: createItem({
      personality: "bivariate",
      response: { name: "直径", type: "continuous" },
      factor: { name: "温度", type: "continuous" },
    }),
    state: makeSuccessState(makeBivariateResult({
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
          source: "Mystery Source",
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
          term: "Slope",
          estimate: 0.0000123456789,
          standardError: 0,
          tRatio: null,
          pValue: undefined as unknown as null,
          lowerConfidenceLimit: null,
          upperConfidenceLimit: null,
        },
      ],
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
          {
            source: "Total Error",
            degreesOfFreedom: 10,
            sumOfSquares: 0.135802467,
            meanSquare: 0.0135802467,
            fRatio: null,
            pValue: null,
          },
        ],
      },
    })),
    t: zhCN,
    datasetMissing: false,
  });

  assert.equal(model.sections[0]?.rows[0]?.values[0], "拟合方程");
  assert.equal(model.sections[0]?.rows[0]?.values[1], "直径 = 1.23457 + 0.0000123457 * 温度");
  assert.equal(model.sections[3]?.rows[0]?.values[0], "失拟");
  assert.equal(model.sections[3]?.rows[1]?.values[0], "纯误差");
  assert.equal(model.sections[3]?.rows[2]?.values[0], "总误差");
  assert.equal(model.sections[4]?.rows[0]?.values[0], "模型");
  assert.equal(model.sections[4]?.rows[1]?.values[0], "Mystery Source");
  assert.equal(model.sections[5]?.rows[0]?.values[0], "截距");
  assert.equal(model.sections[5]?.rows[1]?.values[0], "斜率");

  const rendered = model.sections.flatMap((section) => section.rows).flatMap((row) => row.values);
  assert.equal(rendered.includes("Model"), false);
  assert.equal(rendered.includes("Lack Of Fit"), false);
  assert.equal(rendered.includes("Pure Error"), false);
  assert.equal(rendered.includes("Total Error"), false);
  assert.equal(rendered.includes("Intercept"), false);
  assert.equal(rendered.includes("Slope"), false);
}

function testKnownOnewaySourcesLocalizeOutsideEnglish(): void {
  const zhTW = createLocaleTranslator("zh-TW");
  const model = createFitYByXReportViewModel({
    item: createItem({ personality: "oneway" }),
    state: makeSuccessState(makeOnewayResult({
      anova: [
        {
          source: "Between",
          degreesOfFreedom: 1,
          sumOfSquares: 1.23456789,
          meanSquare: 1.23456789,
          fRatio: 4.56789123,
          pValue: 0.0002,
        },
        {
          source: "Within",
          degreesOfFreedom: 7,
          sumOfSquares: 0.76543219,
          meanSquare: 0.1093474557,
          fRatio: null,
          pValue: null,
        },
        {
          source: "Total",
          degreesOfFreedom: 8,
          sumOfSquares: 1.99999999,
          meanSquare: null,
          fRatio: null,
          pValue: null,
        },
      ],
    })),
    t: zhTW,
    datasetMissing: false,
  });

  const anovaRows = model.sections[1]?.rows ?? [];
  assert.equal(anovaRows[0]?.values[0], "組間");
  assert.equal(anovaRows[1]?.values[0], "組內");
  assert.equal(anovaRows[2]?.values[0], "總計");
  assert.equal(anovaRows.some((row) => row.values[0] === "Between"), false);
  assert.equal(anovaRows.some((row) => row.values[0] === "Within"), false);
  assert.equal(anovaRows.some((row) => row.values[0] === "Total"), false);
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
testBivariateEquationRowFormatsPositiveAndNegativeSlopes();
testBivariateNotIdentifiableKeepsLocalizedLackOfFitSection();
testOnewayViewModelSectionsAndFormatting();
testLocaleParityForKnownReportLabels();
testKnownBivariateLabelsLocalizeOutsideEnglishAndUnknownLabelsPassThrough();
testKnownOnewaySourcesLocalizeOutsideEnglish();
testNotComputableViewModelShowsLocalizedReasonAndRowCounts();
testViewSourceContractsReportOrderAndIndependentHookInvocation();

console.log("fitYByX report presentation contract passed");