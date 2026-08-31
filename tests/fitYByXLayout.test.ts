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

assert.match(
  appCss,
  /\.sp-fit-y-by-x-report-table th,\s*\.sp-fit-y-by-x-report-table td\s*\{[^}]*border-right:\s*1px solid var\(--border-main\);/s,
  "Fit Y by X report cells must have vertical separators",
);

assert.match(
  appCss,
  /\.sp-fit-y-by-x-report-table th\s*\{[^}]*border-right-color:\s*var\(--border-header-h\);/s,
  "Fit Y by X report headers must use a distinct separator",
);

assert.match(
  appCss,
  /\.sp-fit-y-by-x-report-table th:last-child,\s*\.sp-fit-y-by-x-report-table td:last-child\s*\{[^}]*border-right:\s*none;/s,
  "Fit Y by X report tables must not draw a duplicate trailing separator",
);

console.log("Fit Y by X layout contract passed");