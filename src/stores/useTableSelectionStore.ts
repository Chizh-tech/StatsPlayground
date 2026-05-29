import { create } from "zustand";

/**
 * Cross-view cell-pick bridge for GraphBuilder → DataTableView.
 *
 * When the user clicks a point in a graph builder, the corresponding
 * dataset's selection slot is populated with the source `_row_id` plus the
 * column the point came from. The `DataTableView` for that dataset
 * subscribes and translates the slot into its own `activeCell` so the
 * matching cell is highlighted and scrolled into view as soon as the user
 * switches back to the table tab.
 *
 * Notes
 * - State is keyed by `datasetId` so picks made in different graphs (and
 *   targeting different tables) don't trample each other.
 * - The pick PERSISTS until either (a) it is explicitly cleared or
 *   (b) another point is picked in the same dataset's graph. This is what
 *   makes the "saved" UX work — opening the table later still surfaces
 *   the most recent pick.
 * - `ticks[datasetId]` is a monotonic counter that is bumped on every
 *   `pick()` call, even when the picked cell is identical to the previous
 *   one. Subscribers (DataTableView) include it in their effect deps so
 *   re-picking the same cell still triggers the scroll-into-view side
 *   effect (otherwise React would skip the work due to object identity).
 * - This is intentionally NOT persisted to localStorage / projects: a
 *   point pick is an ephemeral inspection gesture, not a saved
 *   preference. Clearing the project clears all picks alongside it.
 */

export interface CellPick {
  /** Value of the dataset's `_row_id` column for the picked row. */
  rowId: number;
  /** Name of the user-visible column to highlight (NOT `_row_id` and NOT
   *  a synthetic melt column). */
  colName: string;
}

interface State {
  byDataset: Record<string, CellPick | null>;
  ticks: Record<string, number>;
  /** Replace the pick for `datasetId`. Pass `null` to clear without
   *  un-tracking the dataset (subscribers still re-run their effect). */
  pick: (datasetId: string, sel: CellPick | null) => void;

  /**
   * Multi-row picks written by the rubber-band brush gesture in GraphBuilder.
   * Each entry is an array of `_row_id` values from the source dataset.
   * Pass an empty array to clear the selection without removing the key.
   */
  rowsByDataset: Record<string, number[] | null>;
  rowTicks: Record<string, number>;
  /** Replace the multi-row pick for `datasetId`. */
  pickRows: (datasetId: string, rowIds: number[]) => void;

  /**
   * Multi-CELL picks written by the rubber-band brush on a scatter plot.
   * Each point in a scatter plot corresponds to a specific (row, column)
   * cell, so the brush should highlight cells, not whole rows. Entries
   * are `{ rowId, colName }` pairs; the consuming DataTableView translates
   * them into its `selectedCells` Set.
   *
   * This is distinct from `rowsByDataset` (used by gestures that genuinely
   * imply whole-row selection, e.g. a future row-level brush) and from
   * `byDataset` (single-cell pick from a point click).
   *
   * Pass an empty array to clear without removing the key (subscribers
   * still re-run their effect — same idiom as the other slots).
   */
  cellsByDataset: Record<string, CellPick[] | null>;
  cellTicks: Record<string, number>;
  pickCells: (datasetId: string, picks: CellPick[]) => void;
}

export const useTableSelectionStore = create<State>((set) => ({
  byDataset: {},
  ticks: {},
  pick: (datasetId, sel) =>
    set((s) => ({
      byDataset: { ...s.byDataset, [datasetId]: sel },
      ticks: { ...s.ticks, [datasetId]: (s.ticks[datasetId] ?? 0) + 1 },
    })),

  rowsByDataset: {},
  rowTicks: {},
  pickRows: (datasetId, rowIds) =>
    set((s) => ({
      rowsByDataset: { ...s.rowsByDataset, [datasetId]: rowIds },
      rowTicks: { ...s.rowTicks, [datasetId]: (s.rowTicks[datasetId] ?? 0) + 1 },
    })),

  cellsByDataset: {},
  cellTicks: {},
  pickCells: (datasetId, picks) =>
    set((s) => ({
      cellsByDataset: { ...s.cellsByDataset, [datasetId]: picks },
      cellTicks: { ...s.cellTicks, [datasetId]: (s.cellTicks[datasetId] ?? 0) + 1 },
    })),
}));
