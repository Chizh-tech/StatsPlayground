# Task 2 Report - Preserve Axis And Rendering Policies

Date: 2026-08-25
Task: Task 2 (preserve axis and rendering policies)
Worktree: C:\Users\v-zhichuang\git\ashton2914\StatsPlayground-unified-graph-pipeline
Branch: feature/unified-graph-pipeline

## Implementation Summary
- Strengthened `tests/axisBinding.test.ts` to assert atomic axis-binding integration in `bindFieldToSlot`, including the prepared contract, single `updateItem` payload shape, and same-field re-drop behavior.
- Strengthened `tests/graphAnimation.test.ts` to assert the final 2D option boundary is wrapped with `withoutGraphAnimation` after layer interleaving, while interaction-only axis patches remain local `animation: false` patches.
- Rewrote `tests/scatterProgressive.test.ts` to assert:
  - `Graph.tsx` hosts `RawPointsLayer`,
  - `transform.ts` emits frame-backed raw descriptors through `buildFrameBackedRawDescriptor`,
  - frame-backed build path uses `frameSafeData` to avoid production ECharts raw-row plotting,
  - raw scatter branch keeps `progressive: 0`, preserves `__pick`, and does not enable `large: true`.
- Applied minimal production repair in `src/components/graphBuilder/GraphBuilderView.tsx` to use an explicit prepared axis-binding object and keep atomic updates axis-scoped.

## Step 1 - Strengthen Regressions Before Production Edits
Edited:
- `tests/axisBinding.test.ts`
- `tests/graphAnimation.test.ts`
- `tests/scatterProgressive.test.ts`

Notes:
- This tightened assertions against unified pipeline policy surfaces without touching legacy loader/cache removal scope.

## Step 2 - RED Evidence
Exact commands and relevant output:

```powershell
node --experimental-strip-types tests/axisBinding.test.ts
# ExitCode: 1
# AssertionError [ERR_ASSERTION]: bindFieldToSlot should hold prepareAxisBinding output in a named variable before branching

node --experimental-strip-types tests/graphAnimation.test.ts
# ExitCode: 0
# graph animation policy checks passed

node --experimental-strip-types tests/scatterProgressive.test.ts
# ExitCode: 0
# scatter progressive source regression passed
```

RED conclusion:
- The strengthened axis-binding contract failed as expected, indicating integration shape drift in `bindFieldToSlot`.

## Step 3 - Implement Atomic Axis Updates
Production edit:
- `src/components/graphBuilder/GraphBuilderView.tsx`

Final behavior implemented:
- `bindFieldToSlot` computes:

```ts
const prepared = prepareAxisBinding(
  prevField?.name,
  field.name,
  hadMulti,
  prevAxis,
);
const { bindingChanged, axisConfig } = prepared;
```

- Atomic path remains a single `updateItem(item.id, { ... })` payload containing:
  - updated `encoding[slot]`,
  - corresponding axis update,
  - matching `multiX`/`multiY` clear.
- Atomic path is axis-scoped via `if (axisKey && bindingChanged)`, preserving same-field non-axis behavior.

## Step 4 - No-Animation Final Boundaries
No production change required; policy preserved after merge:
- 2D full option boundary in `Graph.tsx` remains wrapped by `withoutGraphAnimation(...)`.
- Interaction-only axis drag/wheel patches remain local `setOption({ ...p, animation: false }, { lazyUpdate: true, silent: true })` and are not wrapped.
- 3D full option boundary in `Chart3D.tsx` remains wrapped by `withoutGraphAnimation(...)`.
- No staged animation was added to `RawPointsLayer`.

## Step 5 - GREEN Verification And Commit
Exact commands and relevant output:

```powershell
node --experimental-strip-types tests/axisBinding.test.ts
# ExitCode: 0
# axis binding helper checks passed

node --experimental-strip-types tests/graphAnimation.test.ts
# ExitCode: 0
# graph animation policy checks passed

node --experimental-strip-types tests/scatterProgressive.test.ts
# ExitCode: 0
# scatter progressive source regression passed

node --experimental-strip-types tests/rawPoints.test.ts
# ExitCode: 0
# (no stdout output)

npx tsc -b --pretty false
# ExitCode: 0
# (no stdout output)
```

Commit commands:

```powershell
git add src/components/graphBuilder/GraphBuilderView.tsx src/graphCore/Graph.tsx src/graphCore/Chart3D.tsx src/graphCore/transform.ts tests/axisBinding.test.ts tests/graphAnimation.test.ts tests/scatterProgressive.test.ts
git commit -m "fix(graph): preserve axis and render policies"
```

Commit:
- SHA: `d4723b338d668315172051e14a919ee6f6d55976`
- Subject: `fix(graph): preserve axis and render policies`

## Files Changed
From the commit:
- `src/components/graphBuilder/GraphBuilderView.tsx`
- `tests/axisBinding.test.ts`
- `tests/graphAnimation.test.ts`
- `tests/scatterProgressive.test.ts`

Diffstat:
- 4 files changed, 65 insertions(+), 13 deletions(-)

## Behavior Decisions
1. Atomic axis rebinding was enforced by contract shape and payload-level assertions rather than broad behavioral inference.
2. Final render no-animation stayed at full option boundaries only; live interaction patches remain local and unwrapped.
3. Canvas ownership for production raw points was validated through frame-backed descriptor and host-layer assertions, while retaining source-row metadata (`__pick`) and disabling progressive/large fallback in raw scatter series.

## Self-Review (Scope + Test Quality)
- Scope adherence:
  - Completed only Task 2 files and policies.
  - Did not modify legacy loader/cache removal paths assigned to Task 4.
  - No push and no PR actions performed.
- Test quality:
  - Added discriminating policy assertions spanning helper semantics, integration payload shape, rendering-boundary policy, and frame-backed ownership.
  - Captured explicit RED before production repair.
  - Verified GREEN with required command suite plus TypeScript build.

## Concerns
1. Source-level string assertions are intentionally strict and can be brittle to harmless refactors (variable renames/reformatting) even when behavior is unchanged.

## Task 2 Fix Round 1 of 5 (2026-08-25)

### Scope
- Addressed only the listed open findings about brittle source-string assertions and explicit axis-scoped gating enforcement.
- No production code changes were made.

### Files Changed
- `tests/axisBinding.test.ts`
- `tests/graphAnimation.test.ts`
- `tests/scatterProgressive.test.ts`

### What Changed
- `tests/scatterProgressive.test.ts`
  - Replaced exact full-line assertion for `frameSafeData` with whitespace-tolerant regex that checks the semantic ternary shape.
  - Replaced brittle branch slicing using comment/case markers with a small `extractCaseBlock` helper keyed to `case "points"` block parsing by brace depth.
  - Kept policy assertions (`progressive: 0`, `__pick`, no `large: true`, no legacy fallback flags) but made them regex/block-based.
- `tests/graphAnimation.test.ts`
  - Replaced exact internal call-shape substrings with `extractSetOptionCalls` parsing and semantic assertions over discovered `setOption(...)` calls.
  - Enforced two policies behaviorally:
    - one full-option call wraps `withoutGraphAnimation(withInterleavedGraphLayers(option))` and uses `true` notMerge;
    - one interaction patch call uses `animation: false` plus `{ lazyUpdate: true, silent: true }` and is not wrapped.
- `tests/axisBinding.test.ts`
  - Removed style-coupled exact-string assertions (named variable / destructure text form).
  - Added `extractBlockAfter` helper to inspect the atomic guarded branch structurally.
  - Explicitly requires axis-scoped gating via `if (axisKey && bindingChanged)`.
  - Verifies the guarded branch writes encoding, axis config, and multi clear in one `updateItem(item.id, { ... })` payload.

### Exact Commands Run
```powershell
node --experimental-strip-types tests/axisBinding.test.ts
node --experimental-strip-types tests/graphAnimation.test.ts
node --experimental-strip-types tests/scatterProgressive.test.ts
node --experimental-strip-types tests/rawPoints.test.ts
npx tsc -b --pretty false
```

### Relevant Passing Output
```text
axis binding helper checks passed
graph animation policy checks passed
scatter progressive source regression passed
```

(`tests/rawPoints.test.ts` and `npx tsc -b --pretty false` exited 0 with no stdout.)

### Self-Review
- Findings coverage:
  - Replaced brittle full-line/comment-marker/exact-call-shape assertions with helper/regex structural checks.
  - Enforced explicit axis-scoped gating (no permissive `if (bindingChanged)` fallback allowed).
- Scope control:
  - Stayed within requested tests plus report append.
  - Did not modify other task files or production behavior.

## Task 2 Fix Round 2 of 5 (2026-08-25)

### Scope
- Replaced remaining identifier/text-shape assertions with TypeScript compiler-API AST structure checks.
- Kept production code unchanged.

### Files Changed
- `tests/axisBinding.test.ts`
- `tests/graphAnimation.test.ts`
- `tests/scatterProgressive.test.ts`
- `.superpowers/sdd/2026-08-25-unified-graph-pipeline-dev-integration/task-2-report.md`

### What Changed (AST Structural Coverage)
- `tests/axisBinding.test.ts`
  - Parses `GraphBuilderView.tsx` using `typescript` AST instead of regex slicing.
  - Structurally verifies `prepareAxisBinding` feeds a destructured contract (`bindingChanged`, `axisConfig`) used by an AND-gated conditional branch.
  - Verifies the gated `updateItem` object payload includes:
    - `encoding` with computed slot assignment,
    - computed axis property sourced from `axisConfig`,
    - computed matching multi-slot clear (`undefined`).
  - Preserves structural fallback check that non-axis path updates encoding without forced axis/multi reset.
- `tests/graphAnimation.test.ts`
  - Parses `Graph.tsx` and `Chart3D.tsx` AST and inspects `setOption(...)` call nodes directly.
  - Verifies final 2D full-boundary call is `setOption(withoutGraphAnimation(withInterleavedGraphLayers(...)), true)` structurally (wrapper nodes like `as`/parentheses tolerated).
  - Verifies interaction-only patch call is unwrapped object-literal `setOption` with `animation: false` and options `{ lazyUpdate: true, silent: true }`, without requiring exact text layout.
  - Verifies 3D boundary call structurally wraps first argument in `withoutGraphAnimation(..., true)`.
- `tests/scatterProgressive.test.ts`
  - Parses `Graph.tsx` AST to verify `RawPointsLayer` import and JSX render with `descriptor={rawPoints}`.
  - Parses `transform.ts` AST to verify:
    - existence of `buildFrameBackedRawDescriptor`,
    - `frameSafeData` conditional using empty rows when frame-backed,
    - panel object `rawPoints` properties call `buildFrameBackedRawDescriptor` across paths.
  - Structurally verifies `case "points"` includes raw scatter production behavior:
    - scatter series with `progressive: 0`,
    - `__pick` metadata present,
    - no `large: true` on that raw scatter series.

### Exact Commands Run
```powershell
node --experimental-strip-types tests/axisBinding.test.ts
node --experimental-strip-types tests/graphAnimation.test.ts
node --experimental-strip-types tests/scatterProgressive.test.ts
node --experimental-strip-types tests/rawPoints.test.ts
npx tsc -b --pretty false
```

### Relevant Output
```text
axis binding helper checks passed
graph animation policy checks passed
scatter progressive source regression passed
```

(`tests/rawPoints.test.ts` and `npx tsc -b --pretty false` exited 0 with no stdout.)

### Concerns
1. AST checks are intentionally robust to formatting/local renames but still coupled to current control-flow topology (e.g., presence of a dedicated points switch case and explicit setOption boundaries). Major architectural rewrites may require test adaptation.
