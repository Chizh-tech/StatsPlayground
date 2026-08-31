# Task 1 Report

## Implementation

Task 1 now distinguishes Fit Y by X personalities from the X field type and uses that personality to drive the default graph and persistence normalization.

- Added `FitYByXPersonality` to the persisted analysis item contract.
- Allowed continuous X values to validate as a factor role.
- Made `createDefaultFitYByXGraphConfig()` personality-aware:
  - categorical X builds the oneway default with `points + boxplot`;
  - continuous X builds the bivariate default with `points + fitline` and the degree-1 fitline options used by Graph Builder.
- Updated the Fit Y by X store loader to derive personality from X on load, replace any mismatched persisted personality, and preserve only graphs that still match the expected analysis family.
- Updated the contract tests so they cover continuous-X creation, personality derivation, and valid persisted graph preservation.

## Files

- `src/types/fitYByX.ts`
- `src/components/fitYByX/fitYByXRoles.ts`
- `src/components/fitYByX/fitYByXConfig.ts`
- `src/stores/useFitYByXStore.ts`
- `tests/fitYByXConfig.test.ts`
- `tests/fitYByXStore.test.ts`

## TDD

### RED

Command:

```powershell
Set-Location 'C:\Users\v-zhichuang\git\ashton2914\StatsPlayground-issue-71'; $out = '.superpowers\sdd\2026-08-31-issue-71-fit-y-by-x-analysis-results\.tmp-fitYByXConfig.test.mjs'; & .\node_modules\.bin\esbuild.cmd tests\fitYByXConfig.test.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=$out; node $out
```

Relevant output:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ true
- 'invalidFactor'
```

This was the stale assumption that a continuous X field should still fail factor validation.

### GREEN

Commands:

```powershell
Set-Location 'C:\Users\v-zhichuang\git\ashton2914\StatsPlayground-issue-71'; $out = '.superpowers\sdd\2026-08-31-issue-71-fit-y-by-x-analysis-results\.tmp-fitYByXConfig.test.mjs'; & .\node_modules\.bin\esbuild.cmd tests\fitYByXConfig.test.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=$out; node $out
Set-Location 'C:\Users\v-zhichuang\git\ashton2914\StatsPlayground-issue-71'; $out = '.superpowers\sdd\2026-08-31-issue-71-fit-y-by-x-analysis-results\.tmp-fitYByXStore.test.mjs'; & .\node_modules\.bin\esbuild.cmd tests\fitYByXStore.test.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=$out; node $out
Set-Location 'C:\Users\v-zhichuang\git\ashton2914\StatsPlayground-issue-71'; $out = '.superpowers\sdd\2026-08-31-issue-71-fit-y-by-x-analysis-results\.tmp-fitYByXDialog.test.mjs'; & .\node_modules\.bin\esbuild.cmd tests\fitYByXDialog.test.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=$out; node $out
Set-Location 'C:\Users\v-zhichuang\git\ashton2914\StatsPlayground-issue-71'; npm run build
```

Relevant output:

```text
fitYByXConfig contract tests passed
fitYByX store contract passed
fitYByX dialog contract tests passed
✓ built in 13.46s
```

## Self-Review

- The personality is derived from the X field every time the item is created or normalized from project data.
- Valid customized graphs stay intact when they still contain the expected family element (`boxplot` for oneway, `fitline` for bivariate); disabled points alone do not invalidate the graph.
- The change stays within the Task 1 boundary and does not touch the unrelated `src-tauri/Cargo.toml` or generated schema edits already present in the worktree.

## Concerns

- The repo build still reports existing Vite chunk-size warnings and an unrelated dynamic-import warning in `dataService.ts`; they are not introduced by this task.
- The implementation currently recognizes validity by the expected family element plus matching X/Y bindings. If later tasks allow more graph variants for Fit Y by X, the family gate may need to be broadened deliberately.

## Fix Round 1

### Findings Addressed

- Updated the Fit Y by X dialog copy so the X role now explicitly accepts continuous, nominal, or ordinal fields in the assignment help, factor subtitle, factor empty hint, and invalid-factor message.
- Added a localized personality badge beside the completed X assignment by deriving `Oneway` or `Bivariate` from the assigned factor with the Task 1 helper.
- Added a store regression proving a valid persisted bivariate graph with a fitline and customized presentation is preserved on load.

### TDD Evidence

RED:

```powershell
Set-Location 'C:\Users\v-zhichuang\git\ashton2914\StatsPlayground-issue-71'; $out1 = '.superpowers\sdd\2026-08-31-issue-71-fit-y-by-x-analysis-results\.tmp-fitYByXDialog.test.mjs'; $out2 = '.superpowers\sdd\2026-08-31-issue-71-fit-y-by-x-analysis-results\.tmp-fitYByXStore.test.mjs'; & .\node_modules\.bin\esbuild.cmd tests\fitYByXDialog.test.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=$out1; node $out1; & .\node_modules\.bin\esbuild.cmd tests\fitYByXStore.test.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=$out2; node $out2
```

GREEN:

```powershell
Set-Location 'C:\Users\v-zhichuang\git\ashton2914\StatsPlayground-issue-71'; $out = '.superpowers\sdd\2026-08-31-issue-71-fit-y-by-x-analysis-results\.tmp-fitYByXConfig.test.mjs'; & .\node_modules\.bin\esbuild.cmd tests\fitYByXConfig.test.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=$out; node $out; npm run build
```

### Files

- `src/components/fitYByX/FitYByXRoleDialog.tsx`
- `src/i18n/locales/en.json`
- `src/i18n/locales/zh-CN.json`
- `src/i18n/locales/zh-TW.json`
- `src/i18n/locales/vi.json`
- `tests/fitYByXDialog.test.ts`
- `tests/fitYByXStore.test.ts`

### Self-Review

- The X-role copy now matches the actual validation and assignment behavior.
- The personality badge is derived locally from the assigned factor, so the role-zone API stays unchanged.
- The persisted bivariate graph regression covers a customized fitline graph shape, not just the default generated graph.