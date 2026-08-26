import type {
  CapabilityOverrideEnvelopeV1,
  DistributionAnalysisConfigV1,
  DistributionColumnInfoV1,
  DistributionConfigErrorV1,
} from "@/types/distribution";

export interface CapabilityOverrideValidatorV1 {
  capabilityId: string;
  payloadSchemaVersion: string;
  validate: (payload: Record<string, unknown>) => DistributionConfigErrorV1[];
}

export interface CapabilityOverrideRegistryV1 {
  hasCapability: (capabilityId: string) => boolean;
  validate: (envelope: CapabilityOverrideEnvelopeV1) => DistributionConfigErrorV1[];
}

const error = (
  code: string,
  messageKey: string,
  fieldPath: string,
): DistributionConfigErrorV1 => ({ code, messageKey, fieldPath });

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
    validate: (envelope) => {
      const validator = byKey.get(
        `${envelope.capabilityId}\u0000${envelope.payloadSchemaVersion}`,
      );
      if (!validator) {
        return [error(
          "distribution.config.unknownCapability",
          "distribution.errors.unknownCapability",
          "payload",
        )];
      }
      return validator.validate(envelope.payload);
    },
  };
}

const EMPTY_REGISTRY = createCapabilityOverrideRegistry([]);

const isNumeric = (column: DistributionColumnInfoV1) =>
  column.modelingType === "continuous" || column.modelingType === "discreteNumeric";

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
        fieldPath: `capabilityOverrides[${index}].payload${
          payloadError.fieldPath ? `.${payloadError.fieldPath}` : ""
        }`,
      });
    }
  });

  return errors;
}