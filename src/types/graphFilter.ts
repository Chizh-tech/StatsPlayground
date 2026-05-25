/**
 * Graph Builder — Local Data Filter (JMP-inspired).
 *
 * A filter is a list of `GraphFilterRuleItem`s, each carrying its own
 * predicate plus an `op` that says how it joins with the PREVIOUS rule.
 * The first rule's `op` is ignored. Combinations are evaluated strictly
 * left-to-right (no precedence), which matches the way the UI lets the
 * user "add another column with AND or OR" one at a time.
 */

import type { FieldRef } from "@/graphCore";

export type GraphFilterOp = "AND" | "OR";

/** Continuous (numeric) range. Both bounds are inclusive. `null` means open. */
export interface GraphFilterContinuous {
  kind: "continuous";
  field: FieldRef;
  min: number | null;
  max: number | null;
}

/**
 * Categorical multi-select. `selected` lists the values that pass.
 * An empty list means "nothing passes" (matches JMP: deselecting all
 * filters out everything).
 */
export interface GraphFilterCategorical {
  kind: "categorical";
  field: FieldRef;
  selected: string[];
}

/**
 * Datetime range. Values are ISO date strings (YYYY-MM-DD) for the date
 * pickers; comparison is done on the raw cell value (timestamp or date
 * string) by lexicographic ISO compare, which works for both date-only
 * and full timestamps.
 */
export interface GraphFilterDate {
  kind: "date";
  field: FieldRef;
  start: string | null;
  end: string | null;
}

export type GraphFilterRule =
  | GraphFilterContinuous
  | GraphFilterCategorical
  | GraphFilterDate;

export interface GraphFilterRuleItem {
  /** Stable id for React keys and updates. */
  id: string;
  /** How this rule combines with the previous rule. Ignored for index 0. */
  op: GraphFilterOp;
  rule: GraphFilterRule;
}
