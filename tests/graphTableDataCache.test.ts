import assert from "node:assert";
import type { GraphTableData } from "../src/components/graphBuilder/loadGraphTableData.ts";
import { GraphTableDataCache, graphTableDataCache } from "../src/utils/graphTableDataCache.ts";

async function run() {
  // Use an independent instance to prove instance isolation
  const cache = new GraphTableDataCache();

  // capture epoch and put
  const e0 = cache.captureEpoch();
  const a1: GraphTableData = { columns: [], rows: [] };
  assert.strictEqual(cache.putIfCurrent(e0, "a", 1, a1), true, "putIfCurrent should succeed for current epoch");
  const gotA1 = cache.get("a", 1);
  assert.strictEqual(gotA1, a1, "get should preserve object identity on exact hit");

  // different-dataset lookup must NOT evict the current entry
  const diffMiss = cache.get("b", 999);
  assert.strictEqual(diffMiss, undefined, "lookup of different dataset should miss");
  assert.strictEqual(cache.get("a", 1), a1, "different-dataset miss must not evict current entry");

  // generation mismatch evicts same-dataset entry without advancing epoch
  const epochBefore = cache.captureEpoch();
  const miss = cache.get("a", 2);
  assert.strictEqual(miss, undefined, "generation mismatch should return undefined");
  assert.strictEqual(cache.captureEpoch(), epochBefore, "epoch must not advance on stale lookup");
  assert.strictEqual(cache.get("a", 1), undefined, "stale same-dataset entry should be evicted");

  // inserting dataset b evicts dataset a (only one entry retained)
  const e1 = cache.captureEpoch();
  const bData: GraphTableData = { columns: ["c"], rows: [[1]] };
  assert.strictEqual(cache.putIfCurrent(e1, "b", 7, bData), true, "putIfCurrent should accept when epoch matches");
  assert.strictEqual(cache.get("b", 7), bData, "b should be retrievable");
  assert.strictEqual(cache.get("a", 1), undefined, "a must remain evicted when b inserted");

  // prove independent instances are isolated from the exported singleton
  const other = graphTableDataCache; // singleton
  const insA = new GraphTableDataCache();
  const insB = new GraphTableDataCache();
  const insAEpoch = insA.captureEpoch();
  const insAData: GraphTableData = { columns: [], rows: [] };
  assert.strictEqual(insA.putIfCurrent(insAEpoch, "x", 1, insAData), true);
  assert.strictEqual(insB.get("x", 1), undefined, "different instance must not see other instance's entry");

  // invalidateDataset is idempotent and advances epoch even if not cached
  const preInv = cache.captureEpoch();
  cache.invalidateDataset("a");
  const postInv = cache.captureEpoch();
  assert.ok(postInv > preInv, "invalidateDataset should advance epoch");
  const postInv2 = cache.captureEpoch();
  cache.invalidateDataset("a");
  assert.ok(cache.captureEpoch() > postInv2, "invalidateDataset should advance epoch again (idempotent)");

  // clear is idempotent and advances epoch
  const preClear = cache.captureEpoch();
  cache.clear();
  assert.ok(cache.captureEpoch() > preClear, "clear should advance epoch");
  const preClear2 = cache.captureEpoch();
  cache.clear();
  assert.ok(cache.captureEpoch() > preClear2, "clear should advance epoch again (idempotent)");

  // an epoch captured before invalidation cannot commit afterward (invalidateDataset)
  const eBefore = cache.captureEpoch();
  cache.invalidateDataset("x");
  const dataX: GraphTableData = { columns: [], rows: [] };
  assert.strictEqual(cache.putIfCurrent(eBefore, "x", 1, dataX), false, "stale epoch should not commit after invalidation");

  // an epoch captured before clear cannot commit afterward (clear)
  const eBeforeClear = cache.captureEpoch();
  cache.clear();
  const dataY: GraphTableData = { columns: [], rows: [] };
  assert.strictEqual(cache.putIfCurrent(eBeforeClear, "y", 1, dataY), false, "stale epoch should not commit after clear");

  console.log("graph table data cache passed");
}

run().catch((err) => {
  // surface error to node exit
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 2;
});
