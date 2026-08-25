import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { YAxisConfig } from "../src/graphCore";
import { prepareAxisBinding } from "../src/components/graphBuilder/axisBinding.ts";

function extractBlockAfter(source: string, anchor: RegExp, label: string): string {
  const match = anchor.exec(source);
  assert.ok(match?.index !== undefined, `${label} must exist`);
  const start = match.index + match[0].length;
  let depth = 1;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) return source.slice(start, i);
  }

  assert.fail(`${label} block must be balanced`);
}

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
  /prepareAxisBinding\(\s*prevField\?\.name\s*,\s*field\.name\s*,\s*hadMulti\s*,\s*prevAxis\s*,?\s*\)/.test(bindFieldToSlotSource),
  "GraphBuilderView.tsx must compute axis reset state through prepareAxisBinding",
);

const axisGuard = /if\s*\(\s*axisKey\s*&&\s*bindingChanged\s*\)\s*\{/;
assert.ok(
  axisGuard.test(bindFieldToSlotSource),
  "bindFieldToSlot must gate the atomic path on axisKey && bindingChanged",
);

const atomicBlock = extractBlockAfter(
  bindFieldToSlotSource,
  axisGuard,
  "bindFieldToSlot axis-scoped atomic branch",
);

assert.ok(
  /updateItem\(\s*item\.id\s*,\s*\{/.test(atomicBlock),
  "bindFieldToSlot must use a single updateItem call for the atomic bindingChanged path",
);
assert.ok(
  /encoding\s*:\s*\{[^}]*\[\s*slot\s*\]\s*:\s*field[^}]*\}/s.test(atomicBlock),
  "bindFieldToSlot must write the new slot encoding in the atomic update payload",
);
assert.ok(
  /\[\s*axisKey\s*\]\s*:\s*axisConfig/.test(atomicBlock),
  "bindFieldToSlot must write back the axis config in the atomic update payload",
);
assert.ok(
  /\[\s*multiKey\s*\]\s*:\s*undefined/.test(atomicBlock),
  "bindFieldToSlot must clear the matching multi slot in the atomic update payload",
);
assert.ok(
  /setEncoding\(\s*\(prev\)\s*=>\s*\(\s*\{[^}]*\[\s*slot\s*\]\s*:\s*field[^}]*\}\s*\)\s*\)\s*;?/s.test(bindFieldToSlotSource),
  "same-field re-drop path must preserve axis/multi state by only updating encoding",
);

console.log("axis binding helper checks passed");
