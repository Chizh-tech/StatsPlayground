import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { YAxisConfig } from "../src/graphCore";
import { prepareAxisBinding } from "../src/components/graphBuilder/axisBinding.ts";

const rangeAndStyle: YAxisConfig = {
  min: 2,
  max: 8,
  tickInterval: 1,
  inverse: true,
  showMajorGrid: true,
};

assert.deepStrictEqual(
  prepareAxisBinding(undefined, "category", false, rangeAndStyle),
  {
    bindingChanged: true,
    axisConfig: { inverse: true, showMajorGrid: true },
  },
  "empty -> field should clear range fields and preserve display fields",
);

assert.deepStrictEqual(
  prepareAxisBinding("old", "new", false, {
    min: 1,
    max: 9,
    tickInterval: 2,
    decimals: 3,
  }),
  {
    bindingChanged: true,
    axisConfig: { decimals: 3 },
  },
  "different field -> field should clear min/max/tickInterval",
);

const unchanged: YAxisConfig = {
  min: 10,
  max: 20,
  tickInterval: 5,
  inverse: true,
};
const unchangedResult = prepareAxisBinding("same", "same", false, unchanged);
assert.strictEqual(unchangedResult.bindingChanged, false, "same field should not count as changed");
assert.strictEqual(unchangedResult.axisConfig, unchanged, "same field should preserve config object identity");

assert.deepStrictEqual(
  prepareAxisBinding("same", "same", true, {
    min: 0,
    max: 100,
    tickInterval: 10,
    showAxisLine: false,
  }),
  {
    bindingChanged: true,
    axisConfig: { showAxisLine: false },
  },
  "hadMulti should force a reset even when the field name is unchanged",
);

assert.deepStrictEqual(
  prepareAxisBinding(undefined, "field", false, undefined),
  {
    bindingChanged: true,
    axisConfig: undefined,
  },
  "undefined config should stay undefined when binding changes",
);

assert.deepStrictEqual(
  prepareAxisBinding("old", "new", false, { min: 1, max: 2, tickInterval: 0.5 }),
  {
    bindingChanged: true,
    axisConfig: undefined,
  },
  "range-only config should collapse to undefined after reset",
);

const displayOnly: YAxisConfig = {
  decimals: 4,
  inverse: true,
  minorTickCount: 6,
  showAxisLine: false,
  tickPosition: "inside",
  showMajorGrid: true,
  showMinorGrid: false,
  majorGridStyle: { color: "#123456", width: 2, style: "dotted" },
  minorGridStyle: { color: "#abcdef", width: 1, style: "dashed" },
};

assert.deepStrictEqual(
  prepareAxisBinding("old", "new", false, displayOnly),
  {
    bindingChanged: true,
    axisConfig: displayOnly,
  },
  "all non-range display fields should be preserved verbatim",
);

const graphBuilderSource = readFileSync(
  new URL("../src/components/graphBuilder/GraphBuilderView.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

const bindFieldToSlotStart = graphBuilderSource.indexOf("const bindFieldToSlot = useCallback(");
const bindFieldToSlotEnd = graphBuilderSource.indexOf(
  "  /** Replace a slot's multi-mode list",
  bindFieldToSlotStart,
);
assert.ok(
  bindFieldToSlotStart !== -1 && bindFieldToSlotEnd !== -1,
  "GraphBuilderView.tsx must expose bindFieldToSlot for the source integration assertion",
);
const bindFieldToSlotSource = graphBuilderSource.slice(bindFieldToSlotStart, bindFieldToSlotEnd);

assert.ok(
  bindFieldToSlotSource.includes("prepareAxisBinding(")
    && bindFieldToSlotSource.includes("prevField?.name")
    && bindFieldToSlotSource.includes("field.name")
    && bindFieldToSlotSource.includes("hadMulti")
    && bindFieldToSlotSource.includes("prevAxis"),
  "GraphBuilderView.tsx must compute axis reset state through prepareAxisBinding",
);
assert.ok(
  bindFieldToSlotSource.includes("const prepared = prepareAxisBinding("),
  "bindFieldToSlot should hold prepareAxisBinding output in a named variable before branching",
);
assert.ok(
  bindFieldToSlotSource.includes("const { bindingChanged, axisConfig } = prepared;"),
  "bindFieldToSlot should destructure bindingChanged/axisConfig from the prepared contract",
);
assert.ok(
  bindFieldToSlotSource.includes("if (axisKey && bindingChanged) {")
    || bindFieldToSlotSource.includes("if (bindingChanged) {"),
  "bindFieldToSlot must gate the atomic path on bindingChanged for axis slots",
);
assert.ok(
  bindFieldToSlotSource.includes("updateItem(item.id, {"),
  "bindFieldToSlot must use a single updateItem call for the atomic bindingChanged path",
);
assert.ok(
  bindFieldToSlotSource.includes("encoding: { ...item.encoding, [slot]: field }"),
  "bindFieldToSlot must write the new slot encoding in the atomic update payload",
);
assert.ok(
  bindFieldToSlotSource.includes("...(axisKey ? { [axisKey]: axisConfig } : {})"),
  "bindFieldToSlot must write back the axis config in the atomic update payload",
);
assert.ok(
  bindFieldToSlotSource.includes("...(multiKey ? { [multiKey]: undefined } : {})"),
  "bindFieldToSlot must clear the matching multi slot in the atomic update payload",
);
assert.ok(
  bindFieldToSlotSource.includes("setEncoding((prev) => ({ ...prev, [slot]: field }));"),
  "same-field re-drop path must preserve axis/multi state by only updating encoding",
);

console.log("axis binding helper checks passed");