# Axis Rebind Full-Range Design

## Problem

Graph Builder persists direct-manipulation axis zoom as `xAxis.min` and
`xAxis.max`. Clearing the X slot removes its encoding but intentionally leaves
axis display configuration in place. When the user then binds a field into the
empty X slot, `bindFieldToSlot` does not classify the operation as a field
change because there is no previous field.

If the new field is categorical, ECharts interprets the stale numeric min/max as
category-index bounds. A high-cardinality column therefore opens on only part of
its categories even though the user just explicitly selected that column and
expects its full range.

## Behavior

Binding a field to X or Y resets data-dependent axis overrides whenever the
effective field binding changes, including:

- an empty slot receiving a field;
- one field being replaced by a different field;
- a multi-field binding collapsing to a single field.

The reset removes only `min`, `max`, and `tickInterval`. Display preferences such
as inverse direction, decimal formatting, axis/tick visibility, tick position,
minor ticks, and grid styling remain unchanged.

Dropping the same field onto an already-bound single-field slot is not a binding
change and preserves the current user zoom. Existing multi-field transitions
continue to reset the range through `setMultiAtSlot`.

## Architecture

Add a small framework-independent helper in the Graph Builder module that
answers whether an axis binding transition must reset data-dependent range
settings and returns the axis config with only those settings cleared. Use the
helper from `bindFieldToSlot` so empty-to-field and different-field transitions
share one rule and can be tested without mounting React.

Do not ignore min/max in `transform.ts`: after the initial full-range render, the
user must still be able to intentionally zoom or pan a categorical axis.

## Testing

Direct tests cover:

1. empty slot to field resets min/max/tickInterval;
2. different field resets them;
3. same field preserves them;
4. display-only axis settings survive a reset;
5. no axis config remains undefined rather than creating an empty object.

A narrow source integration assertion verifies `GraphBuilderView` uses the
helper in `bindFieldToSlot`. TypeScript checking, Vite production build, and
existing graph regressions remain required.
