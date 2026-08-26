## Final Fix

### Scope

- Fixed `loadGraphTableData()` so a pre-aborted call returns `null` before any cache lookup.
- Fixed `loadGraphTableData()` so an empty page with `rows.length < totalRows` throws an incomplete-load error and never caches partial data.
- Fixed `closeProject()` so it synchronously calls `graphTableDataCache.clear()` before resetting project state.

### RED evidence

Command:

```powershell
node --experimental-strip-types tests/loadGraphTableData.test.ts
```

Observed failure before production edits:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ {
+   columns: [
+     'value'
+   ],
+   rows: [
+     [
+       1
+     ],
+     [
+       2
+     ]
+   ]
+ }
- null

at tests/loadGraphTableData.test.ts:110:10
```

This proved the pre-aborted cached path returned cached data instead of honoring the cancellation contract. The same test file also added the incomplete empty-page regression and the `closeProject()` source wiring assertion before the production fix.

### Verification

Commands run after the fix:

```powershell
node --experimental-strip-types tests/graphTableDataCache.test.ts
node --experimental-strip-types tests/loadGraphTableData.test.ts
node --experimental-strip-types tests/graphAnimation.test.ts
npx tsc -b
npx vite build
git diff --check
```

Results:

- `graph table data cache passed`
- `cancellable graph table loader passed`
- `graph animation policy checks passed`
- `npx tsc -b` passed
- `npx vite build` passed
- `git diff --check` passed