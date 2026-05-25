/**
 * Local Data Filter rule types (JMP-inspired). Shared by the Graph
 * Builder and the Data Table; can be reused by any view that needs to
 * filter row-shaped data.
 *
 * A filter is a list of `FilterRuleItem`s, each carrying its own
 * predicate plus an `op` that says how it joins with the PREVIOUS rule.
 * The first rule's `op` is ignored. Combinations are evaluated strictly
 * left-to-right (no precedence), which matches the way the UI lets the
 * user "add another column with AND or OR" one at a time.
 *
 * Note on naming: this module used to live under graphBuilder and was
 * prefixed `GraphFilter*`; it now applies to any tabular view so we drop
 * the `Graph` prefix. Persisted project JSON only stores the discriminant
 * fields (`kind`, `field`, etc.) and is unaffected by the TS rename.
 */

import type { FieldRef } from "@/graphCore";

export type FilterOp = "AND" | "OR";

/** Continuous (numeric) range. Both bounds are inclusive. `null` means open. */
export interface FilterContinuousRule {
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
export interface FilterCategoricalRule {
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
export interface FilterDateRule {
  kind: "date";
  field: FieldRef;
  start: string | null;
  end: string | null;
}

export type FilterRule =
  | FilterContinuousRule
  | FilterCategoricalRule
  | FilterDateRule;

export interface FilterRuleItem {
  /** Stable id for React keys and updates. */
  id: string;
  /** How this rule combines with the previous rule. Ignored for index 0. */
  op: FilterOp;
  rule: FilterRule;
}
