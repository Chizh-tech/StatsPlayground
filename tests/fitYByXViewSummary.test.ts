import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(process.cwd(), "src/components/fitYByX/FitYByXView.tsx"),
  "utf8",
);

assert.equal(
  source.includes('item.constructModelEffects === "factorialToDegree"')
    && source.includes('t("fitYByX.factorialDegree"')
    && source.includes("item.factorialDegree ?? 2"),
  true,
  "FitYByXView must show factorial degree in summary for factorial-to-degree bivariate models",
);

console.log("fitYByX view summary contract passed");
