import {
  canonicalInteraction,
  canonicalizeFitModelTerms,
} from "@/components/fitModel/fitModelConfig";
import type { FitModelFittedResult, FitModelTerm } from "@/types/fitModel";

const DEFAULT_UNDEFINED_VALUE = "\u2014";

export interface FitModelEffectRow {
  termId: string;
  termLabel: string;
  kind: FitModelTerm["kind"];
  pValue: number | null;
  logWorth: number | null;
}

export interface FitModelUndoSnapshot {
  terms: FitModelTerm[];
}

export type FitModelRemoveBlockedReason =
  | "requiredByInteraction"
  | "lastMainEffect"
  | "notFound";

export type FitModelRemoveResult =
  | {
      ok: true;
      nextTerms: FitModelTerm[];
      undoSnapshot: FitModelUndoSnapshot;
    }
  | {
      ok: false;
      reason: FitModelRemoveBlockedReason;
      requiredByTermIds?: string[];
    };

function cloneTerms(terms: readonly FitModelTerm[]): FitModelTerm[] {
  return terms.map((term) => ({
    kind: term.kind,
    columnNames: [...term.columnNames],
  }));
}

function canonicalTermColumns(term: FitModelTerm): string[] {
  if (term.kind !== "interaction" || term.columnNames.length !== 2) {
    return [...term.columnNames];
  }

  const [first, second] = canonicalInteraction(term.columnNames[0], term.columnNames[1]);
  return [first, second];
}

export function fitModelTermId(term: FitModelTerm): string {
  const columnNames = canonicalTermColumns(term);
  if (term.kind === "main") {
    return `main:${columnNames[0] ?? ""}`;
  }

  return `interaction:${(columnNames[0] ?? "")}*${(columnNames[1] ?? "")}`;
}

export function formatFitModelReportValue(
  value: number | null | undefined,
  undefinedValue = DEFAULT_UNDEFINED_VALUE,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefinedValue;
  }

  if (value === 0) {
    return "0";
  }

  return Number.parseFloat(value.toPrecision(6)).toString();
}

export function formatFitModelReportPValue(
  value: number | null | undefined,
  undefinedValue = DEFAULT_UNDEFINED_VALUE,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefinedValue;
  }

  if (value > 0 && value < 0.0001) {
    return "<0.0001";
  }

  return value.toFixed(4);
}

export function logWorth(pValue: number | null): number | null {
  if (pValue === null) {
    return null;
  }

  return Math.min(300, -Math.log10(Math.max(1e-300, pValue)));
}

export function buildEffectSummary(result: FitModelFittedResult): FitModelEffectRow[] {
  const parameterByTermId = new Map(
    result.parameterEstimates.map((parameter) => [parameter.termId, parameter]),
  );
  const parameterByLabel = new Map(
    result.parameterEstimates.map((parameter) => [parameter.termLabel, parameter]),
  );

  return result.terms
    .map((term) => {
      const parameter = parameterByTermId.get(term.termId) ?? parameterByLabel.get(term.label);
      const pValue = parameter?.pValue ?? null;

      return {
        termId: term.termId,
        termLabel: term.label,
        kind: term.kind,
        pValue,
        logWorth: logWorth(pValue),
      } satisfies FitModelEffectRow;
    })
    .sort((left, right) => {
      if (left.logWorth === null && right.logWorth === null) {
        return left.termLabel.localeCompare(right.termLabel);
      }
      if (left.logWorth === null) {
        return 1;
      }
      if (right.logWorth === null) {
        return -1;
      }
      if (left.logWorth !== right.logWorth) {
        return right.logWorth - left.logWorth;
      }
      return left.termLabel.localeCompare(right.termLabel);
    });
}

export function removeFitModelTerm(
  terms: readonly FitModelTerm[],
  termId: string,
): FitModelRemoveResult {
  const canonicalTerms = canonicalizeFitModelTerms(terms);
  const targetIndex = canonicalTerms.findIndex((term) => fitModelTermId(term) === termId);
  if (targetIndex < 0) {
    return {
      ok: false,
      reason: "notFound",
    };
  }

  const target = canonicalTerms[targetIndex];
  const undoSnapshot: FitModelUndoSnapshot = {
    terms: cloneTerms(canonicalTerms),
  };

  if (target.kind === "interaction") {
    return {
      ok: true,
      nextTerms: canonicalTerms.filter((_, index) => index !== targetIndex),
      undoSnapshot,
    };
  }

  const mainEffects = canonicalTerms.filter((term) => term.kind === "main");
  if (mainEffects.length <= 1) {
    return {
      ok: false,
      reason: "lastMainEffect",
    };
  }

  const targetColumnName = target.columnNames[0];
  const requiredBy = canonicalTerms.filter((term) => (
    term.kind === "interaction"
    && term.columnNames.includes(targetColumnName)
  ));

  if (requiredBy.length > 0) {
    return {
      ok: false,
      reason: "requiredByInteraction",
      requiredByTermIds: requiredBy.map((term) => fitModelTermId(term)),
    };
  }

  return {
    ok: true,
    nextTerms: canonicalTerms.filter((_, index) => index !== targetIndex),
    undoSnapshot,
  };
}
