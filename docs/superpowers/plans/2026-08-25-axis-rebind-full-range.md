# Axis Rebind Full-Range Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reset stale data-dependent axis bounds whenever an empty or differently bound X/Y slot receives a field, so a newly selected high-cardinality category column initially displays every category.

**Architecture:** Add one framework-independent Graph Builder helper that classifies binding transitions and removes only `min`, `max`, and `tickInterval`. Integrate its result into `bindFieldToSlot`; leave `transform.ts` unchanged so users can still intentionally zoom category axes after binding.

**Tech Stack:** React 19, TypeScript 5.7, direct Node TypeScript tests, Vite 6.

## Global Constraints

- Empty-to-field, different-field, and multi-to-single transitions reset data-dependent range settings.
- Same-field re-drop preserves the current zoom.
- Preserve inverse, decimals, tick/grid styles, minor ticks, and axis visibility settings.
- Do not disable category-axis zoom or alter ECharts options.
- Do not add dependencies, backend changes, or unrelated refactors.

---

### Task 1: Reset Axis Range On Binding Change

**Files:**
- Create: `src/components/graphBuilder/axisBinding.ts`
- Create: `tests/axisBinding.test.ts`
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`

**Interfaces:**
- Consumes: `YAxisConfig`, previous and next field names, and whether the slot was previously in multi-mode.
- Produces: `prepareAxisBinding(previousFieldName, nextFieldName, hadMulti, axisConfig): { bindingChanged: boolean; axisConfig: YAxisConfig | undefined }`.

- [ ] **Step 1: Write the failing helper tests**

Create a direct Node test importing the missing helper and verify:

```ts
const rangeAndStyle = {
  min: 2,
  max: 8,
  tickInterval: 1,
  inverse: true,
  showMajorGrid: true,
};

assert.deepEqual(
  prepareAxisBinding(undefined, "category", false, rangeAndStyle),
  {
    bindingChanged: true,
    axisConfig: { inverse: true, showMajorGrid: true },
  },
);
```

Add independent cases for:

- `"old" -> "new"` clearing range fields;
- `"same" -> "same"` returning the original config object and `bindingChanged: false`;
- `hadMulti: true` resetting even when names match;
- undefined input config staying undefined;
- range-only config becoming undefined after reset;
- all non-range display fields remaining unchanged.

- [ ] **Step 2: Run the helper test and verify RED**

Run:

```powershell
node --experimental-strip-types tests/axisBinding.test.ts
```

Expected: module-not-found failure for `axisBinding.ts`.

- [ ] **Step 3: Implement the minimal helper**

Implement `prepareAxisBinding` with:

```ts
const bindingChanged = hadMulti || previousFieldName !== nextFieldName;
```

When unchanged, preserve the exact `axisConfig` object. When changed, remove
`min`, `max`, and `tickInterval` by object rest destructuring. Return `undefined`
if no display fields remain; otherwise return the preserved display fields.

- [ ] **Step 4: Write the failing component wiring assertion**

Extend `tests/axisBinding.test.ts` to read `GraphBuilderView.tsx` and assert
`bindFieldToSlot` calls:

```ts
prepareAxisBinding(prevField?.name, field.name, hadMulti, prevAxis)
```

and uses `bindingChanged` to choose the atomic `updateItem` path. Run the test
and confirm the wiring assertion fails before editing the component.

- [ ] **Step 5: Integrate the helper**

Import `prepareAxisBinding` from `./axisBinding`. In `bindFieldToSlot`, replace
the current `fieldChanged`/`needsAxisReset` calculation with the helper result.
For an X/Y binding change, atomically update encoding, clear multi-mode, and set
the corresponding axis key to the returned config. For non-axis or same-field
bindings, preserve the existing `setEncoding` behavior.

- [ ] **Step 6: Run focused and full frontend verification**

Run:

```powershell
node --experimental-strip-types tests/axisBinding.test.ts
node --experimental-strip-types tests/scatterProgressive.test.ts
node --experimental-strip-types tests/graphAnimation.test.ts
node --experimental-strip-types tests/graphTableDataCache.test.ts
node --experimental-strip-types tests/loadGraphTableData.test.ts
npx tsc -b
npx vite build
git diff --check
```

Expected: all direct tests print pass messages; TypeScript, Vite, and diff check
exit `0`.

- [ ] **Step 7: Commit the fix**

```powershell
git add src/components/graphBuilder/axisBinding.ts tests/axisBinding.test.ts src/components/graphBuilder/GraphBuilderView.tsx
git commit -m "fix(graph): reset range on axis rebind"
```