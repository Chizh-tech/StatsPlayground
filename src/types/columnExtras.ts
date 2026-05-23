/**
 * Column "extra properties" registry.
 *
 * All supported `kind`s plus their fields, default values and
 * i18n key sources are declared here. To add a new kind:
 *   1) extend ExtraKind
 *   2) add an entry to EXTRA_DEFS
 *   3) add the matching `extras.kind.<kind>`, `extras.kindDesc.<kind>`
 *      and `extras.field.<kind>_<fieldKey>` strings to every locale JSON.
 * The dialogs, batch grid and serialization will all light up automatically.
 */

import i18n from "@/i18n";
import type { TFunction } from "i18next";

export type ExtraKind = "unit" | "spec" | "range" | "notes" | "valueOrder";

export type ExtraFieldType = "text" | "number" | "longtext" | "valueList";

export interface ExtraFieldDef {
  /** Field key used inside the value object, e.g. spec.lsl */
  key: string;
  /** Input control type */
  type: ExtraFieldType;
}

export interface ExtraDef {
  kind: ExtraKind;
  fields: ExtraFieldDef[];
  /** Default value when adding this kind */
  defaultValue: () => Record<string, unknown>;
  /** When true, this kind is excluded from the batch (ManageExtras) grid
   *  because its field shape doesn't fit a flat cell — e.g. `valueOrder`
   *  is an ordered list that only makes sense to edit one column at a time. */
  batchExcluded?: boolean;
}

export const EXTRA_DEFS: Record<ExtraKind, ExtraDef> = {
  unit: {
    kind: "unit",
    fields: [{ key: "value", type: "text" }],
    defaultValue: () => ({ value: "" }),
  },
  spec: {
    kind: "spec",
    fields: [
      { key: "lsl", type: "number" },
      { key: "target", type: "number" },
      { key: "usl", type: "number" },
    ],
    defaultValue: () => ({ lsl: null, target: null, usl: null }),
  },
  range: {
    kind: "range",
    fields: [
      { key: "min", type: "number" },
      { key: "max", type: "number" },
    ],
    defaultValue: () => ({ min: null, max: null }),
  },
  notes: {
    kind: "notes",
    fields: [{ key: "value", type: "longtext" }],
    defaultValue: () => ({ value: "" }),
  },
  // JMP-style "Value Order": a custom ordering of unique values that
  // downstream consumers (Graph Builder axes, legend, boxplot groups, …)
  // honor when laying out categories. This is metadata only — it does NOT
  // reorder the underlying data rows. Stored as `{ values: string[] }`.
  // Excluded from the batch grid because every column has a different
  // value vocabulary and a flat CSV cell can't represent an ordered list
  // gracefully; instead it must be edited from the per-column properties
  // dialog where we can render a proper list editor (drag / up / down /
  // remove / "Pull from data").
  valueOrder: {
    kind: "valueOrder",
    fields: [{ key: "values", type: "valueList" }],
    defaultValue: () => ({ values: [] }),
    batchExcluded: true,
  },
};

/** All kinds, in the order shown in dropdowns */
export const EXTRA_KINDS: ExtraKind[] = ["unit", "spec", "range", "notes", "valueOrder"];

export function getExtraDef(kind: string): ExtraDef | undefined {
  return (EXTRA_DEFS as Record<string, ExtraDef | undefined>)[kind];
}

/** i18n helpers — accept an explicit `t` so React components can pass theirs in. */
export function extraKindLabel(kind: string, t?: TFunction): string {
  const fn = t ?? (i18n.t.bind(i18n) as TFunction);
  return fn(`extras.kind.${kind}`);
}

export function extraKindDesc(kind: string, t?: TFunction): string {
  const fn = t ?? (i18n.t.bind(i18n) as TFunction);
  return fn(`extras.kindDesc.${kind}`);
}

export function extraFieldLabel(kind: string, fieldKey: string, t?: TFunction): string {
  const fn = t ?? (i18n.t.bind(i18n) as TFunction);
  return fn(`extras.field.${kind}_${fieldKey}`);
}

/** Used by the column panel badge tooltip, e.g. "Unit, Spec" */
export function summarizeExtraKinds(
  extras: Record<string, unknown> | undefined,
  t?: TFunction,
): string {
  if (!extras) return "";
  const labels: string[] = [];
  for (const k of EXTRA_KINDS) {
    if (extras[k] !== undefined) labels.push(extraKindLabel(k, t));
  }
  // Forward-compatible: unknown future kinds show their raw key
  for (const k of Object.keys(extras)) {
    if (!(k in EXTRA_DEFS)) labels.push(k);
  }
  return labels.join(", ");
}
