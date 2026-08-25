import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

import { buildGraph } from "../src/graphCore/transform.ts";
import { getGraphTheme } from "../src/graphCore/theme.ts";
import type { GraphData, GraphSpec } from "../src/graphCore/types.ts";
import type { GraphDataFrame } from "../src/types/graphData.ts";

function parseTsx(fileName: string, source: string): ts.SourceFile {
	return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function parseTs(fileName: string, source: string): ts.SourceFile {
	return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
	visit(node);
	node.forEachChild((child) => walk(child, visit));
}

function bits(flags: number[]): Uint8Array {
	const out = new Uint8Array(Math.max(1, Math.ceil(flags.length / 8)));
	for (let i = 0; i < flags.length; i += 1) {
		if (flags[i]) out[i >> 3] |= 1 << (i & 7);
	}
	return out;
}

function getSeries(option: unknown): any[] {
	const record = option as { series?: unknown };
	return Array.isArray(record?.series) ? (record.series as any[]) : [];
}

function hasPickPayload(series: any): boolean {
	if (!series || series.type !== "scatter" || !Array.isArray(series.data)) return false;
	return series.data.some((item: any) => !!item && typeof item === "object" && "__pick" in item);
}

function scatterSeries(option: unknown): any[] {
	return getSeries(option).filter((s) => s && typeof s === "object" && s.type === "scatter");
}

const graphSource = readFileSync(new URL("../src/graphCore/Graph.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const graphAst = parseTsx("Graph.tsx", graphSource);

let importsRawPointsLayer = false;
let rendersRawPointsLayer = false;
let passesRawPointsViaDescriptor = false;

walk(graphAst, (node) => {
	if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "./RawPointsLayer") {
		const clause = node.importClause;
		const named = clause?.namedBindings;
		if (named && ts.isNamedImports(named)) {
			importsRawPointsLayer = named.elements.some((el) => el.name.text === "RawPointsLayer");
		}
	}

	if (!ts.isJsxSelfClosingElement(node) && !ts.isJsxOpeningElement(node)) return;
	if (!ts.isIdentifier(node.tagName) || node.tagName.text !== "RawPointsLayer") return;
	rendersRawPointsLayer = true;

	for (const attr of node.attributes.properties) {
		if (!ts.isJsxAttribute(attr) || attr.name.text !== "descriptor") continue;
		if (!attr.initializer || !ts.isJsxExpression(attr.initializer)) continue;
		if (attr.initializer.expression && ts.isIdentifier(attr.initializer.expression) && attr.initializer.expression.text === "rawPoints") {
			passesRawPointsViaDescriptor = true;
		}
	}
});

assert.ok(importsRawPointsLayer, "Graph.tsx must import RawPointsLayer");
assert.ok(rendersRawPointsLayer, "Graph.tsx must render RawPointsLayer");
assert.ok(passesRawPointsViaDescriptor, "Graph.tsx must pass panel rawPoints through the descriptor prop");

const transformSource = readFileSync(new URL("../src/graphCore/transform.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const transformAst = parseTs("transform.ts", transformSource);

let buildGraphDecl: ts.FunctionDeclaration | null = null;
walk(transformAst, (node) => {
	if (ts.isFunctionDeclaration(node) && node.name?.text === "buildGraph") {
		buildGraphDecl = node;
	}
});

assert.ok(buildGraphDecl && buildGraphDecl.body, "transform.ts must define buildGraph");
const buildGraphBody = buildGraphDecl!.body!;
const dataParam = buildGraphDecl!.parameters[1];
assert.ok(dataParam && ts.isIdentifier(dataParam.name), "buildGraph must have a GraphData input parameter");
const dataParamName = (dataParam.name as ts.Identifier).text;

let hasFrameBackedDataSubstitution = false;
walk(buildGraphBody, (node) => {
	if (!ts.isVariableDeclaration(node) || !node.initializer || !ts.isConditionalExpression(node.initializer)) return;
	const expr = node.initializer;

	const branches = [expr.whenTrue, expr.whenFalse];
	const hasEmptyRowsObject = branches.some((branch) => {
		if (!ts.isObjectLiteralExpression(branch)) return false;

		let hasColumns = false;
		let hasEmptyRows = false;

		for (const prop of branch.properties) {
			if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
			if (prop.name.text === "columns") {
				hasColumns = true;
			}
			if (prop.name.text === "rows" && ts.isArrayLiteralExpression(prop.initializer) && prop.initializer.elements.length === 0) {
				hasEmptyRows = true;
			}
		}

		return hasColumns && hasEmptyRows;
	});

	const hasOriginalDataBranch = branches.some((branch) => ts.isIdentifier(branch) && branch.text === dataParamName);
	if (hasEmptyRowsObject && hasOriginalDataBranch) {
		hasFrameBackedDataSubstitution = true;
	}
});

assert.ok(
	hasFrameBackedDataSubstitution,
	"buildGraph must switch between original input data and a frame-backed { columns, rows: [] } substitute",
);

const sourceData: GraphData = {
	columns: ["x", "y", "overlay", "_row_id"],
	rows: [
		[1, 10, "A", 101],
		[2, 20, "B", 102],
		[3, 30, "A", 103],
	],
};

const baseSpec: GraphSpec = {
	encoding: {
		x: { name: "x", type: "continuous" },
		y: { name: "y", type: "continuous" },
		overlay: { name: "overlay", type: "nominal" },
	},
	elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
};

const frame: GraphDataFrame = {
	requestId: "req-1",
	datasetId: "ds-1",
	generation: 1,
	sourceRows: 3,
	processedRows: 3,
	sampling: { mode: "full" },
	dictionaries: {
		x: [],
		group: ["A", "B"],
		facetX: ["F1", "F2"],
	},
	extents: {},
	rawChunks: [
		{
			chunkIndex: 0,
			rowOffset: 0,
			rowCount: 3,
			xValues: new Float64Array([1, 2, 3]),
			yValues: new Float64Array([10, 20, 30]),
			rowIds: new BigInt64Array([101n, 102n, 103n]),
			groupCodes: new Uint32Array([0, 1, 0]),
			facetXCodes: new Uint32Array([0, 1, 0]),
			roleVectors: {
				group: new Uint32Array([0, 1, 0]),
				groupX: new Uint32Array([0, 1, 0]),
			},
			validity: {
				x: bits([1, 1, 1]),
				y: bits([1, 1, 1]),
				group: bits([1, 1, 1]),
				facetX: bits([1, 1, 1]),
			},
		},
	],
	aggregates: [],
};

const theme = getGraphTheme();

const builtWithoutFrame = buildGraph(baseSpec, sourceData, theme);
assert.equal(builtWithoutFrame.panels.length, 1, "non-frame path should produce one panel for the baseline spec");
assert.equal(builtWithoutFrame.panels[0].rawPoints, null, "non-frame path should not expose a rawPoints descriptor");

const nonFrameScatter = scatterSeries(builtWithoutFrame.panels[0].option);
const nonFrameRawScatter = nonFrameScatter.find((s) => hasPickPayload(s));
assert.ok(nonFrameRawScatter, "non-frame raw scatter fallback should retain __pick metadata for table selection");
assert.equal(nonFrameRawScatter.progressive, 0, "non-frame raw scatter fallback should pin progressive to 0");
assert.ok(nonFrameScatter.every((s) => s.large !== true), "raw scatter fallback should never enable large mode");

const builtWithFrameSingle = buildGraph(baseSpec, sourceData, theme, undefined, frame);
assert.equal(builtWithFrameSingle.panels.length, 1, "frame-backed single-panel path should produce one panel");
assert.ok(builtWithFrameSingle.panels[0].rawPoints, "frame-backed single-panel path must expose a rawPoints descriptor");
assert.ok(
	builtWithFrameSingle.panels[0].rawPoints?.colName === "y" && (builtWithFrameSingle.panels[0].rawPoints?.chunks.length ?? 0) > 0,
	"frame-backed rawPoints descriptor must include column identity and chunk payload",
);
assert.ok(
	scatterSeries(builtWithFrameSingle.panels[0].option).every((s) => !hasPickPayload(s)),
	"when a frame-backed rawPoints descriptor exists, raw scatter fallback with __pick must not be reachable",
);
assert.ok(
	scatterSeries(builtWithFrameSingle.panels[0].option).every((s) => s.large !== true),
	"frame-backed points rendering should never enable large mode",
);

const facetedSpec: GraphSpec = {
	...baseSpec,
	encoding: {
		...baseSpec.encoding,
		groupX: { name: "facet_col", type: "nominal" },
	},
};

const builtWithFrameFaceted = buildGraph(facetedSpec, sourceData, theme, undefined, frame);
assert.ok(builtWithFrameFaceted.panels.length >= 2, "frame-backed faceted path should produce multiple panels from facet keys");
assert.ok(
	builtWithFrameFaceted.panels.every((panel) => panel.rawPoints !== null),
	"frame-backed faceted panels must each expose a non-null rawPoints descriptor",
);
assert.ok(
	builtWithFrameFaceted.panels.every((panel) => scatterSeries(panel.option).every((s) => !hasPickPayload(s))),
	"frame-backed faceted panels must keep raw scatter fallback unreachable when rawPoints descriptors exist",
);
assert.ok(
	builtWithFrameFaceted.panels.every((panel) => scatterSeries(panel.option).every((s) => s.large !== true)),
	"frame-backed faceted panels must never enable large mode on scatter series",
);

console.log("scatter progressive source regression passed");