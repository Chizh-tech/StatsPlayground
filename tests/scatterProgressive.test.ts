import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

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

function nodeHasIdentifier(node: ts.Node, name: string): boolean {
	let found = false;
	walk(node, (n) => {
		if (ts.isIdentifier(n) && n.text === name) found = true;
	});
	return found;
}

function objectHasProp(node: ts.ObjectLiteralExpression, propName: string): boolean {
	return node.properties.some((prop) => ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === propName);
}

function objectHasLiteral(node: ts.ObjectLiteralExpression, propName: string, kind: ts.SyntaxKind): boolean {
	return node.properties.some((prop) => {
		if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name) || prop.name.text !== propName) return false;
		return prop.initializer.kind === kind;
	});
}

function findVariableWithCall(ast: ts.SourceFile, variableName: string, calleeName: string): ts.VariableDeclaration | null {
	let found: ts.VariableDeclaration | null = null;
	walk(ast, (node) => {
		if (found) return;
		if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== variableName) return;
		if (!node.initializer || !ts.isCallExpression(node.initializer)) return;
		if (!ts.isIdentifier(node.initializer.expression) || node.initializer.expression.text !== calleeName) return;
		found = node;
	});
	return found;
}

function findSwitchCase(ast: ts.SourceFile, label: string): ts.CaseClause | null {
	let found: ts.CaseClause | null = null;
	walk(ast, (node) => {
		if (found) return;
		if (!ts.isCaseClause(node)) return;
		if (ts.isStringLiteral(node.expression) && node.expression.text === label) found = node;
	});
	return found;
}

const graphSource = readFileSync(new URL("../src/graphCore/Graph.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const graphAst = parseTsx("Graph.tsx", graphSource);

let importsRawPointsLayer = false;
let rendersRawPointsLayer = false;
let passesDescriptorFromRawPoints = false;

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
		if (!ts.isJsxAttribute(attr) || !attr.initializer || !ts.isJsxExpression(attr.initializer)) continue;
		if (attr.name.text !== "descriptor") continue;
		if (attr.initializer.expression && ts.isIdentifier(attr.initializer.expression) && attr.initializer.expression.text === "rawPoints") {
			passesDescriptorFromRawPoints = true;
		}
	}
});

assert.ok(importsRawPointsLayer, "Graph.tsx must import RawPointsLayer");
assert.ok(rendersRawPointsLayer, "Graph.tsx must render RawPointsLayer in GraphPanel");
assert.ok(passesDescriptorFromRawPoints, "GraphPanel must pass the panel rawPoints descriptor into RawPointsLayer");

const transformSource = readFileSync(new URL("../src/graphCore/transform.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const transformAst = parseTs("transform.ts", transformSource);

let hasFrameDescriptorBuilder = false;
walk(transformAst, (node) => {
	if (ts.isFunctionDeclaration(node) && node.name?.text === "buildFrameBackedRawDescriptor") {
		hasFrameDescriptorBuilder = true;
	}
});
assert.ok(hasFrameDescriptorBuilder, "transform.ts must keep buildFrameBackedRawDescriptor");

const frameSafeDataDecl = findVariableWithCall(transformAst, "frameSafeData", "");
let hasFrameSafeDataConditional = false;
walk(transformAst, (node) => {
	if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== "frameSafeData") return;
	if (!node.initializer || !ts.isConditionalExpression(node.initializer)) return;
	const cond = node.initializer;
	const whenTrue = cond.whenTrue;
	if (!ts.isObjectLiteralExpression(whenTrue)) return;
	const hasColumns = whenTrue.properties.some((prop) => ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "columns");
	const hasEmptyRows = whenTrue.properties.some(
		(prop) => ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "rows" && ts.isArrayLiteralExpression(prop.initializer) && prop.initializer.elements.length === 0,
	);
	const whenFalseIsData = ts.isIdentifier(cond.whenFalse) && cond.whenFalse.text === "data";
	hasFrameSafeDataConditional = hasColumns && hasEmptyRows && whenFalseIsData;
});
assert.ok(
	hasFrameSafeDataConditional,
	"buildGraph must derive frameSafeData that uses empty rows for frame-backed rendering",
);

let rawDescriptorCallCount = 0;
walk(transformAst, (node) => {
	if (!ts.isPropertyAssignment(node)) return;
	if (!ts.isIdentifier(node.name) || node.name.text !== "rawPoints") return;
	if (!ts.isCallExpression(node.initializer)) return;
	if (!ts.isIdentifier(node.initializer.expression) || node.initializer.expression.text !== "buildFrameBackedRawDescriptor") return;
	rawDescriptorCallCount += 1;
});

assert.ok(
	rawDescriptorCallCount >= 2,
	"buildGraph panels must populate rawPoints via buildFrameBackedRawDescriptor in single and faceted paths",
);

const pointsCase = findSwitchCase(transformAst, "points");
assert.ok(pointsCase, "transform.ts must include the points element switch case");

let rawScatterSeries: ts.ObjectLiteralExpression | null = null;
walk(pointsCase!, (node) => {
	if (rawScatterSeries || !ts.isObjectLiteralExpression(node)) return;
	if (!objectHasLiteral(node, "type", ts.SyntaxKind.StringLiteral)) return;
	const typeProp = node.properties.find((prop) => ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "type") as ts.PropertyAssignment | undefined;
	if (!typeProp || !ts.isStringLiteral(typeProp.initializer) || typeProp.initializer.text !== "scatter") return;
	if (!objectHasLiteral(node, "progressive", ts.SyntaxKind.FirstLiteralToken)) return;
	if (!nodeHasIdentifier(node, "__pick")) return;
	rawScatterSeries = node;
});

assert.ok(rawScatterSeries, "points case must build a raw scatter series carrying __pick metadata and progressive control");

const progressiveProp = rawScatterSeries!.properties.find(
	(prop) => ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "progressive",
) as ts.PropertyAssignment | undefined;
assert.ok(progressiveProp && ts.isNumericLiteral(progressiveProp.initializer) && progressiveProp.initializer.text === "0", "raw scatter production series must set progressive to 0");

const largeTrueInRawScatter = rawScatterSeries!.properties.some((prop) => {
	if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name) || prop.name.text !== "large") return false;
	return prop.initializer.kind === ts.SyntaxKind.TrueKeyword;
});
assert.ok(!largeTrueInRawScatter, "raw scatter production series must not enable large mode");

console.log("scatter progressive source regression passed");