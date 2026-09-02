import type { FieldRef } from "@/graphCore";

import {
  createDefaultGraph2DState,
  createDefaultGraph3DState,
  createDefaultMultivariateGraphState,
} from "../graphBuilder/graphBuilderMode";
import type { EmbeddedGraphConfig } from "@/types/graphBuilder";
import type {
  FitYByXConstructModelEffects,
  FitYByXItem,
} from "@/types/fitYByX";
import {
  DEFAULT_CONSTRUCT_MODEL_EFFECTS,
  DEFAULT_FACTORIAL_DEGREE,
  deriveFitYByXPersonality,
  normalizeConstructModelEffects,
  normalizeFactorialDegree,
} from "./fitYByXModel";
export {
  DEFAULT_CONSTRUCT_MODEL_EFFECTS,
  DEFAULT_FACTORIAL_DEGREE,
  deriveFitYByXPersonality,
  normalizeConstructModelEffects,
} from "./fitYByXModel";
export {
  canAssignFitYByXRole,
  type FitYByXRole,
  type FitYByXValidationError,
  validateFitYByXRoles,
} from "./fitYByXRoles";
import { validateFitYByXRoles } from "./fitYByXRoles";

export class FitYByXRoleValidationError extends Error {
  readonly code: import("./fitYByXRoles").FitYByXValidationError;

  constructor(code: import("./fitYByXRoles").FitYByXValidationError) {
    super(`Invalid Fit Y by X roles: ${code}`);
    this.name = "FitYByXRoleValidationError";
    this.code = code;
  }
}

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

function createOnewayFitYByXGraphConfig(input: {
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

function createBivariateFitYByXGraphConfig(input: {
  response: FieldRef;
  factor: FieldRef;
  constructModelEffects?: FitYByXConstructModelEffects;
  factorialDegree?: number;
}): EmbeddedGraphConfig {
  const twoD = createDefaultGraph2DState();
  const degree = resolvePolynomialDegree(input.constructModelEffects, input.factorialDegree);

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
          { kind: "fitline", enabled: true, options: { fitType: "polynomial", degree, showFitCI: true } },
        ],
      },
      threeD: createDefaultGraph3DState(),
      multivariate: createDefaultMultivariateGraphState(),
    },
    filters: [],
    sampling: { mode: "full" },
  };
}

export function createDefaultFitYByXGraphConfig(input: {
  response: FieldRef;
  factor: FieldRef;
  constructModelEffects?: FitYByXConstructModelEffects;
  factorialDegree?: number;
}): EmbeddedGraphConfig {
  return deriveFitYByXPersonality(input.factor) === "bivariate"
    ? createBivariateFitYByXGraphConfig(input)
    : createOnewayFitYByXGraphConfig(input);
}

function resolvePolynomialDegree(
  constructModelEffects: FitYByXConstructModelEffects | undefined,
  factorialDegree: number | undefined,
): number {
  switch (constructModelEffects ?? DEFAULT_CONSTRUCT_MODEL_EFFECTS) {
    case "responseSurface":
      return 2;
    case "factorialToDegree":
      return normalizeFactorialDegree(factorialDegree);
    case "fullFactorial":
    default:
      return 1;
  }
}

export function createFitYByXItem(input: {
  id: string;
  name: string;
  sourceDatasetId: string;
  response: FieldRef;
  factor: FieldRef;
  constructModelEffects?: FitYByXConstructModelEffects;
  factorialDegree?: number;
  createdAt: string;
}): FitYByXItem {
  const validation = validateFitYByXRoles({ response: input.response, factor: input.factor });
  if (!validation.ok) {
    throw new FitYByXRoleValidationError(validation.error);
  }

  const personality = deriveFitYByXPersonality(input.factor);
  const normalizedModel = normalizeConstructModelEffects({
    personality,
    constructModelEffects: input.constructModelEffects,
    factorialDegree: input.factorialDegree,
  });

  return {
    id: input.id,
    name: input.name,
    sourceDatasetId: input.sourceDatasetId,
    response: clone(input.response),
    factor: clone(input.factor),
    personality,
    ...normalizedModel,
    graph: createDefaultFitYByXGraphConfig({
      response: input.response,
      factor: input.factor,
      constructModelEffects: normalizedModel.constructModelEffects,
      factorialDegree: normalizedModel.factorialDegree,
    }),
    createdAt: input.createdAt,
  };
}