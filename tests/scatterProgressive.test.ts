import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const graphSource = readFileSync(new URL("../src/graphCore/Graph.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.ok(graphSource.includes("import { RawPointsLayer } from \"./RawPointsLayer\";"), "Graph.tsx must import RawPointsLayer");
assert.ok(graphSource.includes("<RawPointsLayer"), "Graph.tsx must host RawPointsLayer in GraphPanel");
assert.ok(graphSource.includes("descriptor={rawPoints}"), "GraphPanel must pass panel rawPoints descriptor into RawPointsLayer");
assert.ok(graphSource.includes("onIndexChange={(index) => {"), "GraphPanel must bridge RawPointsLayer hit-test index updates");

const transformSource = readFileSync(new URL("../src/graphCore/transform.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.ok(
	transformSource.includes("function buildFrameBackedRawDescriptor("),
	"transform.ts must keep the frame-backed raw descriptor builder",
);
assert.ok(
	transformSource.includes("const frameSafeData: GraphData = frameBacked ? { columns: data.columns, rows: [] } : data;"),
	"frame-backed panels must suppress production ECharts raw rows via frameSafeData",
);
assert.ok(
	transformSource.includes("rawPoints: buildFrameBackedRawDescriptor(subSpec, frame, panelFacet)"),
	"faceted panels must emit frame-backed raw descriptors",
);
assert.ok(
	transformSource.includes("rawPoints: buildFrameBackedRawDescriptor(spec, frame)"),
	"single panels must emit frame-backed raw descriptors",
);

const start = transformSource.indexOf("// Raw scatter (no aggregation)");
const end = transformSource.indexOf("case \"line\":", start);

assert.ok(start >= 0, "raw scatter branch marker must exist");
assert.ok(end > start, "line branch marker must follow raw scatter branch");

const branch = transformSource.slice(start, end);

assert.ok(branch.includes('type: "scatter"'), 'raw scatter branch must render scatter series');
assert.ok(branch.includes('progressive: 0'), 'raw scatter branch must disable progressive rendering');
assert.equal((branch.match(/progressive: 0/g) ?? []).length, 1, 'progressive: 0 should appear exactly once in the raw scatter branch');
assert.ok(branch.includes("__pick"), 'raw scatter branch must preserve point metadata');
assert.ok(!branch.includes('large: true'), 'raw scatter branch must not enable large mode');
assert.ok(
	!branch.includes("useRawPointsLayer") && !branch.includes("fallbackToRawScatter"),
	"raw scatter branch must not include a legacy production raw-scatter fallback flag",
);

console.log("scatter progressive source regression passed");