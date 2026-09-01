import type { FieldRef } from "@/graphCore";
import type { FitModelItem, FitModelTerm } from "@/types/fitModel";

export type FitModelValidationReason =
  | "missingResponse"
  | "missingTerms"
  | "invalidTermKind"
  | "invalidTermArity"
  | "sameColumnInteraction"
  | "responseInModel"
  | "nonContinuousResponse"
  | "nonContinuousPredictor"
  | "duplicateTerm"
  | "missingMainEffect";

export type FitModelValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason: FitModelValidationReason;
      columnName?: string;
      termKey?: string;
      termKind?: string;
    };

export class FitModelValidationError extends Error {
  readonly result: Exclude<FitModelValidationResult, { ok: true }>;

  constructor(result: Exclude<FitModelValidationResult, { ok: true }>) {
    super(`Invalid Fit Model definition: ${result.reason}`);
    this.name = "FitModelValidationError";
    this.result = result;
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

export function canonicalInteraction(first: string, second: string): [string, string] {
  return first.localeCompare(second) <= 0 ? [first, second] : [second, first];
}

export function canonicalizeFitModelTerms(terms: readonly FitModelTerm[]): FitModelTerm[] {
  return terms.map((term) => {
    if (term.kind !== "interaction") {
      return {
        kind: term.kind,
        columnNames: [...term.columnNames],
      };
    }

    if (term.columnNames.length !== 2) {
      return {
        kind: term.kind,
        columnNames: [...term.columnNames],
      };
    }

    const [first, second] = term.columnNames;
    return {
      kind: "interaction",
      columnNames: canonicalInteraction(first, second),
    };
  });
}

function termKey(term: FitModelTerm): string {
  if (term.kind === "main") {
    return `main:${term.columnNames[0] ?? ""}`;
  }
  return `interaction:${(term.columnNames[0] ?? "")}*${(term.columnNames[1] ?? "")}`;
}

function duplicateKey(term: FitModelTerm): string {
  if (term.kind === "main") {
    return `main\u0000${term.columnNames[0] ?? ""}`;
  }

  const left = term.columnNames[0] ?? "";
  const right = term.columnNames[1] ?? "";
  return `interaction\u0000${left.length}:${left}\u0000${right.length}:${right}`;
}

export function validateFitModelDefinition(input: {
  response: FieldRef | null;
  terms: readonly FitModelTerm[];
  fields?: readonly FieldRef[];
}): FitModelValidationResult {
  if (!input.response) {
    return { ok: false, reason: "missingResponse" };
  }
  if (input.response.type !== "continuous") {
    return { ok: false, reason: "nonContinuousResponse", columnName: input.response.name };
  }
  if (input.terms.length === 0) {
    return { ok: false, reason: "missingTerms" };
  }

  const fieldsByName = new Map(input.fields?.map((field) => [field.name, field.type]) ?? []);
  const normalized = canonicalizeFitModelTerms(input.terms);
  const seen = new Set<string>();
  const mainEffects = new Set<string>();
  const interactions: Array<[string, string]> = [];

  for (const term of normalized) {
    if (term.kind !== "main" && term.kind !== "interaction") {
      return { ok: false, reason: "invalidTermKind", termKind: String(term.kind) };
    }

    if (term.kind === "main") {
      if (term.columnNames.length !== 1) {
        return { ok: false, reason: "invalidTermArity", termKind: term.kind };
      }

      const [columnName] = term.columnNames;
      if (columnName === input.response.name) {
        return { ok: false, reason: "responseInModel", columnName };
      }

      const fieldType = fieldsByName.get(columnName);
      if (fieldType && fieldType !== "continuous") {
        return { ok: false, reason: "nonContinuousPredictor", columnName };
      }

      const key = duplicateKey(term);
      if (seen.has(key)) {
        return { ok: false, reason: "duplicateTerm", termKey: termKey(term) };
      }
      seen.add(key);
      mainEffects.add(columnName);
      continue;
    }

    if (term.columnNames.length !== 2) {
      return { ok: false, reason: "invalidTermArity", termKind: term.kind };
    }

    const [first, second] = term.columnNames;
    if (first === second) {
      return { ok: false, reason: "sameColumnInteraction", columnName: first };
    }
    if (first === input.response.name || second === input.response.name) {
      return { ok: false, reason: "responseInModel", columnName: input.response.name };
    }

    const firstType = fieldsByName.get(first);
    const secondType = fieldsByName.get(second);
    if (firstType && firstType !== "continuous") {
      return { ok: false, reason: "nonContinuousPredictor", columnName: first };
    }
    if (secondType && secondType !== "continuous") {
      return { ok: false, reason: "nonContinuousPredictor", columnName: second };
    }

    const key = duplicateKey(term);
    if (seen.has(key)) {
      return { ok: false, reason: "duplicateTerm", termKey: termKey(term) };
    }
    seen.add(key);
    interactions.push([first, second]);
  }

  for (const [first, second] of interactions) {
    if (!mainEffects.has(first)) {
      return { ok: false, reason: "missingMainEffect", columnName: first };
    }
    if (!mainEffects.has(second)) {
      return { ok: false, reason: "missingMainEffect", columnName: second };
    }
  }

  return { ok: true };
}

export function applyFactorialDegree(fields: readonly FieldRef[], degree: 1 | 2): FitModelTerm[] {
  const predictorNames: string[] = [];
  const seen = new Set<string>();

  for (const field of fields) {
    if (field.type !== "continuous") {
      continue;
    }
    if (seen.has(field.name)) {
      continue;
    }
    seen.add(field.name);
    predictorNames.push(field.name);
  }

  const mains: FitModelTerm[] = predictorNames.map((columnName) => ({
    kind: "main",
    columnNames: [columnName],
  }));

  if (degree === 1) {
    return mains;
  }

  const interactions: FitModelTerm[] = [];
  for (let i = 0; i < predictorNames.length; i += 1) {
    for (let j = i + 1; j < predictorNames.length; j += 1) {
      interactions.push({
        kind: "interaction",
        columnNames: canonicalInteraction(predictorNames[i], predictorNames[j]),
      });
    }
  }

  return [...mains, ...interactions];
}

export function fitModelParameterCount(terms: readonly FitModelTerm[]): number {
  return 1 + terms.length;
}

export function createFitModelItem(input: Omit<FitModelItem, never> & { fields: readonly FieldRef[] }): FitModelItem {
  const validation = validateFitModelDefinition({
    response: input.response,
    terms: input.terms,
    fields: input.fields,
  });
  if (!validation.ok) {
    throw new FitModelValidationError(validation);
  }

  return {
    id: input.id,
    name: input.name,
    sourceDatasetId: input.sourceDatasetId,
    response: clone(input.response),
    terms: canonicalizeFitModelTerms(input.terms),
    centeringMethod: input.centeringMethod,
    createdAt: input.createdAt,
  };
}