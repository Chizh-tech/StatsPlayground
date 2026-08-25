import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
assert.ok(
  graphSource.includes("setOption(")
    && graphSource.includes("withoutGraphAnimation(")
    && graphSource.includes("withInterleavedGraphLayers(option) as echarts.EChartsCoreOption")
    && graphSource.includes("true,")
    && graphSource.includes("applyZrenderCanvasZIndices"),
  "Graph.tsx must wrap the final full option boundary with withoutGraphAnimation after interleaving graph layers",
);
assert.ok(
  graphSource.includes("{ ...p, animation: false } as echarts.EChartsCoreOption")
    && graphSource.includes("{ lazyUpdate: true, silent: true }")
    && !graphSource.includes("withoutGraphAnimation({ ...p, animation: false } as echarts.EChartsCoreOption)"),
  "Graph.tsx partial axis patches must keep their own animation suppression and stay unwrapped",
);

const chart3dSource = readFileSync(new URL("../src/graphCore/Chart3D.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.ok(
  chart3dSource.includes("setOption(withoutGraphAnimation(built.option as echarts.EChartsCoreOption), true)"),
  "Chart3D.tsx must wrap the built-option setOption boundary",
);

console.log("graph animation policy checks passed");