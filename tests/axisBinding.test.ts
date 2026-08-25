import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

import type { YAxisConfig } from "../src/graphCore";
import { prepareAxisBinding } from "../src/components/graphBuilder/axisBinding.ts";

function parseTsx(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function hasIdentifier(node: ts.Node, name: string): boolean {
  let found = false;
  walk(node, (n) => {
    if (ts.isIdentifier(n) && n.text === name) found = true;
  });
  return found;
}

function isComputedObjectWithValue(node: ts.Node, valueName: string): boolean {
  if (!ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((prop) => {
    if (!ts.isPropertyAssignment(prop)) return false;
    return ts.isComputedPropertyName(prop.name)
      && ts.isIdentifier(prop.initializer)
      && prop.initializer.text === valueName;
  });
}

function isComputedObjectWithUndefined(node: ts.Node): boolean {
  if (!ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((prop) => {
    if (!ts.isPropertyAssignment(prop)) return false;
    return ts.isComputedPropertyName(prop.name)
      && ts.isIdentifier(prop.initializer)
      && prop.initializer.text === "undefined";
  });
}

function unwrapParens<T extends ts.Node>(node: T): ts.Node {
  let current: ts.Node = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
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
const graphBuilderAst = parseTsx("GraphBuilderView.tsx", graphBuilderSource);

let bindFieldFn: ts.ArrowFunction | ts.FunctionExpression | null = null;
walk(graphBuilderAst, (node) => {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== "bindFieldToSlot") {
    return;
  }
  const init = node.initializer;
  if (!init || !ts.isCallExpression(init)) return;
  if (!ts.isIdentifier(init.expression) || init.expression.text !== "useCallback") return;
  const cb = init.arguments[0];
  if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) bindFieldFn = cb;
});

assert.ok(bindFieldFn, "GraphBuilderView.tsx must define bindFieldToSlot via useCallback");
const bindBody = bindFieldFn!.body;
assert.ok(ts.isBlock(bindBody), "bindFieldToSlot callback must have a block body");

let preparedVarName: string | null = null;
let bindingChangedVarName: string | null = null;
let axisConfigVarName: string | null = null;

for (const stmt of bindBody.statements) {
  if (!ts.isVariableStatement(stmt)) continue;
  for (const decl of stmt.declarationList.declarations) {
    if (
      ts.isIdentifier(decl.name)
      && decl.initializer
      && ts.isCallExpression(decl.initializer)
      && ts.isIdentifier(decl.initializer.expression)
      && decl.initializer.expression.text === "prepareAxisBinding"
    ) {
      preparedVarName = decl.name.text;
    }

    if (
      ts.isObjectBindingPattern(decl.name)
      && decl.initializer
      && ts.isIdentifier(decl.initializer)
      && decl.initializer.text === preparedVarName
    ) {
      for (const el of decl.name.elements) {
        const key = el.propertyName ?? el.name;
        if (!ts.isIdentifier(key) || !ts.isIdentifier(el.name)) continue;
        if (key.text === "bindingChanged") bindingChangedVarName = el.name.text;
        if (key.text === "axisConfig") axisConfigVarName = el.name.text;
      }
    }
  }
}

assert.ok(preparedVarName, "bindFieldToSlot must call prepareAxisBinding before the update gate");
assert.ok(bindingChangedVarName, "bindFieldToSlot must extract bindingChanged from prepareAxisBinding result");
assert.ok(axisConfigVarName, "bindFieldToSlot must extract axisConfig from prepareAxisBinding result");

let gatedIf: ts.IfStatement | null = null;
for (const stmt of bindBody.statements) {
  if (!ts.isIfStatement(stmt)) continue;
  if (!ts.isBinaryExpression(stmt.expression) || stmt.expression.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) {
    continue;
  }
  if (hasIdentifier(stmt.expression, bindingChangedVarName!)) {
    gatedIf = stmt;
    break;
  }
}

assert.ok(gatedIf, "bindFieldToSlot must have an axis-scoped AND-gated branch driven by bindingChanged");
assert.ok(ts.isBlock(gatedIf!.thenStatement), "axis-scoped gated branch must be a block");

let atomicUpdateCall: ts.CallExpression | null = null;
for (const stmt of gatedIf!.thenStatement.statements) {
  if (!ts.isExpressionStatement(stmt) || !ts.isCallExpression(stmt.expression)) continue;
  const call = stmt.expression;
  if (!ts.isIdentifier(call.expression) || call.expression.text !== "updateItem") continue;
  if (call.arguments.length < 2) continue;
  if (ts.isObjectLiteralExpression(call.arguments[1])) {
    atomicUpdateCall = call;
    break;
  }
}

assert.ok(atomicUpdateCall, "axis-scoped gated branch must issue a single updateItem object payload");

const payload = atomicUpdateCall!.arguments[1] as ts.ObjectLiteralExpression;
const encodingProp = payload.properties.find(
  (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "encoding",
);
assert.ok(encodingProp && ts.isPropertyAssignment(encodingProp), "atomic payload must include encoding");
assert.ok(
  ts.isObjectLiteralExpression(encodingProp.initializer)
  && encodingProp.initializer.properties.some(
    (prop) => ts.isPropertyAssignment(prop) && ts.isComputedPropertyName(prop.name),
  ),
  "encoding payload must include a computed slot assignment",
);

const spreadExprs = payload.properties
  .filter(ts.isSpreadAssignment)
  .map((spread) => unwrapParens(spread.expression));

assert.ok(
  spreadExprs.some((expr) => {
    if (!ts.isConditionalExpression(expr)) return false;
    return isComputedObjectWithValue(unwrapParens(expr.whenTrue), axisConfigVarName!);
  }),
  "atomic payload must include a computed axis property whose value comes from axisConfig",
);

assert.ok(
  spreadExprs.some((expr) => {
    if (!ts.isConditionalExpression(expr)) return false;
    return isComputedObjectWithUndefined(unwrapParens(expr.whenTrue));
  }),
  "atomic payload must include a computed property clearing the matching multi slot",
);

let foundSetEncodingFallback = false;
walk(bindBody, (node) => {
  if (!ts.isCallExpression(node)) return;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "setEncoding") return;
  const arg0 = node.arguments[0];
  if (!arg0 || !(ts.isArrowFunction(arg0) || ts.isFunctionExpression(arg0))) return;
  const body = arg0.body;
  const candidate = ts.isParenthesizedExpression(body) ? body.expression : body;
  if (!ts.isObjectLiteralExpression(candidate)) return;
  const hasComputed = candidate.properties.some(
    (prop) => ts.isPropertyAssignment(prop) && ts.isComputedPropertyName(prop.name),
  );
  if (hasComputed) foundSetEncodingFallback = true;
});

assert.ok(
  foundSetEncodingFallback,
  "bindFieldToSlot should keep a non-axis fallback that updates encoding without forcing axis/multi resets",
);

console.log("axis binding helper checks passed");
