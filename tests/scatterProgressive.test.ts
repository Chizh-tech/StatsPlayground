import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function extractCaseBlock(source: string, caseName: string): string {
	const caseIdx = source.indexOf(`case "${caseName}":`);
	assert.ok(caseIdx >= 0, `expected switch case \"${caseName}\" to exist`);
	const openIdx = source.indexOf("{", caseIdx);
	assert.ok(openIdx > caseIdx, `expected case \"${caseName}\" to open a block`);

	let depth = 0;
	for (let i = openIdx; i < source.length; i++) {
		const ch = source[i];
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		if (depth === 0) return source.slice(openIdx + 1, i);
	}
	assert.fail(`unterminated block for case \"${caseName}\"`);
}

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
	/frameBacked\s*\?\s*\{\s*columns\s*:\s*data\.columns\s*,\s*rows\s*:\s*\[\s*\]\s*\}\s*:\s*data/.test(transformSource),
	"frame-backed panels must suppress production ECharts raw rows via frameSafeData",
);
assert.ok(
	(transformSource.match(/rawPoints\s*:\s*buildFrameBackedRawDescriptor\s*\(/g) ?? []).length >= 2,
	"buildGraph panels must emit frame-backed raw descriptors in both single and faceted paths",
);

const pointsCase = extractCaseBlock(transformSource, "points");

assert.ok(/type\s*:\s*"scatter"/.test(pointsCase), 'raw scatter branch must render scatter series');
assert.ok(/progressive\s*:\s*0/.test(pointsCase), 'raw scatter branch must disable progressive rendering');
assert.equal((pointsCase.match(/progressive\s*:\s*0/g) ?? []).length, 1, 'progressive: 0 should appear exactly once in the points case');
assert.ok(pointsCase.includes("__pick"), 'raw scatter branch must preserve point metadata');
assert.ok(!/large\s*:\s*true/.test(pointsCase), 'raw scatter branch must not enable large mode');
assert.ok(
	!pointsCase.includes("useRawPointsLayer") && !pointsCase.includes("fallbackToRawScatter"),
	"raw scatter branch must not include a legacy production raw-scatter fallback flag",
);

console.log("scatter progressive source regression passed");