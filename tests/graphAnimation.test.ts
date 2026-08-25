import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function extractSetOptionCalls(source: string): string[] {
  const calls: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const idx = source.indexOf("setOption(", cursor);
    if (idx < 0) break;
    const openIdx = source.indexOf("(", idx);
    if (openIdx < 0) break;
    let depth = 0;
    let endIdx = -1;
    for (let i = openIdx; i < source.length; i++) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
    assert.ok(endIdx > openIdx, "setOption call should have balanced parentheses");
    calls.push(source.slice(idx, endIdx + 1));
    cursor = endIdx + 1;
  }
  return calls;
}

import { withoutGraphAnimation } from "../src/graphCore/animation.ts";

const helperInput = {
  title: "chart",
  animation: true,
  animationDuration: 123,
  animationDurationUpdate: 456,
  nested: { keep: true },
  series: [{ type: "line", data: [1, 2, 3] }],
};

const helperOutput = withoutGraphAnimation(helperInput);

assert.notStrictEqual(helperOutput, helperInput, "helper must return a new shallow copy");
assert.strictEqual(helperOutput.title, helperInput.title, "source fields must be preserved");
assert.strictEqual(helperOutput.series, helperInput.series, "nested references must be preserved");
assert.strictEqual(helperOutput.nested, helperInput.nested, "nested object identity must be preserved");
assert.strictEqual(helperOutput.animation, false, "animation must be disabled exactly");
assert.strictEqual(helperOutput.animationDuration, 0, "animationDuration must be zeroed exactly");
assert.strictEqual(helperOutput.animationDurationUpdate, 0, "animationDurationUpdate must be zeroed exactly");
assert.deepStrictEqual(
  helperInput,
  {
    title: "chart",
    animation: true,
    animationDuration: 123,
    animationDurationUpdate: 456,
    nested: { keep: true },
    series: [{ type: "line", data: [1, 2, 3] }],
  },
  "helper must not mutate the input object",
);

const graphSource = readFileSync(new URL("../src/graphCore/Graph.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const setOptionCalls = extractSetOptionCalls(graphSource);
assert.ok(
  setOptionCalls.some((call) =>
    call.includes("withoutGraphAnimation(")
      && call.includes("withInterleavedGraphLayers(option)")
      && /,\s*true\s*,?\s*\)$/.test(call),
  ) && graphSource.includes("applyZrenderCanvasZIndices"),
  "Graph.tsx must wrap the final full option boundary with withoutGraphAnimation after interleaving graph layers",
);
assert.ok(
  setOptionCalls.some((call) =>
    /animation\s*:\s*false/.test(call)
      && /lazyUpdate\s*:\s*true/.test(call)
      && /silent\s*:\s*true/.test(call)
      && !call.includes("withoutGraphAnimation("),
  ),
  "Graph.tsx partial axis patches must keep their own animation suppression and stay unwrapped",
);

const chart3dSource = readFileSync(new URL("../src/graphCore/Chart3D.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.ok(
  /setOption\(\s*withoutGraphAnimation\(\s*built\.option\s+as\s+echarts\.EChartsCoreOption\s*\)\s*,\s*true\s*\)/.test(chart3dSource),
  "Chart3D.tsx must wrap the built-option setOption boundary",
);

console.log("graph animation policy checks passed");