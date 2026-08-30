import type { FieldRef } from "@/graphCore";

import { createDefaultGraph2DState, createDefaultGraph3DState, createDefaultMultivariateGraphState } from "@/components/graphBuilder/graphBuilderMode";
import type { EmbeddedGraphConfig } from "@/types/graphBuilder";
import type { FitYByXItem } from "@/types/fitYByX";

export type FitYByXRole = "response" | "factor";
export type FitYByXValidationError =
  | "missingResponse"
  | "missingFactor"
  | "duplicateRole"
  | "invalidResponse"
  | "invalidFactor";

function clone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => clone(entry)) as T;
  }
  if (typeof value === "object" && value !== null) {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = clone(entry);
    }
    return next as T;
  }
  return value;
}

function isContinuous(field: FieldRef): boolean {
  return field.type === "continuous";
}

function isFactor(field: FieldRef): boolean {
  return field.type === "nominal" || field.type === "ordinal";
}

function isDuplicate(field: FieldRef, other?: FieldRef): boolean {
  return other !== undefined && other.name === field.name;
}

export function canAssignFitYByXRole(
  role: FitYByXRole,
  field: FieldRef,
  other?: FieldRef,
): true | FitYByXValidationError {
  if (isDuplicate(field, other)) return "duplicateRole";
  if (role === "response") {
    return isContinuous(field) ? true : "invalidResponse";
  }
  return isFactor(field) ? true : "invalidFactor";
}

export function validateFitYByXRoles(input: {
  response?: FieldRef;
  factor?: FieldRef;
}): { ok: true } | { ok: false; error: FitYByXValidationError } {
  if (!input.response) return { ok: false, error: "missingResponse" };
  if (!input.factor) return { ok: false, error: "missingFactor" };

  const responseValidation = canAssignFitYByXRole("response", input.response, input.factor);
  if (responseValidation !== true) return { ok: false, error: responseValidation };

  const factorValidation = canAssignFitYByXRole("factor", input.factor, input.response);
  if (factorValidation !== true) return { ok: false, error: factorValidation };

  return { ok: true };
}

export function createDefaultFitYByXGraphConfig(input: {
  response: FieldRef;
  factor: FieldRef;
}): EmbeddedGraphConfig {
  const twoD = createDefaultGraph2DState();

  return {
    mode: "2d",
    modeStates: {
      twoD: {
        ...twoD,
        encoding: {
          x: clone(input.factor),
          y: clone(input.response),
        },
        multiX: [],
        multiY: [],
        elements: [
          { kind: "points", enabled: true },
          { kind: "boxplot", enabled: true },
        ],
      },
      threeD: createDefaultGraph3DState(),
      multivariate: createDefaultMultivariateGraphState(),
    },
    filters: [],
    sampling: { mode: "full" },
  };
}

export function createFitYByXItem(input: {
  id: string;
  name: string;
  sourceDatasetId: string;
  response: FieldRef;
  factor: FieldRef;
  createdAt: string;
}): FitYByXItem {
  return {
    id: input.id,
    name: input.name,
    sourceDatasetId: input.sourceDatasetId,
    response: clone(input.response),
    factor: clone(input.factor),
    graph: createDefaultFitYByXGraphConfig({
      response: input.response,
      factor: input.factor,
    }),
    createdAt: input.createdAt,
  };
}