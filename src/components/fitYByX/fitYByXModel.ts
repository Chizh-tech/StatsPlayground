import type { FieldRef } from "@/graphCore";
import type { FitYByXConstructModelEffects, FitYByXPersonality } from "@/types/fitYByX";

export const DEFAULT_FACTORIAL_DEGREE = 2;
export const DEFAULT_CONSTRUCT_MODEL_EFFECTS: FitYByXConstructModelEffects = "fullFactorial";

export function deriveFitYByXPersonality(factor: FieldRef): FitYByXPersonality {
  return factor.type === "continuous" ? "bivariate" : "oneway";
}

export function normalizeConstructModelEffects(input: {
  personality: FitYByXPersonality;
  constructModelEffects?: FitYByXConstructModelEffects;
  factorialDegree?: number;
}): { constructModelEffects?: FitYByXConstructModelEffects; factorialDegree?: number } {
  if (input.personality !== "bivariate") {
    return {};
  }
  const constructModelEffects = input.constructModelEffects ?? DEFAULT_CONSTRUCT_MODEL_EFFECTS;
  if (constructModelEffects === "factorialToDegree") {
    return {
      constructModelEffects,
      factorialDegree: normalizeFactorialDegree(input.factorialDegree),
    };
  }
  return {
    constructModelEffects,
  };
}

export function normalizeFactorialDegree(value: number | undefined): number {
  if (!Number.isInteger(value)) {
    return DEFAULT_FACTORIAL_DEGREE;
  }
  return Math.max(1, Math.min(2, value));
}

export function resolveFitYByXPolynomialDegree(
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
