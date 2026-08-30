import type { FieldRef } from "@/graphCore";

import { createDefaultGraph2DState, createDefaultGraph3DState, createDefaultMultivariateGraphState } from "@/components/graphBuilder/graphBuilderMode";
import type { EmbeddedGraphConfig } from "@/types/graphBuilder";
import type { FitYByXItem } from "@/types/fitYByX";
export {
  canAssignFitYByXRole,
  type FitYByXRole,
  type FitYByXValidationError,
  validateFitYByXRoles,
} from "./fitYByXRoles";

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