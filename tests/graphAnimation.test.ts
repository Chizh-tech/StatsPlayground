import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

function parseTsx(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function getSetOptionCalls(ast: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  walk(ast, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!ts.isPropertyAccessExpression(node.expression)) return;
    if (node.expression.name.text === "setOption") calls.push(node);
  });
  return calls;
}

function isNamedCall(node: ts.Node | undefined, name: string): node is ts.CallExpression {
  const unwrapped = node ? unwrapExpression(node) : undefined;
  return !!unwrapped && ts.isCallExpression(unwrapped) && ts.isIdentifier(unwrapped.expression) && unwrapped.expression.text === name;
}

function unwrapExpression(node: ts.Node): ts.Node {
  let current = node;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function objectHasBooleanLiteral(obj: ts.ObjectLiteralExpression, propName: string, value: boolean): boolean {
  return obj.properties.some((prop) => {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name) || prop.name.text !== propName) return false;
    return value ? prop.initializer.kind === ts.SyntaxKind.TrueKeyword : prop.initializer.kind === ts.SyntaxKind.FalseKeyword;
  });
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
const graphAst = parseTsx("Graph.tsx", graphSource);
const graphSetOptionCalls = getSetOptionCalls(graphAst);

const fullBoundaryCall = graphSetOptionCalls.find((call) => {
  if (!isNamedCall(call.arguments[0], "withoutGraphAnimation")) return false;
  const outer = unwrapExpression(call.arguments[0]) as ts.CallExpression;
  if (!isNamedCall(outer.arguments[0], "withInterleavedGraphLayers")) return false;
  return call.arguments[1]?.kind === ts.SyntaxKind.TrueKeyword;
});

assert.ok(
  fullBoundaryCall,
  "Graph.tsx must wrap the final full-option setOption boundary with withoutGraphAnimation(withInterleavedGraphLayers(...), true)",
);

const interactionPatchCall = graphSetOptionCalls.find((call) => {
  const arg0 = call.arguments[0] ? unwrapExpression(call.arguments[0]) : undefined;
  const arg1 = call.arguments[1] ? unwrapExpression(call.arguments[1]) : undefined;
  if (!arg0 || !arg1 || !ts.isObjectLiteralExpression(arg0) || !ts.isObjectLiteralExpression(arg1)) return false;
  return objectHasBooleanLiteral(arg0, "animation", false)
    && objectHasBooleanLiteral(arg1, "lazyUpdate", true)
    && objectHasBooleanLiteral(arg1, "silent", true);
});

assert.ok(
  interactionPatchCall,
  "Graph.tsx interaction-only setOption patch must keep local animation:false and stay unwrapped",
);

const chart3dSource = readFileSync(new URL("../src/graphCore/Chart3D.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const chart3dAst = parseTsx("Chart3D.tsx", chart3dSource);
const chart3dSetOptionCalls = getSetOptionCalls(chart3dAst);
assert.ok(
  chart3dSetOptionCalls.some((call) => isNamedCall(call.arguments[0], "withoutGraphAnimation") && call.arguments[1]?.kind === ts.SyntaxKind.TrueKeyword),
  "Chart3D.tsx must wrap the final 3D setOption boundary with withoutGraphAnimation(..., true)",
);

console.log("graph animation policy checks passed");