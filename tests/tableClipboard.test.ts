import assert from "node:assert/strict";

import { copyThenClear } from "../src/utils/tableClipboard.ts";

let cleared = false;
assert.equal(
  await copyThenClear(
    async () => { throw new Error("clipboard denied"); },
    async () => { cleared = true; },
  ),
  false,
);
assert.equal(cleared, false);

assert.equal(
  await copyThenClear(
    async () => true,
    async () => { cleared = true; },
  ),
  true,
);
assert.equal(cleared, true);

console.log("table-clipboard regression passed");
