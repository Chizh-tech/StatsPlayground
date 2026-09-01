import type {
  CapabilityOverrideEnvelopeV1,
  DistributionAnalysisConfigV1,
  DistributionColumnInfoV1,
  DistributionConfigErrorV1,
  DistributionContinuousFitConfigV1,
  DistributionFitCapabilityV1,
  ContinuousDistributionIdV1,
  DistributionVisualDiagnosticsConfigV1,
} from "@/types/distribution";

export interface CapabilityOverrideValidatorV1 {
  capabilityId: string;
  payloadSchemaVersion: string;
  validate: (payload: Record<string, unknown>) => DistributionConfigErrorV1[];
}

export interface CapabilityOverrideRegistryV1 {
  hasCapability: (capabilityId: string) => boolean;
  hasCapabilityVersion: (capabilityId: string, payloadSchemaVersion: string) => boolean;
  validate: (envelope: CapabilityOverrideEnvelopeV1) => DistributionConfigErrorV1[];
}

export const DISTRIBUTION_FIT_CAPABILITY_REGISTRY: DistributionFitCapabilityV1[] = [
  {
    distributionId: "normal",
    methodId: "fit.normal.mle.v1",
    methodVersion: "1.0.0",
    parameterizationId: "normal.locationScale.v1",
    implemented: true,
    compatibilityStatus: "compatibilityPending",
  },
  {
    distributionId: "lognormal",
    methodId: "fit.lognormal.mle.v1",
    methodVersion: "1.0.0",
    parameterizationId: "lognormal.logLocationLogScale.v1",
    implemented: true,
    compatibilityStatus: "compatibilityPending",
  },
  {
    distributionId: "exponential",
    methodId: "fit.exponential.location0.mle.v1",
    methodVersion: "1.0.0",
    parameterizationId: "exponential.scaleLocation0.v1",
    implemented: true,
    compatibilityStatus: "compatibilityPending",
  },
  {
    distributionId: "gamma",
    methodId: "fit.gamma.shapeScale.mle.v1",
    methodVersion: "1.0.0",
    parameterizationId: "gamma.shapeScale.location0.v1",
    implemented: true,
    compatibilityStatus: "compatibilityPending",
  },
  {
    distributionId: "weibull",
    methodId: "fit.weibull.shapeScale.mle.v1",
    methodVersion: "1.0.0",
    parameterizationId: "weibull.shapeScale.location0.v1",
    implemented: true,
    compatibilityStatus: "compatibilityPending",
  },
] as const;

const error = (
  code: string,
  messageKey: string,
  fieldPath: string,
): DistributionConfigErrorV1 => ({ code, messageKey, fieldPath });

export function createDefaultDistributionVisualDiagnosticsConfig(): DistributionVisualDiagnosticsConfigV1 {
  return {
    histogram: {
      method: "jmpAuto",
      fixedCount: null,
      fixedWidth: null,
    },
    normalQuantileConfidenceLevel: 0.95,
  };
}

export function createDefaultDistributionContinuousFitConfig(): DistributionContinuousFitConfigV1 {
  return {
    enabledDistributionIds: [],
    fitAll: false,
    diagnostics: {
      goodnessOfFit: false,
      qqPlot: false,
      cdfPlot: false,
      ppPlot: false,
    },
  };
}

export function normalizeDistributionAnalysisConfig(
  config: DistributionAnalysisConfigV1,
): DistributionAnalysisConfigV1 {
  return {
    ...config,
    continuousFit: config.continuousFit ?? createDefaultDistributionContinuousFitConfig(),
    visualDiagnostics: config.visualDiagnostics ?? createDefaultDistributionVisualDiagnosticsConfig(),
  };
}

export function validateDistributionContinuousFitConfig(
  continuousFit: DistributionContinuousFitConfigV1,
): DistributionConfigErrorV1[] {
  const errors: DistributionConfigErrorV1[] = [];
  const implementedIds = new Set(
    DISTRIBUTION_FIT_CAPABILITY_REGISTRY
      .filter((capability) => capability.implemented)
      .map((capability) => capability.distributionId),
  );
  const seenDistributionIds = new Set<ContinuousDistributionIdV1>();
  continuousFit.enabledDistributionIds.forEach((distributionId, index) => {
    if (!implementedIds.has(distributionId)) {
      errors.push(error(
        "distribution.config.unknownContinuousFitCapability",
        "distribution.errors.unknownContinuousFitCapability",
        `continuousFit.enabledDistributionIds[${index}]`,
      ));
      return;
    }
    if (seenDistributionIds.has(distributionId)) {
      errors.push(error(
        "distribution.config.duplicateContinuousFitCapability",
        "distribution.errors.duplicateContinuousFitCapability",
        `continuousFit.enabledDistributionIds[${index}]`,
      ));
    }
    seenDistributionIds.add(distributionId);
  });
  return errors;
}

export function validateDistributionVisualDiagnosticsConfig(
  visualDiagnostics: DistributionVisualDiagnosticsConfigV1,
): DistributionConfigErrorV1[] {
  const errors: DistributionConfigErrorV1[] = [];
  const histogram = visualDiagnostics.histogram;

  if (histogram.method === "fixedCount") {
    if (
      histogram.fixedCount === null ||
      !Number.isFinite(histogram.fixedCount) ||
      !Number.isInteger(histogram.fixedCount) ||
      histogram.fixedCount < 1 ||
      histogram.fixedCount > 1000
    ) {
      errors.push(error(
        "distribution.config.histogramFixedCountOutOfRange",
        "distribution.errors.histogramFixedCountOutOfRange",
        "visualDiagnostics.histogram.fixedCount",
      ));
    }
  }

  if (histogram.method === "fixedWidth") {
    if (
      histogram.fixedWidth === null ||
      !Number.isFinite(histogram.fixedWidth) ||
      histogram.fixedWidth <= 0
    ) {
      errors.push(error(
        "distribution.config.histogramFixedWidthInvalid",
        "distribution.errors.histogramFixedWidthInvalid",
        "visualDiagnostics.histogram.fixedWidth",
      ));
    }
  }

  if (
    !Number.isFinite(visualDiagnostics.normalQuantileConfidenceLevel) ||
    visualDiagnostics.normalQuantileConfidenceLevel <= 0 ||
    visualDiagnostics.normalQuantileConfidenceLevel >= 1
  ) {
    errors.push(error(
      "distribution.config.normalQuantileConfidenceOutOfRange",
      "distribution.errors.normalQuantileConfidenceOutOfRange",
      "visualDiagnostics.normalQuantileConfidenceLevel",
    ));
  }

  return errors;
}

export function createCapabilityOverrideRegistry(
  validators: readonly CapabilityOverrideValidatorV1[],
): CapabilityOverrideRegistryV1 {
  const byKey = new Map<string, CapabilityOverrideValidatorV1>();
  const capabilityIds = new Set<string>();
  for (const validator of validators) {
    const key = `${validator.capabilityId}\u0000${validator.payloadSchemaVersion}`;
    if (byKey.has(key)) {
      throw new Error(`Duplicate capability validator: ${validator.capabilityId}`);
    }
    byKey.set(key, validator);
    capabilityIds.add(validator.capabilityId);
  }
  return {
    hasCapability: (capabilityId) => capabilityIds.has(capabilityId),
    hasCapabilityVersion: (capabilityId, payloadSchemaVersion) =>
      byKey.has(`${capabilityId}\u0000${payloadSchemaVersion}`),
    validate: (envelope) => {
      if (!capabilityIds.has(envelope.capabilityId)) {
        return [error(
          "distribution.config.unknownCapability",
          "distribution.errors.unknownCapability",
          "capabilityId",
        )];
      }
      const validator = byKey.get(
        `${envelope.capabilityId}\u0000${envelope.payloadSchemaVersion}`,
      );
      if (!validator) {
        return [error(
          "distribution.config.unknownCapabilityVersion",
          "distribution.errors.unknownCapabilityVersion",
          "payloadSchemaVersion",
        )];
      }
      return validator.validate(envelope.payload).map((payloadError) => ({
        ...payloadError,
        fieldPath: `payload${payloadError.fieldPath ? `.${payloadError.fieldPath}` : ""}`,
      }));
    },
  };
}

const EMPTY_REGISTRY = createCapabilityOverrideRegistry([]);
export const NORMAL_CAPABILITY_ID = "capability.normal.individuals";

const normalCapabilityValidator: CapabilityOverrideValidatorV1 = {
  capabilityId: NORMAL_CAPABILITY_ID,
  payloadSchemaVersion: "1",
  validate: (payload) => {
    const errors: DistributionConfigErrorV1[] = [];
    const allowed = new Set(["lsl", "target", "usl"]);
    if (Object.keys(payload).some((key) => !allowed.has(key))) {
      errors.push(error(
        "capability.invalidOverride.v1",
        "distribution.errors.invalidCapabilityOverride",
        "",
      ));
      return errors;
    }
    const read = (key: "lsl" | "target" | "usl") => {
      const value = payload[key];
      if (value === null || value === undefined) return null;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(error(
          "capability.invalidOverride.v1",
          "distribution.errors.invalidCapabilityOverride",
          key,
        ));
        return null;
      }
      return value;
    };
    const lsl = read("lsl");
    const target = read("target");
    const usl = read("usl");
    if (lsl !== null && usl !== null && lsl >= usl) {
      errors.push(error(
        "capability.invalidOverride.v1",
        "distribution.errors.invalidCapabilityOverride",
        "usl",
      ));
    }
    if ((lsl !== null && target !== null && target < lsl) ||
        (usl !== null && target !== null && target > usl)) {
      errors.push(error(
        "capability.invalidOverride.v1",
        "distribution.errors.invalidCapabilityOverride",
        "target",
      ));
    }
    return errors;
  },
};

export const DISTRIBUTION_CAPABILITY_OVERRIDE_REGISTRY =
  createCapabilityOverrideRegistry([normalCapabilityValidator]);

const isNumeric = (column: DistributionColumnInfoV1) =>
  column.modelingType === "continuous" || column.modelingType === "discreteNumeric";

export function isDistributionMenuEnabled(activeDatasetId: string | null): boolean {
  return activeDatasetId !== null;
}

export function validateDistributionConfig(
  config: DistributionAnalysisConfigV1,
  columns: readonly DistributionColumnInfoV1[],
  registry: CapabilityOverrideRegistryV1 = EMPTY_REGISTRY,
): DistributionConfigErrorV1[] {
  const errors: DistributionConfigErrorV1[] = [];
  const byId = new Map(columns.map((column) => [column.columnId, column]));
  const yIds = new Set<string>();

  if (config.yColumns.length === 0) {
    errors.push(error(
      "distribution.config.yRequired",
      "distribution.errors.yRequired",
      "yColumns",
    ));
  }
  config.yColumns.forEach((ref, index) => {
    const column = byId.get(ref.columnId);
    if (!column) {
      errors.push(error(
        "distribution.config.columnUnknown",
        "distribution.errors.columnUnknown",
        `yColumns[${index}]`,
      ));
      return;
    }
    if (yIds.has(ref.columnId)) {
      errors.push(error(
        "distribution.config.roleDuplicate",
        "distribution.errors.roleDuplicate",
        `yColumns[${index}]`,
      ));
    }
    yIds.add(ref.columnId);
    if (column.modelingType !== "continuous" || ref.modelingType !== "continuous") {
      errors.push(error(
        "distribution.config.yTypeIncompatible",
        "distribution.errors.yTypeIncompatible",
        `yColumns[${index}]`,
      ));
    }
  });

  if (!Number.isFinite(config.confidenceLevel) ||
      config.confidenceLevel <= 0 || config.confidenceLevel >= 1) {
    errors.push(error(
      "distribution.config.confidenceOutOfRange",
      "distribution.errors.confidenceOutOfRange",
      "confidenceLevel",
    ));
  }

  const visualDiagnostics =
    config.visualDiagnostics ?? createDefaultDistributionVisualDiagnosticsConfig();
  errors.push(...validateDistributionVisualDiagnosticsConfig(visualDiagnostics));

  const continuousFit = config.continuousFit ?? createDefaultDistributionContinuousFitConfig();
  errors.push(...validateDistributionContinuousFitConfig(continuousFit));

  const occupied = new Set(yIds);
  const validateSingleton = (
    columnId: string | null,
    fieldPath: "weightColumnId" | "frequencyColumnId",
  ) => {
    if (!columnId) return;
    if (occupied.has(columnId)) {
      errors.push(error(
        "distribution.config.roleConflict",
        "distribution.errors.roleConflict",
        fieldPath,
      ));
      return;
    }
    occupied.add(columnId);
    const column = byId.get(columnId);
    if (!column) {
      errors.push(error(
        "distribution.config.columnUnknown",
        "distribution.errors.columnUnknown",
        fieldPath,
      ));
      return;
    }
    if (fieldPath === "weightColumnId" && !isNumeric(column)) {
      errors.push(error(
        "distribution.config.weightTypeIncompatible",
        "distribution.errors.weightTypeIncompatible",
        fieldPath,
      ));
    }
    if (fieldPath === "frequencyColumnId" && !column.integerCompatible) {
      errors.push(error(
        "distribution.config.freqNotIntegerCompatible",
        "distribution.errors.freqNotIntegerCompatible",
        fieldPath,
      ));
    }
  };
  validateSingleton(config.weightColumnId, "weightColumnId");
  validateSingleton(config.frequencyColumnId, "frequencyColumnId");

  config.byColumnIds.forEach((columnId, index) => {
    if (occupied.has(columnId)) {
      errors.push(error(
        "distribution.config.roleConflict",
        "distribution.errors.roleConflict",
        `byColumnIds[${index}]`,
      ));
      return;
    }
    occupied.add(columnId);
    if (!byId.has(columnId)) {
      errors.push(error(
        "distribution.config.columnUnknown",
        "distribution.errors.columnUnknown",
        `byColumnIds[${index}]`,
      ));
    }
  });

  const seenEnabled = new Set<string>();
  config.enabledCapabilityIds.forEach((capabilityId, index) => {
    if (seenEnabled.has(capabilityId)) {
      errors.push(error(
        "distribution.config.duplicateCapability",
        "distribution.errors.duplicateCapability",
        `enabledCapabilityIds[${index}]`,
      ));
    }
    seenEnabled.add(capabilityId);
    if (!registry.hasCapability(capabilityId)) {
      errors.push(error(
        "distribution.config.unknownCapability",
        "distribution.errors.unknownCapability",
        `enabledCapabilityIds[${index}]`,
      ));
    }
  });

  const seenOverrides = new Set<string>();
  config.capabilityOverrides.forEach((envelope, index) => {
    if (seenOverrides.has(envelope.capabilityId)) {
      errors.push(error(
        "distribution.config.duplicateCapabilityOverride",
        "distribution.errors.duplicateCapabilityOverride",
        "capabilityOverrides",
      ));
      return;
    }
    seenOverrides.add(envelope.capabilityId);
    const payloadErrors = registry.validate(envelope);
    for (const payloadError of payloadErrors) {
      errors.push({
        ...payloadError,
        fieldPath: `capabilityOverrides[${index}].${payloadError.fieldPath}`,
      });
    }
  });

  return errors;
}