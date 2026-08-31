import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appCss = readFileSync(resolve(process.cwd(), "src/App.css"), "utf8").replace(/\r\n/g, "\n");

assert.match(
  appCss,
  /\.sp-fit-y-by-x-analysis-root\s*\{[^}]*overflow-y:\s*auto;/s,
  "Fit Y by X analysis must keep graph and report content reachable through the outer scroller",
);

assert.match(
  appCss,
  /\.sp-fit-y-by-x-runtime-panel,\s*\.sp-fit-y-by-x-report-panel\s*\{[^}]*flex:\s*0 0 auto;/s,
  "Fit Y by X graph and report panels must not shrink and clip their contents",
);

console.log("Fit Y by X layout contract passed");