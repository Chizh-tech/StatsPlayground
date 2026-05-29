/**
 * Graph Builder — 交互式图形构建器
 *
 * 布局：
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ ChartTypeBar （顶部图形类型切换）                                  │
 *   ├──────────┬──────────────────────────────────────┬───────────────┤
 *   │ 列调色板  │ ┌──── 顶部分组 (Group X) ────────┐  │ 编码槽         │
 *   │ + 元素   │ │                                │  │ Overlay       │
 *   │   设置面板│ │      绘图画布 (Graph Core)      │  │ Color         │
 *   │          │ │                                │  │ Size          │
 *   │          │ └────────────────────────────────┘  │ Group X       │
 *   │          │ X 轴槽                              │ Group Y       │
 *   ├──────────┴──────────────────────────────────────┴───────────────┤
 *   │ 工具栏 (Undo / Start Over / Done) — 当前作占位                    │
 *   └──────────────────────────────────────────────────────────────────┘
 */

import { useEffect, useMemo, useState, useCallback, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { dataService } from "@/services/dataService";
import { Graph, inferFieldType, isMissing, DEFAULT_GROUP_KEY, type FieldRef, type FieldType, type GraphSpec, type GraphData, type ChartElement, type ElementKind, type MarkStyle, type GroupStyle, type GroupStyleMap, type MarkerShape, type RefLineY, type RefLineX, type RefLineStyle, type BandRefLine, type YAxisConfig, type GridLineStyle } from "@/graphCore";
import type { DatasetMeta } from "@/types/data";
import type { GraphBuilderItem, GraphSlotKey } from "@/types/graphBuilder";
import type { FilterRuleItem } from "@/types/filter";
import { useGraphBuilderStore } from "@/stores/useGraphBuilderStore";
import { useProjectStore } from "@/stores/useProjectStore";
import { useGraphPaletteStore, type CustomPalette } from "@/stores/useGraphPaletteStore";
import { useTableSelectionStore } from "@/stores/useTableSelectionStore";
import { ctxMenuRef } from "@/utils/ctxMenu";
import { AddPaletteDialog } from "./AddPaletteDialog";
import { FilterPanel, applyFilters } from "@/components/filter";

interface GraphBuilderViewProps {
  item: GraphBuilderItem;
  dataset: DatasetMeta;
}

/** 所有可用的编码槽位 */
type SlotKey = GraphSlotKey;

// Color / Size / Wrap encoding channels were intentionally removed —
// the per-group Style editor (Line / Fill / Point) supersedes them.
// Overlay drives legend grouping and now lives inside the LegendStylePanel.
// Group X / Group Y are still exposed via the dedicated facet drop slots
// surrounding the canvas, not via a side shelf.

interface ChartTypeDef {
  kind: ElementKind;
  icon: string; // 简单文字/符号图标（暂用 SVG path 太重）
}

const CHART_TYPE_DEFS: ChartTypeDef[] = [
  { kind: "points", icon: "●" },
  { kind: "line", icon: "╱" },
  { kind: "smoother", icon: "∿" },
  { kind: "fitline", icon: "ƒ" },
  { kind: "boxplot", icon: "⊟" },
  { kind: "histogram", icon: "▥" },
];

/** 数据类型对应的小图标 */
function fieldTypeIcon(t: FieldType): string {
  switch (t) {
    case "continuous": return "▰";
    case "ordinal": return "≣";
    case "datetime": return "◷";
    case "id": return "#";
    default: return "▤";
  }
}

function fieldTypeColor(t: FieldType): string {
  switch (t) {
    case "continuous": return "#2ca678";
    case "datetime": return "#9168d6";
    case "id": return "#7f8c8d";
    default: return "#ef8a3a";
  }
}

const DRAG_MIME = "text/plain";

export function GraphBuilderView({ item, dataset }: GraphBuilderViewProps) {
  const { t } = useTranslation();
  const updateItem = useGraphBuilderStore((s) => s.updateItem);
  const markDirty = useProjectStore((s) => s.markDirty);
  // Cross-view bridge: click a scatter point → highlight the matching
  // cell in the DataTableView for `dataset.id` next time it mounts.
  const pickCell = useTableSelectionStore((s) => s.pick);

  const [columns, setColumns] = useState<FieldRef[]>([]);
  const [colSqlTypes, setColSqlTypes] = useState<string[]>([]);
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Y-axis settings dialog open state. Opened by double-clicking the Y
  // axis (or its label/title area) in <Graph>; closed via the dialog's
  // Done button or overlay click.
  const [yAxisDialogOpen, setYAxisDialogOpen] = useState(false);
  // X-axis settings dialog open state. Mirrors `yAxisDialogOpen` —
  // opened by double-clicking the X axis (or its label / title strip).
  const [xAxisDialogOpen, setXAxisDialogOpen] = useState(false);
  // Per-column user-defined value ordering, keyed by column name. Populated
  // from the dataset's `ColumnDisplayProps.extras.valueOrder.values`. Used
  // by <Graph> to reorder categorical X axes, legend entries, boxplot
  // category positions, and faceted-panel ordering. Re-fetched on focus so
  // edits made in DataTableView take effect when the user switches back to
  // the graph tab.
  const [valueOrders, setValueOrders] = useState<Record<string, string[]>>({});

  // Per-column spec limits (LSL / Target / USL) pulled from the dataset's
  // `ColumnDisplayProps.extras.spec`. Keyed by column name so the auto
  // spec-limit overlay can look up the active Y column's limits in O(1).
  // Only columns with at least one finite limit are included; an empty
  // map means "no auto-spec-line overlay possible". Reloaded together
  // with `valueOrders` so DataTableView edits round-trip on tab switch.
  // Future multi-Y / facet-on-X work will fan this out by group key
  // instead of by column name.
  const [specByCol, setSpecByCol] = useState<Record<string, { lsl?: number; target?: number; usl?: number }>>({});

  // Multi-select state for the column list (left rail). Plain click =
  // single select; Ctrl/Cmd+click = toggle one; Shift+click = range
  // select between the click anchor and the current item. When the
  // user starts a drag on a selected item, the drag payload becomes
  // ALL selected fields (multi-drag). Drag on an unselected item
  // clears selection and drags only that one (single-drag, identical
  // to pre-multi-select behavior). The selection is purely transient
  // UI state — not persisted with the project. */
  const [selectedColNames, setSelectedColNames] = useState<Set<string>>(() => new Set());
  // Anchor for Shift+click range selection — last column the user
  // clicked WITHOUT shift. Reset to the clicked item on every plain /
  // ctrl click. Shift+click preserves the anchor.
  const colAnchorRef = useRef<string | null>(null);
  // Visual reject-flash state per slot. Set briefly to flash the slot
  // red when a multi-drop is rejected (mixed numeric / non-numeric,
  // or non-numeric appended in multi-mode). The Slot component reads
  // this and adds a CSS class for ~400 ms.
  const [rejectFlashSlot, setRejectFlashSlot] = useState<SlotKey | null>(null);
  const rejectFlashTimerRef = useRef<number | null>(null);
  const flashRejectOnSlot = useCallback((slot: SlotKey) => {
    setRejectFlashSlot(slot);
    if (rejectFlashTimerRef.current !== null) {
      window.clearTimeout(rejectFlashTimerRef.current);
    }
    rejectFlashTimerRef.current = window.setTimeout(() => {
      setRejectFlashSlot(null);
      rejectFlashTimerRef.current = null;
    }, 400);
  }, []);
  useEffect(() => {
    return () => {
      if (rejectFlashTimerRef.current !== null) {
        window.clearTimeout(rejectFlashTimerRef.current);
      }
    };
  }, []);
  // Which slot's multi-mode manager popover is currently open. null
  // means no manager is open. Only one manager can be open at a time
  // (they're mutually exclusive — opening one closes the other).
  const [managerOpenSlot, setManagerOpenSlot] = useState<SlotKey | null>(null);
  // Right-click context menu on a slot (X / Y / Group X / Group Y /
  // Overlay). Lifted up here (rather than per-Slot state) so opening
  // a menu on one slot implicitly closes any other slot's menu — a
  // single source of truth keeps the close-on-outside-click handler
  // simple. Position is in viewport coordinates (clientX / clientY).
  const [slotCtxMenu, setSlotCtxMenu] = useState<{ slot: SlotKey; x: number; y: number } | null>(null);
  // Close the slot context menu on any left click outside the menu
  // itself, and also on any other contextmenu (so right-clicking a
  // different slot replaces the menu cleanly). Mirrors the pattern in
  // DataTableView's column / cell context menus. Items inside the menu
  // call `stopPropagation` so the close handler doesn't fire before
  // their own onClick.
  useEffect(() => {
    if (!slotCtxMenu) return;
    const close = () => setSlotCtxMenu(null);
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
    };
  }, [slotCtxMenu]);
  // Auto-close the manager when its slot leaves multi-mode (cols
  // dropped below 2 via deletion in the manager itself, slot-clear,
  // swap XY, start-over, etc.). Without this, the next time the user
  // re-enters multi-mode on the same slot the manager would pop open
  // by itself because `managerOpenSlot` was still set from before.
  useEffect(() => {
    if (!managerOpenSlot) return;
    const cols =
      managerOpenSlot === "x" ? item.multiX : managerOpenSlot === "y" ? item.multiY : undefined;
    if ((cols?.length ?? 0) < 2) setManagerOpenSlot(null);
  }, [managerOpenSlot, item.multiX, item.multiY]);

  // Resizable side-rail widths. Mirror the Excel-grid splitter pattern
  // (DataTableView): clamp on drag and double-click to reset.
  const [leftWidth, setLeftWidth] = useState(220);
  const [rightWidth, setRightWidth] = useState(220);
  // Local Data Filter panel (toggled by the toolbar Filter button).
  const [showFilters, setShowFilters] = useState(false);
  const [filterWidth, setFilterWidth] = useState(240);
  // Vertical split inside the left rail: percentage of the rail's height
  // that goes to the column list, the rest to LAYERS. Mirrors the
  // history-divider pattern in HistoryPanel.
  const [leftTopPct, setLeftTopPct] = useState(50);
  const leftRailRef = useRef<HTMLDivElement>(null);
  const startSideResize = useCallback(
    (side: "left" | "right" | "filter") => (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW =
        side === "left" ? leftWidth : side === "right" ? rightWidth : filterWidth;
      // Splitter on the right edge of a panel grows when dragged right (+1).
      // The right rail splitter is to the LEFT of the right panel, so dragging
      // right shrinks it (-1).
      const dir = side === "right" ? -1 : 1;
      const onMove = (ev: MouseEvent) => {
        const next = Math.max(160, Math.min(500, startW + dir * (ev.clientX - startX)));
        if (side === "left") setLeftWidth(next);
        else if (side === "right") setRightWidth(next);
        else setFilterWidth(next);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [leftWidth, rightWidth, filterWidth],
  );

  // Vertical drag inside the left rail (between TABLE columns and LAYERS).
  const startLeftRowResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const rail = leftRailRef.current;
      if (!rail) return;
      const railH = rail.clientHeight;
      if (railH <= 0) return;
      const startY = e.clientY;
      const startPct = leftTopPct;
      const onMove = (ev: MouseEvent) => {
        const deltaPct = ((ev.clientY - startY) / railH) * 100;
        setLeftTopPct(Math.max(15, Math.min(85, startPct + deltaPct)));
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [leftTopPct],
  );

  // 编码状态从 store 派生
  const encoding = item.encoding;
  const elements = item.elements;
  const smootherLambda = item.smootherLambda;
  // Filter rules (JMP-style Local Data Filter). Persist on the item so
  // they survive project save/load. `filteredData` below feeds the
  // renderer instead of the raw `data`.
  const filters = useMemo(() => item.filters ?? [], [item.filters]);

  // Apply the user's filter rules to the raw data once per change.
  // Everything downstream (groupKeys, the spec, the rendered Graph and
  // the legend's distinct-value enumeration) reads `filteredData`.
  const filteredData = useMemo(
    () => applyFilters(data, filters),
    [data, filters],
  );

  // ---- Multi-column melt (multi-mode rendering) ---------------------
  //
  // When the user drops 2+ numeric columns onto one axis at once,
  // that axis enters "multi-mode": `item.multiX` or `item.multiY`
  // holds the list of dropped columns. There are two render modes,
  // chosen at render time based on whether the OTHER axis is bound:
  //
  //   - "axis" mode (other axis empty): the dropped column NAMES
  //     become the multi-mode axis (categorical) and the dropped
  //     column VALUES become the other axis (continuous). This lets
  //     the user instantly compare similar-typed columns side by
  //     side without a separate melt step.
  //
  //   - "merge" mode (other axis bound): all dropped column values
  //     are concatenated into one anonymous series on the multi-mode
  //     axis (continuous), against the bound other axis. Mirrors the
  //     "long-form" data layout — every dropped column contributes
  //     its rows to the same plotted series.
  //
  // The melt rewrites `filteredData` by:
  //   - keeping all original columns (so legend/overlay/group still
  //     reference the same data),
  //   - appending two synthetic columns `__sp_variable__` (the
  //     source column NAME) and `__sp_value__` (the per-row value
  //     from that column),
  //   - emitting N rows per original row, where N = number of
  //     melted columns.
  //
  // The spec then sees a synthetic FieldRef for the affected axis /
  // axes pointing at these synthetic columns, so transform.ts and
  // ECharts don't need to know multi-mode exists. */
  const MELT_VAR = "__sp_variable__";
  const MELT_VAL = "__sp_value__";
  const meltInfo = useMemo<
    | {
        slot: "x" | "y";
        cols: FieldRef[];
        mode: "axis" | "merge";
        varField: FieldRef;
        valField: FieldRef;
      }
    | null
  >(() => {
    // At most one axis can be in multi-mode at a time
    // (setMultiAtSlot enforces this on the write side). On read,
    // if both happen to be set (e.g. an older project file), prefer
    // X — it's the more common axis to multi-drop on.
    const mx = item.multiX ?? [];
    const my = item.multiY ?? [];
    const xActive = mx.length >= 2;
    const yActive = my.length >= 2;
    if (!xActive && !yActive) return null;
    const slot: "x" | "y" = xActive ? "x" : "y";
    const cols = slot === "x" ? mx : my;
    const otherBound = slot === "x" ? !!item.encoding.y : !!item.encoding.x;
    const mode: "axis" | "merge" = otherBound ? "merge" : "axis";
    return {
      slot,
      cols,
      mode,
      varField: { name: MELT_VAR, type: "nominal" },
      valField: { name: MELT_VAL, type: "continuous" },
    };
  }, [item.multiX, item.multiY, item.encoding.x, item.encoding.y]);

  // Build the melted dataset. Returns `filteredData` unchanged when
  // not in multi-mode (zero-cost no-op). */
  const effectiveData = useMemo<GraphData | null>(() => {
    if (!filteredData) return filteredData;
    if (!meltInfo) return filteredData;
    const colIdx = meltInfo.cols.map((c) =>
      filteredData.columns.indexOf(c.name),
    );
    const newCols = [...filteredData.columns, MELT_VAR, MELT_VAL];
    const newRows: unknown[][] = [];
    for (const row of filteredData.rows) {
      for (let i = 0; i < meltInfo.cols.length; i++) {
        const ci = colIdx[i];
        const v = ci >= 0 ? row[ci] : null;
        newRows.push([...row, meltInfo.cols[i].name, v]);
      }
    }
    return { columns: newCols, rows: newRows };
  }, [filteredData, meltInfo]);

  // Build the effective encoding for the renderer. In multi-mode the
  // synthetic FieldRefs replace the affected slot(s); other slots
  // (overlay, group X/Y, etc.) pass through untouched. */
  const effectiveEncoding = useMemo<typeof item.encoding>(() => {
    if (!meltInfo) return item.encoding;
    const enc = { ...item.encoding };
    if (meltInfo.slot === "x") {
      if (meltInfo.mode === "axis") {
        enc.x = meltInfo.varField;
        enc.y = meltInfo.valField;
      } else {
        enc.x = meltInfo.valField;
        // enc.y stays as the user's bound Y field.
      }
    } else {
      if (meltInfo.mode === "axis") {
        enc.y = meltInfo.varField;
        enc.x = meltInfo.valField;
      } else {
        enc.y = meltInfo.valField;
        // enc.x stays as the user's bound X field.
      }
    }
    return enc;
  }, [item.encoding, meltInfo]);

  // User-saved CustomPalettes feed into legend default-color assignment:
  // when a group doesn't have an explicit style override yet, the renderer
  // walks these palettes first before falling back to GROUP_COLORS.
  const customPalettes = useGraphPaletteStore((s) => s.palettes);

  // Distinct group values driving the legend. Lifted from LegendStylePanel
  // so the parent can pre-compute effectiveStyles in the same single source
  // of truth that gets handed both to the renderer (via spec.styles) and to
  // the panel (for swatches and the editor's "default vs override" check).
  //
  // Two rules govern which group keys make the cut:
  //   1. The group value itself must be non-missing (skip blanks/whitespace
  //      so we don't surface a phantom "" legend entry).
  //   2. After applying the user's filter rules the group must still have
  //      at least one row that would actually plot something — i.e. every
  //      encoded field in {x, y} is non-missing for that row. A group
  //      whose Y is entirely null in the filtered region produces zero
  //      marks and would otherwise leave a dead legend swatch behind.
  const groupKeys = useMemo<string[]>(() => {
    const groupField = encoding.overlay;
    if (!groupField || !filteredData) return [DEFAULT_GROUP_KEY];
    const colIdx = filteredData.columns.indexOf(groupField.name);
    if (colIdx < 0) return [DEFAULT_GROUP_KEY];
    const xIdx = encoding.x ? filteredData.columns.indexOf(encoding.x.name) : -1;
    const yIdx = encoding.y ? filteredData.columns.indexOf(encoding.y.name) : -1;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of filteredData.rows) {
      const gv = r[colIdx];
      if (isMissing(gv)) continue;
      // Drop the row from the legend census if a bound encoding channel
      // is missing on it — the renderer would skip it too, so it must
      // not count toward "this group has data".
      if (xIdx >= 0 && isMissing(r[xIdx])) continue;
      if (yIdx >= 0 && isMissing(r[yIdx])) continue;
      const k = String(gv);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    return out.length > 0 ? out : [DEFAULT_GROUP_KEY];
  }, [encoding.overlay, encoding.x, encoding.y, filteredData]);

  const effectiveStyles = useMemo<GroupStyleMap>(
    () =>
      buildEffectiveStyles(
        groupKeys,
        item.groupStyles ?? {},
        customPalettes,
        !!encoding.overlay,
        elements.some((e) => e.kind === "boxplot" && e.enabled !== false),
      ),
    [groupKeys, item.groupStyles, customPalettes, encoding.overlay, elements],
  );

  const setEncoding = useCallback(
    (
      updater:
        | typeof encoding
        | ((prev: typeof encoding) => typeof encoding),
    ) => {
      const next =
        typeof updater === "function"
          ? (updater as (p: typeof encoding) => typeof encoding)(item.encoding)
          : updater;
      updateItem(item.id, { encoding: next });
      markDirty();
    },
    [item.id, item.encoding, updateItem, markDirty],
  );
  const setElements = useCallback(
    (
      updater: ChartElement[] | ((prev: ChartElement[]) => ChartElement[]),
    ) => {
      const next =
        typeof updater === "function"
          ? (updater as (p: ChartElement[]) => ChartElement[])(item.elements)
          : updater;
      updateItem(item.id, { elements: next });
      markDirty();
    },
    [item.id, item.elements, updateItem, markDirty],
  );
  // NOTE: there is no longer a workspace-level "smoothness" slider —
  // that was replaced by the per-layer SmootherOptions panel which
  // edits `element.options.algo` and the per-algorithm parameters
  // directly. `item.smootherLambda` is still kept in the schema so old
  // projects load cleanly and seed back-compat for legacy smoother
  // elements (see `finalElements` above) but nothing in the UI ever
  // writes to it any more.
  const setFilters = useCallback(
    (next: FilterRuleItem[]) => {
      updateItem(item.id, { filters: next });
      markDirty();
    },
    [item.id, updateItem, markDirty],
  );

  // 加载列信息 + 全表数据
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const cols = await dataService.getColumns(dataset.id);
        const fields: FieldRef[] = cols.map(([name, type]) => ({
          name,
          type: inferFieldType(type),
        }));
        const sqlTypes = cols.map(([, type]) => type);
        // 简化：一次性拉取全部数据（后续可流式优化）
        const result = await dataService.queryTable({
          datasetId: dataset.id,
          page: 0,
          pageSize: Math.max(1, dataset.rowCount || 100000),
        });
        // Pull per-column display props in parallel with data so the
        // Value Order metadata is available on first render. Display
        // props can legitimately be missing (older projects, fresh
        // datasets) — treat any failure as "no value orders".
        let displayProps: Awaited<ReturnType<typeof dataService.getColumnDisplayProps>> = [];
        try {
          displayProps = await dataService.getColumnDisplayProps(dataset.id);
        } catch { /* ignore — empty value orders are fine */ }
        if (cancelled) return;
        // Build the colIndex → name map from `cols` (which already excludes
        // internal `_row_id` because get_user_columns filters it out). The
        // colIndex stored in ColumnDisplayProps is the visible-column
        // index, so it indexes directly into `cols`.
        const vo: Record<string, string[]> = {};
        // Build the spec map in the same pass over displayProps so we
        // only walk the array once. A column is added only if at least
        // one of LSL / Target / USL is a finite number — columns whose
        // spec extras are present but blank shouldn't trigger the auto
        // overlay.
        const sp: Record<string, { lsl?: number; target?: number; usl?: number }> = {};
        for (const p of displayProps) {
          const ex = p.extras as Record<string, unknown> | undefined;
          const node = ex?.valueOrder as { values?: unknown } | undefined;
          const vals = node?.values;
          const colName = cols[p.colIndex]?.[0];
          if (colName && Array.isArray(vals) && vals.length > 0) {
            vo[colName] = vals.map((v) => String(v));
          }
          const specExtra = ex?.spec as { lsl?: unknown; target?: unknown; usl?: unknown } | undefined;
          if (colName && specExtra) {
            const out: { lsl?: number; target?: number; usl?: number } = {};
            const lsl = Number(specExtra.lsl);
            const target = Number(specExtra.target);
            const usl = Number(specExtra.usl);
            if (Number.isFinite(lsl)) out.lsl = lsl;
            if (Number.isFinite(target)) out.target = target;
            if (Number.isFinite(usl)) out.usl = usl;
            if (out.lsl !== undefined || out.target !== undefined || out.usl !== undefined) {
              sp[colName] = out;
            }
          }
        }
        setColumns(fields);
        setColSqlTypes(sqlTypes);
        setData({ columns: result.columns, rows: result.rows });
        setValueOrders(vo);
        setSpecByCol(sp);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dataset.id, dataset.rowCount]);

  /** Resolve final per-element options. The smoother layer used to be
   *  driven by a single workspace-level `smootherLambda` slider; that
   *  slider has been replaced by the per-layer SmootherOptions panel
   *  (algorithm + per-algo params). For backwards compatibility we
   *  still seed `lambda` from the workspace value when a smoother
   *  element predates the per-layer panel — i.e. it has neither an
   *  explicit algorithm choice nor its own `lambda`/`windowFraction`.
   *  Brand-new layers and explicitly-configured ones are passed
   *  through untouched so the panel's settings are not overwritten. */
  const finalElements = useMemo<ChartElement[]>(() => {
    return elements.map((el) => {
      if (el.kind !== "smoother") return el;
      const o = el.options ?? {};
      if (
        o.algo !== undefined ||
        o.lambda !== undefined ||
        o.windowFraction !== undefined
      ) {
        return el;
      }
      return { ...el, options: { ...o, lambda: smootherLambda } };
    });
  }, [elements, smootherLambda]);

  const spec = useMemo<GraphSpec>(() => {
    const enc: GraphSpec["encoding"] = {};
    // Color / Size / Wrap encoding channels were removed in favour of the
    // per-group Style editor. Drop them when building the spec so legacy
    // projects don't surprise the user with auto-coloring or auto-sizing.
    const SKIP_KEYS = new Set<SlotKey>(["color", "size", "wrap"]);
    (Object.keys(effectiveEncoding) as SlotKey[]).forEach((k) => {
      if (SKIP_KEYS.has(k)) return;
      const v = effectiveEncoding[k];
      if (v) (enc as any)[k] = v;
    });
    // Resolve the auto spec-limit overlay independently for each axis.
    // X and Y each carry their OWN `autoSpecLinesX` / `autoSpecLinesY`
    // flag, so a chart with two value columns (one on X, one on Y) can
    // turn the overlay on for one axis, the other, or both —
    // mirroring how each axis has its own ref-lines and axis-settings
    // dialog. The legacy single `autoSpecLines` flag (pre-symmetric
    // build) is used as a fallback for any per-axis field still
    // `undefined`, so old projects keep their previous behavior on
    // first load until the user touches either checkbox.
    //
    // In multi-mode the auto-spec overlay is handled differently —
    // the single-column overlay (autoSpecY / autoSpecX) is disabled
    // because there's no longer a single underlying column; instead
    // each dropped column contributes its OWN LSL / Target / USL ref
    // lines on the value axis (computed below). This way the user
    // can see per-column spec limits side by side on the same axis
    // even after the columns were merged via melt. */
    const legacy = item.autoSpecLines;
    const onY = !meltInfo && (item.autoSpecLinesY ?? legacy ?? false);
    const onX = !meltInfo && (item.autoSpecLinesX ?? legacy ?? false);
    const yName = effectiveEncoding.y?.name;
    const xName = effectiveEncoding.x?.name;
    const yLimits = onY && yName ? specByCol[yName] : undefined;
    const xLimits = onX && xName ? specByCol[xName] : undefined;
    const autoSpecY = yLimits ? { ...yLimits, colName: yName } : undefined;
    const autoSpecX = xLimits ? { ...xLimits, colName: xName } : undefined;

    // Multi-mode per-column auto-spec ref lines. Computed here (rather
    // than persisted on the item) so toggling the checkbox in the
    // axis-settings dialog doesn't pollute the user's editable
    // ref-lines list. Each column contributes up to three lines (LSL,
    // Target, USL) drawn on whichever axis ended up carrying the
    // synthetic value column: in "axis" mode that's the axis opposite
    // the multi-drop slot; in "merge" mode it's the multi-drop slot
    // itself.
    //
    // Two rendering strategies, picked off `meltInfo.mode`:
    //
    //   - "axis" mode (variable column on the OTHER axis): every
    //     melted column becomes its own category band on the variable
    //     axis. Drawing full-width spec lines across all categories
    //     would visually attribute one column's USL to every other
    //     column AND let labels stack on top of one another when
    //     limits sit close together. Emit `BandRefLine` entries
    //     instead — each line is restricted to its source column's
    //     band on the categorical axis, labels are suppressed (the
    //     column's position on the cat axis already conveys identity),
    //     and they ride a separate carrier series in the renderer.
    //
    //   - "merge" mode (value column on the multi slot, no variable
    //     axis exists): there's no category axis to band against, so
    //     fall back to full-width refLines with column-name labels —
    //     same shape as a manually-added ref line. */
    const extraRefLinesY: RefLineY[] = [];
    const extraRefLinesX: RefLineX[] = [];
    const extraBandRefLines: BandRefLine[] = [];
    if (meltInfo) {
      const valueAxis: "x" | "y" = meltInfo.mode === "axis"
        ? (meltInfo.slot === "y" ? "x" : "y")
        : meltInfo.slot;
      const autoOn = valueAxis === "y"
        ? (item.autoSpecLinesY ?? legacy ?? false)
        : (item.autoSpecLinesX ?? legacy ?? false);
      if (autoOn) {
        let seq = 0;
        if (meltInfo.mode === "axis") {
          // Per-column band segments. `category` is the column name
          // because in axis mode the variable axis is rendered as a
          // category axis with one slot per column (the melt
          // synthesizes a `__sp_variable__` column whose values are
          // exactly the source column names).
          const push = (col: string, kind: "LSL" | "Target" | "USL", v: number) => {
            const id = `auto-spec-band-${col}-${kind}-${++seq}`;
            const color = kind === "Target" ? "#00C853" : "#E60000";
            extraBandRefLines.push({
              id,
              value: v,
              category: col,
              valueAxis,
              color,
              style: "dashed",
              width: 1,
            });
          };
          for (const c of meltInfo.cols) {
            const sp = specByCol[c.name];
            if (!sp) continue;
            if (sp.lsl !== undefined) push(c.name, "LSL", sp.lsl);
            if (sp.target !== undefined) push(c.name, "Target", sp.target);
            if (sp.usl !== undefined) push(c.name, "USL", sp.usl);
          }
        } else {
          // Merge mode: no category axis on the opposite side, so
          // full-width labeled refLines are the only option. Keep
          // the column name in the label so users can still tell
          // which limit came from which column when several columns
          // were merged onto the same value axis.
          const push = (col: string, kind: "LSL" | "Target" | "USL", v: number) => {
            const id = `auto-spec-multi-${col}-${kind}-${++seq}`;
            const color = kind === "Target" ? "#00C853" : "#E60000";
            const label = `${kind}[${col}] = ${Number(v.toPrecision(10))}`;
            const base = { id, label, style: "dashed" as RefLineStyle, color, width: 1 };
            if (valueAxis === "y") extraRefLinesY.push({ ...base, y: v });
            else extraRefLinesX.push({ ...base, x: v });
          };
          for (const c of meltInfo.cols) {
            const sp = specByCol[c.name];
            if (!sp) continue;
            if (sp.lsl !== undefined) push(c.name, "LSL", sp.lsl);
            if (sp.target !== undefined) push(c.name, "Target", sp.target);
            if (sp.usl !== undefined) push(c.name, "USL", sp.usl);
          }
        }
      }
    }
    const finalRefLinesY = extraRefLinesY.length
      ? [...(item.refLinesY ?? []), ...extraRefLinesY]
      : item.refLinesY;
    const finalRefLinesX = extraRefLinesX.length
      ? [...(item.refLinesX ?? []), ...extraRefLinesX]
      : item.refLinesX;
    const finalBandRefLines = extraBandRefLines.length ? extraBandRefLines : undefined;
    return {
      datasetId: dataset.id,
      datasetName: dataset.name,
      encoding: enc,
      elements: finalElements,
      styles: effectiveStyles,
      hiddenGroups: item.hiddenGroups,
      refLinesY: finalRefLinesY,
      refLinesX: finalRefLinesX,
      bandRefLines: finalBandRefLines,
      autoSpecY,
      autoSpecX,
      yAxis: item.yAxis,
      xAxis: item.xAxis,
    };
  }, [effectiveEncoding, meltInfo, finalElements, dataset.id, dataset.name, effectiveStyles, item.hiddenGroups, item.refLinesY, item.refLinesX, item.yAxis, item.xAxis, item.autoSpecLines, item.autoSpecLinesY, item.autoSpecLinesX, specByCol]);

  /** Replace the entire group-style entry for one group (or remove it). */
  const setGroupStyle = useCallback(
    (groupKey: string, next: GroupStyle | undefined) => {
      const cur = item.groupStyles ?? {};
      const updated: GroupStyleMap = { ...cur };
      if (next === undefined) delete updated[groupKey];
      else updated[groupKey] = next;
      updateItem(item.id, { groupStyles: updated });
      markDirty();
    },
    [item.id, item.groupStyles, updateItem, markDirty],
  );

  /** Toggle a group's visibility in the legend (eye-icon button). Hidden
   *  groups keep their color slot reserved — un-hiding restores the same
   *  color — but their series are skipped at render time and excluded
   *  from the shared-axis range calc so visible data fills the chart. */
  const toggleGroupHidden = useCallback(
    (groupKey: string) => {
      const cur = item.hiddenGroups ?? [];
      const next = cur.includes(groupKey)
        ? cur.filter((k) => k !== groupKey)
        : [...cur, groupKey];
      updateItem(item.id, { hiddenGroups: next });
      markDirty();
    },
    [item.id, item.hiddenGroups, updateItem, markDirty],
  );

  /** Clear every per-group override at once — used by the STYLE editor's
   *  Reset button. Lives at the parent level (not inside the panel) so a
   *  multi-group reset is a single atomic store write, instead of N writes
   *  that would each trigger a re-render. */
  const resetAllGroupStyles = useCallback(() => {
    if (!item.groupStyles || Object.keys(item.groupStyles).length === 0) return;
    updateItem(item.id, { groupStyles: {} });
    markDirty();
  }, [item.id, item.groupStyles, updateItem, markDirty]);

  /** Replace the Y-axis reference-line list on this graph item. The
   *  RefLinesEditor below builds the next array (immutable add / patch /
   *  remove) and hands it in; we persist it to the project via the same
   *  updateItem + markDirty pair used elsewhere. */
  const setRefLinesY = useCallback(
    (next: RefLineY[]) => {
      updateItem(item.id, { refLinesY: next });
      markDirty();
    },
    [item.id, updateItem, markDirty],
  );

  /** Replace the X-axis reference-line list on this graph item. Mirror
   *  of `setRefLinesY` for the X axis — same store-write pattern. The
   *  renderer silently drops X ref lines when the X axis is categorical
   *  (they have no meaningful position there), so the editor stays
   *  available even on categorical-X charts and the lines come back
   *  the moment X is rebound to a value column or the axes are swapped. */
  const setRefLinesX = useCallback(
    (next: RefLineX[]) => {
      updateItem(item.id, { refLinesX: next });
      markDirty();
    },
    [item.id, updateItem, markDirty],
  );

  /** Toggle the auto spec-limit overlay on the **Y axis** only.
   *  When enabled, the renderer pulls LSL / Target / USL out of the
   *  Y column's `spec` extras and draws them as red / green dashed
   *  reference lines. X is unaffected — it has its own
   *  `setAutoSpecLinesX` toggle. The flag is per-axis so a chart with
   *  spec extras on both columns can show / hide each overlay
   *  independently. The lines are NOT folded into `refLinesY` — the
   *  user controls the overlay globally via this flag, leaving the
   *  per-line editor below dedicated to manual annotations. */
  const setAutoSpecLinesY = useCallback(
    (next: boolean) => {
      updateItem(item.id, { autoSpecLinesY: next });
      markDirty();
    },
    [item.id, updateItem, markDirty],
  );

  /** Toggle the auto spec-limit overlay on the **X axis** only.
   *  Mirror of `setAutoSpecLinesY` — reads the X column's `extras.spec`
   *  metadata. Independent of the Y flag. The renderer silently skips
   *  the overlay when X is bound to a category / row-index column. */
  const setAutoSpecLinesX = useCallback(
    (next: boolean) => {
      updateItem(item.id, { autoSpecLinesX: next });
      markDirty();
    },
    [item.id, updateItem, markDirty],
  );

  /** Replace the Y-axis configuration (range / tick density / decimals /
   *  inverse). Passing `undefined` (or all-undefined fields via the
   *  AxisSettingsEditor's Reset button) restores fully automatic
   *  behavior — the renderer's `buildAxisOverrides` emits an empty
   *  fragment when every field is undefined. */
  const setYAxisConfig = useCallback(
    (next: YAxisConfig | undefined) => {
      updateItem(item.id, { yAxis: next });
      markDirty();
    },
    [item.id, updateItem, markDirty],
  );

  /** Replace the X-axis configuration. Mirrors `setYAxisConfig` — the
   *  shape of the override config is identical for both axes. */
  const setXAxisConfig = useCallback(
    (next: YAxisConfig | undefined) => {
      updateItem(item.id, { xAxis: next });
      markDirty();
    },
    [item.id, updateItem, markDirty],
  );

  // 拖放处理
  const onDragStart = (e: React.DragEvent, field: FieldRef) => {
    // Multi-drag: when the dragged item is part of the current
    // selection AND the selection has more than one entry, drag ALL
    // selected fields together as an array. Otherwise this is a
    // single-item drag — clear the visual selection so the user
    // doesn't see stale highlights, and serialize just this one
    // field (still as a 1-length array for receiver simplicity).
    const dragSet =
      selectedColNames.has(field.name) && selectedColNames.size > 1
        ? columns.filter((c) => selectedColNames.has(c.name))
        : [field];
    if (dragSet.length <= 1) {
      // Drag started on an unselected (or only-self-selected) item:
      // reset the multi-select to just this column so the highlight
      // matches the drag.
      setSelectedColNames(new Set([field.name]));
      colAnchorRef.current = field.name;
    }
    const payload = JSON.stringify(dragSet);
    e.dataTransfer.setData(DRAG_MIME, payload);
    // 同时写入 text/plain 作为傅底（部分 WebView 对自定义 MIME 不友好）
    try { e.dataTransfer.setData("text/plain", payload); } catch { /* ignore */ }
    e.dataTransfer.effectAllowed = "copy";
  };

  /** Handle a click on a column-list item. Implements the standard
   *  multi-select gesture set:
   *    - plain click         → select only this item (anchor = this)
   *    - Ctrl / Cmd + click  → toggle this item (anchor = this)
   *    - Shift + click       → range select from anchor to this item
   *  The selection persists across re-renders and only resets when
   *  the user makes a plain click on a different item or starts a
   *  drag on an unselected item. */
  const handleColClick = useCallback(
    (name: string, e: React.MouseEvent) => {
      const isCtrl = e.ctrlKey || e.metaKey;
      const isShift = e.shiftKey && !isCtrl;
      if (isShift && colAnchorRef.current && colAnchorRef.current !== name) {
        const names = columns.map((c) => c.name);
        const a = names.indexOf(colAnchorRef.current);
        const b = names.indexOf(name);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const range = new Set(names.slice(lo, hi + 1));
          setSelectedColNames(range);
          return;
        }
      }
      if (isCtrl) {
        setSelectedColNames((prev) => {
          const next = new Set(prev);
          if (next.has(name)) next.delete(name);
          else next.add(name);
          return next;
        });
        colAnchorRef.current = name;
        return;
      }
      // Plain click: single select.
      setSelectedColNames(new Set([name]));
      colAnchorRef.current = name;
    },
    [columns],
  );

  /** Parse a drag payload that may be a single FieldRef (legacy) or
   *  an array of FieldRef (multi-drag). Always returns an array; empty
   *  array means "could not parse". */
  const parseDragFields = useCallback((raw: string): FieldRef[] => {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((f): f is FieldRef =>
          !!f && typeof (f as FieldRef).name === "string",
        );
      }
      if (parsed && typeof (parsed as FieldRef).name === "string") {
        return [parsed as FieldRef];
      }
    } catch {
      // ignore
    }
    return [];
  }, []);

  /** Bind a field to an encoding slot, atomically clearing the
   *  axis's data-range overrides (min / max / tickInterval) when the
   *  X or Y slot's column actually changes to a different one. See
   *  the long comment in `handleDropOnSlot` for the rationale.
   *  Also clears any multi-mode list on the same slot — a single
   *  field bind always exits multi-mode for that slot. */
  const bindFieldToSlot = useCallback(
    (slot: SlotKey, field: FieldRef) => {
      const prevField = item.encoding[slot];
      const multiKey: "multiX" | "multiY" | null =
        slot === "x" ? "multiX" : slot === "y" ? "multiY" : null;
      const hadMulti = multiKey ? (item[multiKey]?.length ?? 0) > 0 : false;
      const fieldChanged =
        (slot === "x" || slot === "y") &&
        prevField !== undefined &&
        prevField.name !== field.name;
      if (fieldChanged || hadMulti) {
        const axisKey: "xAxis" | "yAxis" | null =
          slot === "x" ? "xAxis" : slot === "y" ? "yAxis" : null;
        const prevAxis = axisKey ? item[axisKey] : undefined;
        const needsAxisReset =
          axisKey !== undefined &&
          prevAxis !== undefined &&
          (prevAxis.min !== undefined ||
            prevAxis.max !== undefined ||
            prevAxis.tickInterval !== undefined);
        const nextAxis = needsAxisReset
          ? { ...prevAxis, min: undefined, max: undefined, tickInterval: undefined }
          : prevAxis;
        updateItem(item.id, {
          encoding: { ...item.encoding, [slot]: field },
          ...(needsAxisReset && axisKey ? { [axisKey]: nextAxis } : {}),
          ...(multiKey ? { [multiKey]: undefined } : {}),
        });
        markDirty();
        return;
      }
      setEncoding((prev) => ({ ...prev, [slot]: field }));
    },
    [item.id, item.encoding, item.xAxis, item.yAxis, item.multiX, item.multiY, updateItem, markDirty, setEncoding],
  );

  /** Replace a slot's multi-mode list. Length 0 / undefined exits
   *  multi-mode (also clears `encoding[slot]`). Length 1 is
   *  auto-collapsed back to single-field encoding on `encoding[slot]`
   *  so multi-mode never holds exactly one column. Length 2+
   *  enters / stays in multi-mode and clears `encoding[slot]`.
   *  Atomic via a single `updateItem` so the rendered state stays
   *  consistent during transitions. At most one axis can be in
   *  multi-mode at a time — entering multi-mode on one axis also
   *  clears the other axis's multi list (the other-axis multi state
   *  would otherwise produce an ambiguous render). */
  const setMultiAtSlot = useCallback(
    (slot: "x" | "y", next: FieldRef[] | undefined) => {
      const multiKey: "multiX" | "multiY" = slot === "x" ? "multiX" : "multiY";
      const otherMultiKey: "multiX" | "multiY" = slot === "x" ? "multiY" : "multiX";
      const axisKey: "xAxis" | "yAxis" = slot === "x" ? "xAxis" : "yAxis";
      const list = (next ?? []).filter((f, i, arr) =>
        arr.findIndex((g) => g.name === f.name) === i,
      );
      const prevAxis = item[axisKey];
      const needsAxisReset =
        prevAxis !== undefined &&
        (prevAxis.min !== undefined ||
          prevAxis.max !== undefined ||
          prevAxis.tickInterval !== undefined);
      const axisPatch =
        needsAxisReset
          ? { [axisKey]: { ...prevAxis, min: undefined, max: undefined, tickInterval: undefined } }
          : {};
      if (list.length === 0) {
        updateItem(item.id, { [multiKey]: undefined, ...axisPatch });
        markDirty();
        return;
      }
      if (list.length === 1) {
        const only = list[0];
        updateItem(item.id, {
          [multiKey]: undefined,
          encoding: { ...item.encoding, [slot]: only },
          ...axisPatch,
        });
        markDirty();
        return;
      }
      // ≥2 columns: stay in multi-mode. Clear `encoding[slot]` so the
      // single-field chip doesn't shadow the multi list. Also clear
      // any multi on the OTHER axis — only one axis can be in
      // multi-mode at a time.
      const nextEncoding = { ...item.encoding };
      delete nextEncoding[slot];
      updateItem(item.id, {
        [multiKey]: list,
        [otherMultiKey]: undefined,
        encoding: nextEncoding,
        ...axisPatch,
      });
      markDirty();
    },
    [item.id, item.encoding, item.xAxis, item.yAxis, updateItem, markDirty],
  );

  /** Are all the given fields numeric (continuous)? Multi-mode is
   *  restricted to numeric columns because the "names → axis, values
   *  → other axis" semantics only makes sense for comparable scales. */
  const allNumeric = useCallback((fields: FieldRef[]): boolean => {
    if (fields.length === 0) return false;
    return fields.every((f) => f.type === "continuous");
  }, []);

  const handleDropOnSlot = (slot: SlotKey, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const raw =
      e.dataTransfer.getData(DRAG_MIME) ||
      e.dataTransfer.getData("text/plain");
    if (!raw) return;
    const fields = parseDragFields(raw);
    if (fields.length === 0) return;
    // When the user swaps the column on a value-axis slot (x or y)
    // to a DIFFERENT column, drop the data-range-dependent axis
    // overrides (min / max / tickInterval) on that axis. The new
    // column will almost always span a different numeric range —
    // e.g. swapping a column scaled in centigrade (4.3 - 4.6) for
    // one in Pa (1e4 - 1e6) — and keeping the old pinned bounds
    // would silently crop every point off-screen. Other axis
    // overrides (decimals, inverse, minor-tick count, gridlines,
    // axis-line visibility, tick position) are display preferences
    // independent of data scale and stay untouched, so the user's
    // axis-line / gridline preferences survive a column swap.
    routeDropToSlot(slot, fields);
  };

  /** Centralized drop-router for one slot. Single field → existing
   *  single-bind logic (replace). Multi-field on x/y → multi-mode
   *  (axis or merge, derived at render time). Multi-field on any
   *  other slot → first field only (multi-mode is X/Y-only).
   *  Drop while already in multi-mode on x/y → APPEND.
   *  Any drop that would mix numeric + non-numeric columns in multi
   *  is rejected with a brief visual flash; the existing multi list
   *  stays untouched. */
  const routeDropToSlot = useCallback(
    (slot: SlotKey, fields: FieldRef[]) => {
      if (fields.length === 0) return;
      const isAxis = slot === "x" || slot === "y";
      const multiKey: "multiX" | "multiY" | null =
        slot === "x" ? "multiX" : slot === "y" ? "multiY" : null;
      const existingMulti = multiKey ? item[multiKey] : undefined;
      const inMulti = !!existingMulti && existingMulti.length >= 2;

      // Already in multi-mode → all drops APPEND (single or multi).
      if (isAxis && inMulti && multiKey) {
        if (!allNumeric(fields)) {
          flashRejectOnSlot(slot);
          return;
        }
        const merged = [...(existingMulti ?? []), ...fields];
        setMultiAtSlot(slot, merged);
        return;
      }

      // Single field drop, NOT in multi-mode → existing replace logic.
      if (fields.length === 1) {
        bindFieldToSlot(slot, fields[0]);
        return;
      }

      // Multi-field drop on a non-axis slot: take the first field
      // (Color / Overlay / Group X / Group Y / Wrap / Size are single-
      // value channels — multi-binding wouldn't make sense there).
      if (!isAxis) {
        bindFieldToSlot(slot, fields[0]);
        return;
      }

      // Multi-field drop on x/y, NOT in multi-mode yet.
      if (!allNumeric(fields)) {
        flashRejectOnSlot(slot);
        return;
      }
      // Enter multi-mode with the dropped fields.
      setMultiAtSlot(slot, fields);
    },
    [item.multiX, item.multiY, bindFieldToSlot, setMultiAtSlot, allNumeric, flashRejectOnSlot],
  );

  const clearSlot = (slot: SlotKey) => {
    // Atomic: clear both single encoding AND any multi list on the
    // same slot so the slot returns to fully empty.
    const multiKey: "multiX" | "multiY" | null =
      slot === "x" ? "multiX" : slot === "y" ? "multiY" : null;
    const nextEncoding = { ...item.encoding };
    delete nextEncoding[slot];
    updateItem(item.id, {
      encoding: nextEncoding,
      ...(multiKey ? { [multiKey]: undefined } : {}),
    });
    markDirty();
  };

  /** Add a new layer (chart kind) — enables it if already present.
   *  New smoother layers default to the Spline algorithm; new fitline
   *  layers default to a linear (degree-1) Polynomial fit. Legacy
   *  smoother elements saved without an `algo` keep their previous
   *  Moving Average behaviour via the fallbacks in transform.ts. */
  const addElement = useCallback((kind: ElementKind) => {
    setElements((prev) => {
      const idx = prev.findIndex((e) => e.kind === kind);
      if (idx >= 0) {
        return prev.map((e, i) => (i === idx ? { ...e, enabled: true } : e));
      }
      const next: ChartElement = { kind, enabled: true };
      if (kind === "smoother") next.options = { algo: "spline" };
      if (kind === "fitline") {
        next.options = { fitType: "polynomial", degree: 1 };
      }
      return [...prev, next];
    });
  }, [setElements]);

  /** Remove a layer entirely from the elements list. */
  const removeElement = useCallback((kind: ElementKind) => {
    setElements((prev) => prev.filter((e) => e.kind !== kind));
  }, [setElements]);

  /** Patch an element's `options` map (per-kind settings). */
  const updateElementOptions = useCallback(
    (kind: ElementKind, patch: Record<string, unknown>) => {
      setElements((prev) =>
        prev.map((e) =>
          e.kind === kind
            ? { ...e, options: { ...(e.options ?? {}), ...patch } }
            : e,
        ),
      );
    },
    [setElements],
  );

  /** Wipe everything that defines the *content* of the current chart
   *  back to its pristine drop-zone state — encoding (axes + facets +
   *  color / overlay / size), elements, X / Y axis overrides, every
   *  reference-line list (manual + auto-spec toggles), legend group
   *  visibility, and per-group style overrides. Done as a single
   *  atomic `updateItem` so the history snapshot stays clean and the
   *  next render sees a fully consistent blank slate (a partial reset
   *  could leave e.g. a Y-axis range pin tied to a column the user
   *  just cleared, which would trigger a guard the next time they
   *  drop a new column on Y). Filters and smoother lambda are
   *  intentionally preserved — those are session-level analysis
   *  controls, not part of the chart's visual content. */
  const startOver = useCallback(() => {
    updateItem(item.id, {
      encoding: {},
      elements: [{ kind: "points", enabled: true }],
      xAxis: undefined,
      yAxis: undefined,
      refLinesX: undefined,
      refLinesY: undefined,
      autoSpecLinesY: undefined,
      autoSpecLinesX: undefined,
      autoSpecLines: undefined,
      hiddenGroups: undefined,
      groupStyles: undefined,
      multiX: undefined,
      multiY: undefined,
    });
    markDirty();
  }, [item.id, updateItem, markDirty]);

  /** Swap X and Y completely — encoding (axis + facet) plus axis
   *  settings and reference lines. The chart should read as if it had
   *  been rotated 90°.
   *
   *  Swapped:
   *    - encoding.x ↔ encoding.y          (axis content)
   *    - encoding.groupX ↔ encoding.groupY (facet rails)
   *    - xAxis ↔ yAxis                     (range / ticks / inverse / gridlines)
   *    - refLinesX ↔ refLinesY            (with `{x}` ↔ `{y}` field rename)
   *
   *  Intentionally NOT swapped:
   *    - color / size / overlay / wrap / elements / styles / hiddenGroups /
   *      filters / smootherLambda — these are orientation-agnostic.
   *    - autoSpecLinesY / autoSpecLinesX swap with each other (mirror
   *      of refLinesY / refLinesX) so the rotated chart shows the same
   *      spec overlay on the same column as before the swap.
   *
   *  Done as a single atomic `updateItem` so the encoding, axis configs,
   *  and ref lines re-render in lockstep — partial swaps would briefly
   *  mismatch and could trigger an inverse / range guard from the wrong
   *  axis. */
  const swapXY = useCallback(() => {
    const enc = item.encoding;
    const nextEncoding = { ...enc };
    // x ↔ y
    if (enc.x !== undefined) nextEncoding.y = enc.x;
    else delete nextEncoding.y;
    if (enc.y !== undefined) nextEncoding.x = enc.y;
    else delete nextEncoding.x;
    // groupX ↔ groupY
    if (enc.groupX !== undefined) nextEncoding.groupY = enc.groupX;
    else delete nextEncoding.groupY;
    if (enc.groupY !== undefined) nextEncoding.groupX = enc.groupY;
    else delete nextEncoding.groupX;
    // refLinesY ↔ refLinesX, with the field-name flip. Keep the same id
    // on each line so React's list-key stays stable across the swap and
    // any in-flight edit focus doesn't churn.
    const nextRefLinesX: RefLineX[] | undefined = item.refLinesY?.map((r) => ({
      id: r.id,
      x: r.y,
      label: r.label,
      style: r.style,
      color: r.color,
      width: r.width,
    }));
    const nextRefLinesY: RefLineY[] | undefined = item.refLinesX?.map((r) => ({
      id: r.id,
      y: r.x,
      label: r.label,
      style: r.style,
      color: r.color,
      width: r.width,
    }));
    updateItem(item.id, {
      encoding: nextEncoding,
      xAxis: item.yAxis,
      yAxis: item.xAxis,
      refLinesX: nextRefLinesX,
      refLinesY: nextRefLinesY,
      // Swap per-axis auto-spec flags too. We resolve the legacy
      // `autoSpecLines` fallback at the read site so the swap stores
      // explicit values — from this point on the per-axis fields are
      // canonical (legacy field becomes shadowed).
      autoSpecLinesY: item.autoSpecLinesX ?? item.autoSpecLines,
      autoSpecLinesX: item.autoSpecLinesY ?? item.autoSpecLines,
      // multiX ↔ multiY — mirror the encoding swap so a multi-mode
      // axis stays in multi-mode on the other side after rotation.
      multiX: item.multiY,
      multiY: item.multiX,
    });
    markDirty();
  }, [item.id, item.encoding, item.xAxis, item.yAxis, item.refLinesX, item.refLinesY, item.autoSpecLines, item.autoSpecLinesY, item.autoSpecLinesX, item.multiX, item.multiY, updateItem, markDirty]);

  const activeKinds = new Set(
    finalElements.filter((e) => e.enabled !== false).map((e) => e.kind),
  );

  return (
    <div className="gb-root">
      {/* 顶部工具条 */}
      <div className="gb-toolbar">
        <div className="gb-toolbar-left">
          <button className="gb-tb-btn" onClick={startOver}>{t("graph.startOver")}</button>
          <button
            className="gb-tb-btn"
            onClick={swapXY}
            title={t("graph.swapXY.tooltip", {
              defaultValue: "Swap the X and Y axes (encoding, facet rail, and axis settings) — like rotating the chart 90°.",
            })}
          >
            {t("graph.swapXY.label", { defaultValue: "Swap X & Y" })}
          </button>
          <button
            className={`gb-tb-btn${showFilters ? " gb-tb-btn-active" : ""}`}
            onClick={() => setShowFilters((v) => !v)}
            title={t("graph.filter.toggleTitle", { defaultValue: "Show/Hide local data filter" })}
          >
            {t("graph.filter.toolbarBtn", { defaultValue: "Filter" })}
            {filters.length > 0 && (
              <span className="gb-tb-badge">{filters.length}</span>
            )}
          </button>
        </div>
        <div className="gb-toolbar-spacer" />
      </div>

      <div className="gb-body">
        {/* Local Data Filter panel + splitter (leftmost, when toggled on). */}
        {showFilters && (
          <>
            <FilterPanel
              data={data}
              columns={columns}
              filters={filters}
              onChange={setFilters}
              onClose={() => setShowFilters(false)}
              width={filterWidth}
            />
            <div
              className="gb-splitter"
              onMouseDown={startSideResize("filter")}
              onDoubleClick={() => setFilterWidth(240)}
              title={t("graph.resizePanel", { defaultValue: "Drag to resize" })}
            />
          </>
        )}

        {/* 左栏 */}
        <div className="gb-left" style={{ width: leftWidth }} ref={leftRailRef}>
          {/* Reuse the same column-panel styling as the data table view so the
              two left rails look and feel identical. Items remain draggable so
              they can be dropped into encoding slots. */}
          <div
            className="sp-cols-panel gb-cols-panel"
            style={{ flex: `0 0 ${leftTopPct}%` }}
          >
            <div className="sp-panel-header">
              <span className="sp-panel-header-title">
                {t("graph.datasetHeader", { name: dataset.name, n: columns.length })}
              </span>
            </div>
            <div className="sp-cols-panel-list">
              {columns.map((c, i) => {
                const sqlType = colSqlTypes[i] ?? "";
                const tLabel = t(`dataTable.type.${sqlType}`, { defaultValue: sqlType });
                const selected = selectedColNames.has(c.name);
                return (
                  <div
                    key={c.name}
                    className={`sp-cols-panel-item${selected ? " sp-cols-panel-item-selected" : ""}`}
                    draggable
                    onClick={(e) => handleColClick(c.name, e)}
                    onDragStart={(e) => onDragStart(e, c)}
                    title={`${c.name} (${tLabel})`}
                  >
                    <span className="sp-cols-panel-item-type">{tLabel}</span>
                    <span className="sp-cols-panel-item-name">{c.name}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Horizontal splitter between TABLE columns and LAYERS */}
          <div
            className="gb-splitter-h"
            onMouseDown={startLeftRowResize}
            onDoubleClick={() => setLeftTopPct(50)}
            title={t("graph.resizePanel", { defaultValue: "Drag to resize" })}
          />

          {/* Layer cards: one per active chart kind, plus an add-card popover.
              Replaces the old per-chart-type sections and the top-toolbar
              chart-type toggle buttons. */}
          <div
            className="gb-layers"
            style={{ flex: `0 0 ${100 - leftTopPct}%` }}
          >
            <div className="sp-panel-header">
              <span className="sp-panel-header-title">{t("graph.layersSection")}</span>
            </div>
            <div className="gb-layers-list-wrap">
              <div className="gb-layer-list">
                {elements
                  .filter((el) => el.enabled !== false)
                  .map((el) => (
                    <LayerCard
                      key={el.kind}
                      kind={el.kind}
                      label={t(`graph.type.${el.kind}`)}
                      options={el.options ?? {}}
                      onChangeOptions={(patch) => updateElementOptions(el.kind, patch)}
                      onRemove={() => removeElement(el.kind)}
                      t={t}
                    />
                  ))}
                <AddLayerCard
                  availableKinds={CHART_TYPE_DEFS.map((c) => c.kind).filter(
                    (k) => !activeKinds.has(k),
                  )}
                  onAdd={addElement}
                  t={t}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Splitter: left | center */}
        <div
          className="gb-splitter"
          onMouseDown={startSideResize("left")}
          onDoubleClick={() => setLeftWidth(220)}
          title={t("graph.resizePanel", { defaultValue: "Drag to resize" })}
        />

        {/* 中栏：画布 + X 轴槽 */}
        <div className="gb-center">
          {/* 顶部分组槽 (Group X) — 横跨画布上方 */}
          <Slot
            slot="groupX"
            label="Group X"
            field={encoding.groupX}
            onDrop={(e) => handleDropOnSlot("groupX", e)}
            onClear={() => clearSlot("groupX")}
            onContextMenu={(x, y) => setSlotCtxMenu({ slot: "groupX", x, y })}
            orientation="horizontal-top"
          />

          {/* 画布 + 左侧 Y 轴槽 + 右侧 Group Y 槽 */}
          <div className="gb-canvas-row">
            <Slot
              slot="y"
              label="Y"
              field={encoding.y}
              fields={item.multiY}
              onDrop={(e) => handleDropOnSlot("y", e)}
              onClear={() => clearSlot("y")}
              onOpenManager={() => setManagerOpenSlot("y")}
              onContextMenu={(x, y) => setSlotCtxMenu({ slot: "y", x, y })}
              orientation="vertical-left"
              required
              rejectFlash={rejectFlashSlot === "y"}
            />
            <div
              className="gb-canvas"
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDrop={(e) => {
                e.preventDefault();
                const raw =
                  e.dataTransfer.getData(DRAG_MIME) ||
                  e.dataTransfer.getData("text/plain");
                if (!raw) return;
                const fields = parseDragFields(raw);
                if (fields.length === 0) return;
                // Canvas-drop is the "didn't aim at a slot" fallback:
                // fill X first, then Y, otherwise replace Y. We treat
                // a multi-mode list on a slot the same as a bound
                // single field for "is this slot occupied?" purposes
                // — once X has any binding (single OR multi), the
                // next canvas-drop falls through to Y. Route through
                // `routeDropToSlot` so the single/multi/append cases
                // get the same handling as a direct slot drop.
                const xBound = !!encoding.x || (item.multiX?.length ?? 0) > 0;
                const yBound = !!encoding.y || (item.multiY?.length ?? 0) > 0;
                const slot: SlotKey = !xBound
                  ? "x"
                  : !yBound
                    ? "y"
                    : "y";
                routeDropToSlot(slot, fields);
              }}
            >
              {loading ? (
                <div className="gb-empty">{t("graph.loading")}</div>
              ) : error ? (
                <div className="gb-empty gb-error">{error}</div>
              ) : !data ? (
                <div className="gb-empty">{t("graph.noData")}</div>
              ) : !encoding.x && !encoding.y && !(item.multiX?.length) && !(item.multiY?.length) && !activeKinds.has("histogram") ? (
                // Drag-hint shows only when neither axis is bound (and
                // there's no histogram). Y-only renders a vertical strip
                // and X-only renders a horizontal strip (mirror), so the
                // moment either axis is bound we drop straight into the
                // chart builder and let the renderer's horizontal-mode
                // swap handle the X-only case (see `isHorizontal` /
                // `xOnlyMirror` in transform.ts). Multi-mode also counts
                // as "bound" — both axes are populated by the synthetic
                // melt fields at render time.
                <div className="gb-empty">{t("graph.dragHint")}</div>
              ) : (
                // `effectiveData` is null iff `data` is null; the `!data`
                // branch above already handled that, so the fallback to
                // `data` is unreachable and just satisfies the type
                // checker. `effectiveData` carries the melted view in
                // multi-mode and equals `filteredData` otherwise.
                <Graph
                  spec={spec}
                  data={effectiveData ?? data}
                  valueOrders={valueOrders}
                  onYAxisDblClick={() => setYAxisDialogOpen(true)}
                  onXAxisDblClick={() => setXAxisDialogOpen(true)}
                  onAxisRangeChange={(axis, min, max) => {
                    // JMP-style direct-manipulation drag-zoom / drag-pan
                    // on the axis strip. The renderer previews via
                    // setOption during the gesture; on mouseup it hands
                    // back the final numeric bounds, which we pin onto
                    // the per-builder yAxis / xAxis config. Other
                    // overrides (decimals / inverse / grid styling) are
                    // preserved by spreading the existing config first.
                    if (axis === "y") {
                      setYAxisConfig({ ...(item.yAxis ?? {}), min, max });
                    } else {
                      setXAxisConfig({ ...(item.xAxis ?? {}), min, max });
                    }
                  }}
                  onPointClick={(pick) => {
                    // Bridge to DataTableView: stash the source row + col
                    // on the per-dataset selection slot. The matching
                    // table view subscribes and surfaces the cell the
                    // next time it mounts (or immediately if it's
                    // already mounted). See useTableSelectionStore for
                    // why we re-emit through the store rather than
                    // coupling the two views directly.
                    pickCell(dataset.id, { rowId: pick.rowId, colName: pick.colName });
                  }}
                />
              )}
            </div>
            <Slot
              slot="groupY"
              label="Group Y"
              field={encoding.groupY}
              onDrop={(e) => handleDropOnSlot("groupY", e)}
              onClear={() => clearSlot("groupY")}
              onContextMenu={(x, y) => setSlotCtxMenu({ slot: "groupY", x, y })}
              orientation="vertical-right"
            />
          </div>

          {/* X 轴槽 */}
          <Slot
            slot="x"
            label="X"
            field={encoding.x}
            fields={item.multiX}
            onDrop={(e) => handleDropOnSlot("x", e)}
            onClear={() => clearSlot("x")}
            onOpenManager={() => setManagerOpenSlot("x")}
            onContextMenu={(x, y) => setSlotCtxMenu({ slot: "x", x, y })}
            orientation="horizontal-bottom"
            required
            rejectFlash={rejectFlashSlot === "x"}
          />
        </div>

        {/* Splitter: center | right */}
        <div
          className="gb-splitter"
          onMouseDown={startSideResize("right")}
          onDoubleClick={() => setRightWidth(220)}
          title={t("graph.resizePanel", { defaultValue: "Drag to resize" })}
        />

        {/* Legend + Style editor:
            - 顶部 Overlay 槽：拖入分类列即按其值生成图例分组；
            - 中间图例列表：每行对应一个分组（无 Overlay 时显示 "All"）；
            - 底部样式编辑器：针对当前选中的图例条目，分别设置线/填充/点。
            无论上方激活的是散点还是箱线图，三类样式都会对应应用。 */}
        <LegendStylePanel
          data={data}
          encoding={encoding}
          elements={elements}
          groupStyles={item.groupStyles ?? {}}
          groupKeys={groupKeys}
          effectiveStyles={effectiveStyles}
          hiddenGroups={item.hiddenGroups ?? []}
          toggleGroupHidden={toggleGroupHidden}
          setGroupStyle={setGroupStyle}
          resetAllGroupStyles={resetAllGroupStyles}
          onDropOverlay={(e) => handleDropOnSlot("overlay", e)}
          onClearOverlay={() => clearSlot("overlay")}
          width={rightWidth}
        />
      </div>

      {/* Y-axis settings dialog. Opened by double-clicking the Y axis;
          modeled after the system Preferences dialog (left categories
          column + right detail pane) so adding future per-axis settings
          (log scale, tick formatter, ...) is a one-line nav-item
          addition. Today it has three categories: Axis (range / ticks /
          decimals / inverse), Tick Grid (major + minor gridlines),
          and Reference Lines. */}
      {yAxisDialogOpen && (
        <AxisSettingsDialog
          axis="y"
          refLines={item.refLinesY ?? []}
          setRefLines={setRefLinesY}
          autoSpecLines={!!(item.autoSpecLinesY ?? item.autoSpecLines)}
          setAutoSpecLines={setAutoSpecLinesY}
          resolvedAutoSpec={spec.autoSpecY}
          autoSpecColName={encoding.y?.name}
          multiValueColCount={
            meltInfo &&
            ((meltInfo.mode === "axis" && meltInfo.slot === "x") ||
              (meltInfo.mode === "merge" && meltInfo.slot === "y"))
              ? meltInfo.cols.length
              : 0
          }
          axisConfig={item.yAxis}
          setAxisConfig={setYAxisConfig}
          onClose={() => setYAxisDialogOpen(false)}
        />
      )}
      {/* X-axis settings dialog. Opened by double-clicking the X axis.
          Mirrors the Y dialog — including the Reference Lines category
          AND its OWN independent auto spec-limit overlay sourced from
          the X column's `extras.spec` metadata. X and Y are fully
          symmetric: each axis has its own `autoSpecLinesX` /
          `autoSpecLinesY` flag, so a chart with spec extras on both
          columns can show / hide each overlay independently. The
          renderer silently skips X ref lines when the X axis is
          categorical (no meaningful position), so the editor stays
          available throughout. */}
      {xAxisDialogOpen && (
        <AxisSettingsDialog
          axis="x"
          refLines={item.refLinesX ?? []}
          setRefLines={setRefLinesX}
          autoSpecLines={!!(item.autoSpecLinesX ?? item.autoSpecLines)}
          setAutoSpecLines={setAutoSpecLinesX}
          resolvedAutoSpec={spec.autoSpecX}
          autoSpecColName={encoding.x?.name}
          multiValueColCount={
            meltInfo &&
            ((meltInfo.mode === "axis" && meltInfo.slot === "y") ||
              (meltInfo.mode === "merge" && meltInfo.slot === "x"))
              ? meltInfo.cols.length
              : 0
          }
          axisConfig={item.xAxis}
          setAxisConfig={setXAxisConfig}
          onClose={() => setXAxisDialogOpen(false)}
        />
      )}
      {/* Multi-column manager popover. Opened by clicking the slot
          body when an axis is in multi-mode (2+ columns). Lets the
          user reorder and delete columns. If the list drops to <=1
          via deletes, multi-mode is auto-exited by `setMultiAtSlot`
          (length-1 collapses to single-field encoding, length-0
          clears the slot entirely). */}
      {managerOpenSlot && (managerOpenSlot === "x" || managerOpenSlot === "y") &&
       ((managerOpenSlot === "x" ? item.multiX : item.multiY)?.length ?? 0) >= 2 && (
        <MultiColManager
          slot={managerOpenSlot}
          cols={(managerOpenSlot === "x" ? item.multiX : item.multiY) ?? []}
          datasetColumns={columns}
          onChange={(next) => setMultiAtSlot(managerOpenSlot, next)}
          onClose={() => setManagerOpenSlot(null)}
        />
      )}

      {/* Right-click context menu on slots. Currently a single
          "Clear" action — kept as a menu (not just a click) so the
          gesture is consistent across slot types and leaves room for
          future per-slot actions without restructuring. `clearSlot`
          handles both single-field and multi-mode atomically. */}
      {slotCtxMenu && (
        <div
          ref={ctxMenuRef}
          className="sp-ctx-menu"
          style={{ left: slotCtxMenu.x, top: slotCtxMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div
            className="sp-ctx-item sp-ctx-danger"
            onClick={() => {
              clearSlot(slotCtxMenu.slot);
              setSlotCtxMenu(null);
            }}
          >
            {t("graph.slotCtx.clear", { defaultValue: "Clear slot" })}
          </div>
        </div>
      )}
    </div>
  );
}

interface SlotProps {
  slot: SlotKey;
  label: string;
  field?: FieldRef;
  /** Multi-mode columns. When present and length >= 2 the slot
   *  renders as a multi-chip slot whose body click opens the manager
   *  popover instead of showing a single-field chip. */
  fields?: FieldRef[];
  onDrop: (e: React.DragEvent) => void;
  onClear: () => void;
  /** Called when the slot body is clicked in multi-mode — opens the
   *  manager popover. Required when `fields` has length >= 2. */
  onOpenManager?: () => void;
  /** Right-click hook — fires only when the slot has content (single
   *  OR multi). Receives viewport coordinates so the parent can pin
   *  the context menu at the cursor. Empty slots silently ignore
   *  right-clicks (no menu to show), letting the native browser menu
   *  through would just confuse the user when there's nothing to
   *  act on. */
  onContextMenu?: (x: number, y: number) => void;
  orientation: "horizontal-top" | "horizontal-bottom" | "vertical-left" | "vertical-right" | "shelf";
  required?: boolean;
  /** When true, briefly flashes the slot red to signal a rejected
   *  multi-drop (e.g. non-numeric mixed in). Reset by the parent
   *  after ~400 ms. */
  rejectFlash?: boolean;
}

function Slot({ label, field, fields, onDrop, onClear, onOpenManager, onContextMenu, orientation, required, rejectFlash }: SlotProps) {
  const { t } = useTranslation();
  const [over, setOver] = useState(false);
  // Multi-mode triggers when the parent passes 2+ fields. Length-1
  // is auto-collapsed back to single mode on the write side, so we
  // never need to handle that case here. */
  const isMulti = !!fields && fields.length >= 2;
  const filled = isMulti || !!field;
  return (
    <div
      className={`gb-slot gb-slot-${orientation}${over ? " gb-slot-over" : ""}${filled ? " gb-slot-filled" : ""}${isMulti ? " gb-slot-multi" : ""}${rejectFlash ? " gb-slot-reject" : ""}`}
      onDragEnter={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        onDrop(e);
      }}
      onClick={isMulti ? () => onOpenManager?.() : undefined}
      onContextMenu={(e) => {
        // Only intercept right-clicks on filled slots — empty slots
        // have nothing to act on so let the browser do its thing
        // (or let the parent's right-click handler bubble up). When
        // filled, suppress the native menu and hand the cursor
        // position to the parent so it can render a styled menu.
        if (!filled || !onContextMenu) return;
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e.clientX, e.clientY);
      }}
      title={isMulti ? t("graph.multiSlot.openManager", { defaultValue: "Click to manage columns" }) : undefined}
    >
      {!filled && (
        <span className="gb-slot-label">{label}{required ? " *" : ""}</span>
      )}
      {isMulti && (
        // Compact summary chip — shows the count and a preview of
        // the first column name. Full management happens in the
        // popover opened via onOpenManager.
        <span className="gb-slot-chip gb-slot-chip-multi">
          <span className="gb-slot-chip-name">
            {t("graph.multiSlot.summary", {
              defaultValue: "{{n}} cols: {{first}}",
              n: fields!.length,
              first: fields![0].name,
            })}
          </span>
        </span>
      )}
      {!isMulti && field && (
        <span className="gb-slot-chip">
          <span className="gb-slot-chip-name">{field.name}</span>
          <button
            className="gb-slot-chip-x"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            title={t("graph.removeSlot")}
          >
            ×
          </button>
        </span>
      )}
    </div>
  );
}

// ---- Multi-column manager popover ---------------------------------------
//
// Modal-style overlay opened by clicking a slot that's in multi-mode
// (2+ columns). Supports:
//   - Per-row selection (plain click toggles; Ctrl+click toggles
//     individually; Shift+click range-selects from the last anchor).
//   - Bulk toolbar at the top: Move selection up / down (preserves
//     relative order, sails the selected block past unselected rows),
//     Delete selection, Reset to dataset order. All disabled when no
//     selection exists (except Reset which is always meaningful).
//   - All edits write through onChange → setMultiAtSlot on the parent,
//     which auto-collapses length-1 back to single-field encoding and
//     clears the slot entirely on length-0. The manager never has to
//     worry about those edge cases.
// Backdrop click and Esc both close.

interface MultiColManagerProps {
  slot: "x" | "y";
  cols: FieldRef[];
  /** Full ordered list of columns in the dataset — used as the
   *  authoritative "default order" for the Reset button. The manager
   *  ranks each multi-col by its index here and sorts ascending.
   *  Columns missing from this list (defensive — shouldn't happen)
   *  fall to the end in stable order. */
  datasetColumns: FieldRef[];
  onChange: (next: FieldRef[]) => void;
  onClose: () => void;
}

function MultiColManager({ slot, cols, datasetColumns, onChange, onClose }: MultiColManagerProps) {
  const { t } = useTranslation();
  // Selection by column NAME (stable across reorders). Stored as a Set
  // for O(1) membership checks during the move/delete operations and
  // the per-row className branch.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // Anchor for shift+click range selection — points at the column name
  // of the last *plain*-clicked row. Null until the first click.
  const anchorRef = useRef<string | null>(null);

  // Auto-prune selection when columns disappear from `cols` (e.g.
  // after a delete the parent re-renders us with the trimmed list).
  // Without this the selection would carry stale names forward and
  // confuse the toolbar (e.g. "Delete (3)" when only 2 are present).
  useEffect(() => {
    const live = new Set(cols.map((c) => c.name));
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((n) => {
        if (live.has(n)) next.add(n);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [cols]);

  // Close on Esc — matches the AxisSettingsDialog interaction.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ---- Row click: plain / Ctrl / Shift selection model -----------------
  const handleRowClick = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const names = cols.map((c) => c.name);
    if (e.shiftKey && anchorRef.current && names.includes(anchorRef.current)) {
      // Range select from anchor to clicked, inclusive. Replaces the
      // current selection so the result is exactly the range — matches
      // the Windows file-explorer feel.
      const a = names.indexOf(anchorRef.current);
      const b = names.indexOf(name);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const range = new Set(names.slice(lo, hi + 1));
      setSelected(range);
      // anchor stays the same — sequential shift+clicks pivot around it.
    } else if (e.ctrlKey || e.metaKey) {
      // Toggle individual row in / out of the selection. New anchor =
      // this row so subsequent shift+clicks pivot here.
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
      anchorRef.current = name;
    } else {
      // Plain click: select only this row. Re-clicking the only
      // selected row keeps it selected (clearer than a toggle for
      // bulk-action UX).
      setSelected(new Set([name]));
      anchorRef.current = name;
    }
  };

  const selectAll = () => {
    setSelected(new Set(cols.map((c) => c.name)));
  };
  const clearSelection = () => {
    setSelected(new Set());
    anchorRef.current = null;
  };
  const selCount = selected.size;
  const allSelected = selCount > 0 && selCount === cols.length;

  // ---- Bulk move up / down --------------------------------------------
  // Strategy: pass once over the array; for move-up walk top-down and
  // swap any selected row with the unselected row above it. The block
  // semantics fall out naturally — a selected run "bubbles" upward past
  // unselected rows but stays internally ordered.
  const moveUp = () => {
    if (selCount === 0) return;
    const next = cols.slice();
    for (let i = 1; i < next.length; i++) {
      if (selected.has(next[i].name) && !selected.has(next[i - 1].name)) {
        [next[i - 1], next[i]] = [next[i], next[i - 1]];
      }
    }
    onChange(next);
  };
  const moveDown = () => {
    if (selCount === 0) return;
    const next = cols.slice();
    for (let i = next.length - 2; i >= 0; i--) {
      if (selected.has(next[i].name) && !selected.has(next[i + 1].name)) {
        [next[i], next[i + 1]] = [next[i + 1], next[i]];
      }
    }
    onChange(next);
  };

  // ---- Bulk delete -----------------------------------------------------
  // Drops every selected row in one go. The parent (setMultiAtSlot)
  // handles the length-1 collapse and length-0 clear, so dropping the
  // selection below 2 auto-exits multi-mode without any check here.
  const deleteSelected = () => {
    if (selCount === 0) return;
    const next = cols.filter((c) => !selected.has(c.name));
    onChange(next);
  };

  // ---- Reset to default order -----------------------------------------
  // "Default" = the column order in the dataset (matches the order the
  // user sees in the left-rail column list). Cols missing from the
  // dataset list (defensive) sort to the end while preserving their
  // current relative order.
  const resetOrder = () => {
    const orderByName = new Map<string, number>();
    datasetColumns.forEach((c, i) => orderByName.set(c.name, i));
    const fallback = datasetColumns.length;
    const next = cols
      .map((c, i) => ({ c, rank: orderByName.get(c.name) ?? fallback, i }))
      .sort((a, b) => (a.rank - b.rank) || (a.i - b.i))
      .map((x) => x.c);
    // Skip the update if it would be a no-op (avoids dirtying the
    // project when the order is already canonical).
    let same = true;
    for (let i = 0; i < next.length; i++) {
      if (next[i].name !== cols[i].name) { same = false; break; }
    }
    if (!same) onChange(next);
  };

  // Disable conditions for the move buttons: precisely when no move
  // would change the array. That is: every selected row's neighbor on
  // that side is also selected (the selected block is already pinned).
  // The contiguous-block-at-top case (e.g. selection = first 2 rows)
  // and the interleaved case (e.g. selection = rows 0 and 2) are both
  // handled — for interleaved selections moving up still re-arranges
  // the unpinned rows, so the button stays enabled.
  const upDisabled = selCount === 0 || !cols.some(
    (c, i) => i > 0 && selected.has(c.name) && !selected.has(cols[i - 1].name),
  );
  const downDisabled = selCount === 0 || !cols.some(
    (c, i) => i < cols.length - 1 && selected.has(c.name) && !selected.has(cols[i + 1].name),
  );

  return (
    <div
      className="gb-multi-mgr-backdrop"
      onClick={onClose}
      onMouseDown={(e) => {
        // Prevent backdrop mousedown from selecting underlying text.
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <div className="gb-multi-mgr" onClick={(e) => e.stopPropagation()}>
        <div className="gb-multi-mgr-head">
          <span>
            {t("graph.multiSlot.title", {
              defaultValue: "{{axis}} axis columns ({{n}})",
              axis: slot.toUpperCase(),
              n: cols.length,
            })}
          </span>
          <button
            className="gb-slot-chip-x"
            onClick={onClose}
            title={t("graph.multiSlot.close", { defaultValue: "Close" })}
          >
            ×
          </button>
        </div>
        <div className="gb-multi-mgr-hint">
          {t("graph.multiSlot.hint", {
            defaultValue:
              "Click to select. Ctrl+click toggles; Shift+click range. Drop new columns onto the slot to add.",
          })}
        </div>
        {/* Bulk action toolbar. Selection-based: move ↑↓ shift the
            selected block past unselected rows preserving order; Delete
            removes everything in the selection; Reset sorts by dataset
            column order. The selection counter on the left doubles as
            a select-all toggle for fast bulk operations. */}
        <div className="gb-multi-mgr-toolbar">
          <button
            type="button"
            className="gb-multi-mgr-toolbar-sel"
            onClick={allSelected ? clearSelection : selectAll}
            title={allSelected
              ? t("graph.multiSlot.clearSel", { defaultValue: "Clear selection" })
              : t("graph.multiSlot.selectAll", { defaultValue: "Select all" })}
          >
            {selCount > 0
              ? t("graph.multiSlot.selCount", {
                  defaultValue: "{{n}} selected",
                  n: selCount,
                })
              : t("graph.multiSlot.selNone", { defaultValue: "None selected" })}
          </button>
          <span className="gb-multi-mgr-toolbar-spacer" />
          <button
            type="button"
            className="gb-multi-mgr-toolbar-btn"
            disabled={upDisabled}
            onClick={moveUp}
            title={t("graph.multiSlot.moveUp", { defaultValue: "Move up" })}
          >
            ↑
          </button>
          <button
            type="button"
            className="gb-multi-mgr-toolbar-btn"
            disabled={downDisabled}
            onClick={moveDown}
            title={t("graph.multiSlot.moveDown", { defaultValue: "Move down" })}
          >
            ↓
          </button>
          <button
            type="button"
            className="gb-multi-mgr-toolbar-btn gb-multi-mgr-toolbar-btn-del"
            disabled={selCount === 0}
            onClick={deleteSelected}
            title={t("graph.multiSlot.deleteSel", { defaultValue: "Delete selected" })}
          >
            ×
          </button>
          <button
            type="button"
            className="gb-multi-mgr-toolbar-btn"
            onClick={resetOrder}
            title={t("graph.multiSlot.resetOrder", {
              defaultValue: "Reset to dataset column order",
            })}
          >
            ⟲
          </button>
        </div>
        <div className="gb-multi-mgr-body">
          {cols.map((c) => {
            const sel = selected.has(c.name);
            return (
              <div
                key={c.name}
                className={`gb-multi-mgr-row${sel ? " gb-multi-mgr-row-sel" : ""}`}
                onClick={(e) => handleRowClick(c.name, e)}
              >
                <span className="gb-multi-mgr-row-name">{c.name}</span>
              </div>
            );
          })}
        </div>
        <div className="gb-multi-mgr-foot">
          <button
            className="gb-multi-mgr-foot-btn gb-multi-mgr-foot-btn-primary"
            onClick={onClose}
          >
            {t("graph.multiSlot.done", { defaultValue: "Done" })}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Layer cards ---------------------------------------------------------
// Each enabled chart kind in `elements` gets a card rendered in the left
// rail's "Layers" section. The card shows the kind label, a delete button,
// and any kind-specific inline settings (e.g. smoother lambda slider, scatter
// encoding hints). At the end of the list, an `AddLayerCard` shows a `+`
// tile that opens a small popover listing kinds not yet present.

interface LayerCardProps {
  kind: ElementKind;
  label: string;
  options: Record<string, unknown>;
  onChangeOptions: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}

/** Read an option with a default fallback. */
function getOpt<T>(opts: Record<string, unknown>, key: string, def: T): T {
  const v = opts[key];
  return v === undefined ? def : (v as T);
}

function LayerCard({
  kind,
  label,
  options,
  onChangeOptions,
  onRemove,
  t,
}: LayerCardProps) {
  const def = CHART_TYPE_DEFS.find((c) => c.kind === kind);
  return (
    <div className="gb-layer-card">
      <div className="gb-layer-head">
        <span className="gb-layer-icon">{def?.icon ?? "▦"}</span>
        <span className="gb-layer-title">{label}</span>
        <button
          className="gb-layer-x"
          onClick={onRemove}
          title={t("graph.removeLayer")}
        >
          ×
        </button>
      </div>
      <div className="gb-layer-body">
        {kind === "points" && (
          <PointsOptions options={options} onChange={onChangeOptions} t={t} />
        )}
        {kind === "line" && (
          <LineOptions options={options} onChange={onChangeOptions} t={t} />
        )}
        {kind === "boxplot" && (
          <BoxplotOptions options={options} onChange={onChangeOptions} t={t} />
        )}
        {kind === "histogram" && (
          <HistogramOptions options={options} onChange={onChangeOptions} t={t} />
        )}
        {kind === "smoother" && (
          <SmootherOptions options={options} onChange={onChangeOptions} t={t} />
        )}
        {kind === "fitline" && (
          <FitLineOptions options={options} onChange={onChangeOptions} t={t} />
        )}
      </div>
    </div>
  );
}

// ---- Per-kind option editors --------------------------------------------
// All settings are stored in `element.options` (a Record<string,unknown>).
// These editors are presentational only — value changes go straight back to
// the store via `onChange`. Defaults mirror the JMP-style screenshot.

interface OptionsEditorProps {
  options: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}

function OptRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="gb-opt-row">
      <span className="gb-opt-label">{label}</span>
      <span className="gb-opt-ctrl">{children}</span>
    </div>
  );
}

function PointsOptions({ options, onChange, t }: OptionsEditorProps) {
  const summary = getOpt<string>(options, "summaryStat", "none");
  const errInterval = getOpt<string>(options, "errorInterval", "auto");
  const intStyle = getOpt<string>(options, "intervalStyle", "errorBar");
  // Default is "stacked" — "auto" remains a legacy value (older specs).
  // The renderer treats both the same; here we only need to make sure
  // the <select> shows a sensible selection for legacy values too, so
  // collapse "auto" → "stacked" for the dropdown's selected value.
  const jitterRaw = getOpt<string>(options, "jitter", "stacked");
  const jitter = jitterRaw === "auto" ? "stacked" : jitterRaw;
  const jitterLimit = getOpt<number>(options, "jitterLimit", 0.5);
  return (
    <>
      <OptRow label={t("graph.opt.summaryStat")}>
        <select
          className="gb-opt-select"
          value={summary}
          onChange={(e) => onChange({ summaryStat: e.target.value })}
        >
          <option value="none">{t("graph.opt.summary.none")}</option>
          <option value="mean">{t("graph.opt.summary.mean")}</option>
          <option value="median">{t("graph.opt.summary.median")}</option>
          <option value="sum">{t("graph.opt.summary.sum")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.errorInterval")}>
        <select
          className="gb-opt-select"
          value={errInterval}
          onChange={(e) => onChange({ errorInterval: e.target.value })}
        >
          <option value="auto">{t("graph.opt.auto")}</option>
          <option value="none">{t("graph.opt.summary.none")}</option>
          <option value="stdErr">{t("graph.opt.interval.stdErr")}</option>
          <option value="stdDev">{t("graph.opt.interval.stdDev")}</option>
          <option value="ci95">{t("graph.opt.interval.ci95")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.intervalStyle")}>
        <select
          className="gb-opt-select"
          value={intStyle}
          onChange={(e) => onChange({ intervalStyle: e.target.value })}
        >
          <option value="errorBar">{t("graph.opt.style.errorBar")}</option>
          <option value="band">{t("graph.opt.style.band")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.jitter")}>
        <select
          className="gb-opt-select"
          value={jitter}
          onChange={(e) => onChange({ jitter: e.target.value })}
        >
          <option value="stacked">{t("graph.opt.jitterMode.stacked")}</option>
          <option value="uniform">{t("graph.opt.jitterMode.uniform")}</option>
          <option value="normal">{t("graph.opt.jitterMode.normal")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.jitterLimit")}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={jitterLimit}
          onChange={(e) => onChange({ jitterLimit: parseFloat(e.target.value) })}
          className="gb-slider"
        />
      </OptRow>
    </>
  );
}

function LineOptions({ options, onChange, t }: OptionsEditorProps) {
  const rowOrder = getOpt<boolean>(options, "rowOrder", false);
  const connection = getOpt<string>(options, "connection", "line");
  const summary = getOpt<string>(options, "summaryStat", "mean");
  const fill = getOpt<string>(options, "fill", "none");
  const errInterval = getOpt<string>(options, "errorInterval", "auto");
  const intStyle = getOpt<string>(options, "intervalStyle", "errorBar");
  const missingFactors = getOpt<string>(options, "missingFactors", "skip");
  const missingValues = getOpt<string>(options, "missingValues", "connect");
  return (
    <>
      <OptRow label={t("graph.opt.rowOrder")}>
        <input
          type="checkbox"
          checked={rowOrder}
          onChange={(e) => onChange({ rowOrder: e.target.checked })}
        />
      </OptRow>
      <OptRow label={t("graph.opt.connection")}>
        <select
          className="gb-opt-select"
          value={connection}
          onChange={(e) => onChange({ connection: e.target.value })}
        >
          <option value="line">{t("graph.opt.conn.line")}</option>
          <option value="step">{t("graph.opt.conn.step")}</option>
          <option value="spline">{t("graph.opt.conn.spline")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.summaryStat")}>
        <select
          className="gb-opt-select"
          value={summary}
          onChange={(e) => onChange({ summaryStat: e.target.value })}
        >
          <option value="mean">{t("graph.opt.summary.mean")}</option>
          <option value="median">{t("graph.opt.summary.median")}</option>
          <option value="sum">{t("graph.opt.summary.sum")}</option>
          <option value="none">{t("graph.opt.summary.none")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.fill")}>
        <select
          className="gb-opt-select"
          value={fill}
          onChange={(e) => onChange({ fill: e.target.value })}
        >
          <option value="none">{t("graph.opt.summary.none")}</option>
          <option value="toZero">{t("graph.opt.fillMode.toZero")}</option>
          <option value="between">{t("graph.opt.fillMode.between")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.errorInterval")}>
        <select
          className="gb-opt-select"
          value={errInterval}
          onChange={(e) => onChange({ errorInterval: e.target.value })}
        >
          <option value="auto">{t("graph.opt.auto")}</option>
          <option value="none">{t("graph.opt.summary.none")}</option>
          <option value="stdErr">{t("graph.opt.interval.stdErr")}</option>
          <option value="stdDev">{t("graph.opt.interval.stdDev")}</option>
          <option value="ci95">{t("graph.opt.interval.ci95")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.intervalStyle")}>
        <select
          className="gb-opt-select"
          value={intStyle}
          onChange={(e) => onChange({ intervalStyle: e.target.value })}
        >
          <option value="errorBar">{t("graph.opt.style.errorBar")}</option>
          <option value="band">{t("graph.opt.style.band")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.missingFactors")}>
        <select
          className="gb-opt-select"
          value={missingFactors}
          onChange={(e) => onChange({ missingFactors: e.target.value })}
        >
          <option value="skip">{t("graph.opt.missing.skip")}</option>
          <option value="include">{t("graph.opt.missing.include")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.missingValues")}>
        <select
          className="gb-opt-select"
          value={missingValues}
          onChange={(e) => onChange({ missingValues: e.target.value })}
        >
          <option value="connect">{t("graph.opt.missing.connect")}</option>
          <option value="break">{t("graph.opt.missing.break")}</option>
        </select>
      </OptRow>
    </>
  );
}

function BoxplotOptions({ options, onChange, t }: OptionsEditorProps) {
  // See PointsOptions for the "auto" → "stacked" legacy mapping rationale.
  const jitterRaw = getOpt<string>(options, "jitter", "stacked");
  const jitter = jitterRaw === "auto" ? "stacked" : jitterRaw;
  const outliers = getOpt<boolean>(options, "outliers", true);
  const boxType = getOpt<string>(options, "boxType", "outlier");
  const boxStyle = getOpt<string>(options, "boxStyle", "normal");
  const fiveNum = getOpt<boolean>(options, "fiveNumberSummary", false);
  const widthProp = getOpt<number>(options, "widthProportion", 0.5);
  return (
    <>
      <OptRow label={t("graph.opt.jitter")}>
        <select
          className="gb-opt-select"
          value={jitter}
          onChange={(e) => onChange({ jitter: e.target.value })}
        >
          <option value="stacked">{t("graph.opt.jitterMode.stacked")}</option>
          <option value="uniform">{t("graph.opt.jitterMode.uniform")}</option>
          <option value="normal">{t("graph.opt.jitterMode.normal")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.outliers")}>
        <input
          type="checkbox"
          checked={outliers}
          onChange={(e) => onChange({ outliers: e.target.checked })}
        />
      </OptRow>
      <OptRow label={t("graph.opt.boxType")}>
        <select
          className="gb-opt-select"
          value={boxType}
          onChange={(e) => onChange({ boxType: e.target.value })}
        >
          <option value="outlier">{t("graph.opt.box.outlier")}</option>
          <option value="quantile">{t("graph.opt.box.quantile")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.boxStyle")}>
        <select
          className="gb-opt-select"
          value={boxStyle}
          onChange={(e) => onChange({ boxStyle: e.target.value })}
        >
          <option value="normal">{t("graph.opt.box.normal")}</option>
          <option value="notched">{t("graph.opt.box.notched")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.fiveNumberSummary")}>
        <input
          type="checkbox"
          checked={fiveNum}
          onChange={(e) => onChange({ fiveNumberSummary: e.target.checked })}
        />
      </OptRow>
      <OptRow label={t("graph.opt.widthProportion")}>
        <input
          type="number"
          className="gb-opt-num"
          min={0}
          max={1}
          step={0.05}
          value={widthProp}
          onChange={(e) =>
            onChange({ widthProportion: parseFloat(e.target.value) || 0 })
          }
        />
      </OptRow>
    </>
  );
}

/** Histogram options panel — JMP-style style selector + per-bin labels.
 *  The Smoothness slider only matters for KDE so we hide it for the
 *  other styles to reduce visual noise. */
function HistogramOptions({ options, onChange, t }: OptionsEditorProps) {
  const histStyle = getOpt<string>(options, "histStyle", "bar");
  const smoothness = getOpt<number>(options, "smoothness", 0.5);
  const histHeight = getOpt<number>(options, "histHeight", 1);
  const showCounts = getOpt<boolean>(options, "showCounts", false);
  const showPercents = getOpt<boolean>(options, "showPercents", false);
  return (
    <>
      <OptRow label={t("graph.opt.histStyle")}>
        <select
          className="gb-opt-select"
          value={histStyle}
          onChange={(e) => onChange({ histStyle: e.target.value })}
        >
          <option value="bar">{t("graph.opt.histStyles.bar")}</option>
          <option value="polygon">{t("graph.opt.histStyles.polygon")}</option>
          <option value="kde">{t("graph.opt.histStyles.kde")}</option>
          <option value="shadowgram">{t("graph.opt.histStyles.shadowgram")}</option>
        </select>
      </OptRow>
      {histStyle === "kde" && (
        <OptRow label={t("graph.opt.smoothness")}>
          <input
            type="range"
            className="gb-slider"
            min={0}
            max={1}
            step={0.05}
            value={smoothness}
            onChange={(e) => onChange({ smoothness: parseFloat(e.target.value) })}
          />
        </OptRow>
      )}
      <OptRow label={t("graph.opt.histHeight")}>
        <input
          type="range"
          className="gb-slider"
          min={0.1}
          max={1}
          step={0.05}
          value={histHeight}
          onChange={(e) => onChange({ histHeight: parseFloat(e.target.value) })}
        />
      </OptRow>
      <OptRow label={t("graph.opt.showCounts")}>
        <input
          type="checkbox"
          checked={showCounts}
          onChange={(e) => onChange({ showCounts: e.target.checked })}
        />
      </OptRow>
      <OptRow label={t("graph.opt.showPercents")}>
        <input
          type="checkbox"
          checked={showPercents}
          onChange={(e) => onChange({ showPercents: e.target.checked })}
        />
      </OptRow>
    </>
  );
}

/** Smoother options panel — algorithm selector + per-algorithm
 *  parameters. The visible controls below the algo dropdown vary with
 *  the selected algorithm so the panel only ever shows the inputs that
 *  actually affect the current curve. */
function SmootherOptions({ options, onChange, t }: OptionsEditorProps) {
  const algo = getOpt<string>(options, "algo", "movingAvg");
  // Per-algo parameter slots. Defaults match the values used in
  // transform.ts so an un-edited element renders identically to a
  // freshly added one.
  const splineSmoothness = getOpt<number>(options, "splineSmoothness", 0.5);
  const kernelBandwidth = getOpt<number>(options, "kernelBandwidth", 0.1);
  const savgolWindow = getOpt<number>(options, "savgolWindow", 11);
  const savgolPolyOrder = getOpt<number>(options, "savgolPolyOrder", 2);
  // `windowFraction` is the new key; fall back to legacy `lambda` for
  // pre-existing smoother elements so they show the right slider value
  // the first time their card is opened.
  const windowFraction = getOpt<number>(
    options,
    "windowFraction",
    getOpt<number>(options, "lambda", 0.4),
  );
  return (
    <>
      <OptRow label={t("graph.opt.smootherAlgo")}>
        <select
          className="gb-opt-select"
          value={algo}
          onChange={(e) => onChange({ algo: e.target.value })}
        >
          <option value="spline">{t("graph.opt.smootherAlgos.spline")}</option>
          <option value="kernel">{t("graph.opt.smootherAlgos.kernel")}</option>
          <option value="savgol">{t("graph.opt.smootherAlgos.savgol")}</option>
          <option value="movingAvg">
            {t("graph.opt.smootherAlgos.movingAvg")}
          </option>
          <option value="movingBox">
            {t("graph.opt.smootherAlgos.movingBox")}
          </option>
        </select>
      </OptRow>
      {algo === "spline" && (
        <OptRow label={t("graph.opt.smootherSplineSmoothness")}>
          <input
            type="range"
            className="gb-slider"
            min={0}
            max={1}
            step={0.05}
            value={splineSmoothness}
            onChange={(e) =>
              onChange({ splineSmoothness: parseFloat(e.target.value) })
            }
          />
        </OptRow>
      )}
      {algo === "kernel" && (
        <OptRow label={t("graph.opt.smootherKernelBandwidth")}>
          <input
            type="range"
            className="gb-slider"
            min={0.01}
            max={0.5}
            step={0.01}
            value={kernelBandwidth}
            onChange={(e) =>
              onChange({ kernelBandwidth: parseFloat(e.target.value) })
            }
          />
        </OptRow>
      )}
      {algo === "savgol" && (
        <>
          <OptRow label={t("graph.opt.smootherSavgolWindow")}>
            <input
              type="number"
              className="gb-opt-num"
              min={5}
              max={101}
              step={2}
              value={savgolWindow}
              onChange={(e) => {
                const raw = parseInt(e.target.value, 10);
                const v = Number.isFinite(raw)
                  ? Math.max(5, Math.min(101, raw))
                  : 11;
                // SG window must be odd — silently round up the even
                // values the spinner produces with step=2 ± clamping.
                onChange({ savgolWindow: v % 2 === 1 ? v : v + 1 });
              }}
            />
          </OptRow>
          <OptRow label={t("graph.opt.smootherSavgolPolyOrder")}>
            <select
              className="gb-opt-select"
              value={savgolPolyOrder}
              onChange={(e) =>
                onChange({ savgolPolyOrder: parseInt(e.target.value, 10) })
              }
            >
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
            </select>
          </OptRow>
        </>
      )}
      {(algo === "movingAvg" || algo === "movingBox") && (
        <OptRow label={t("graph.opt.smootherWindow")}>
          <input
            type="range"
            className="gb-slider"
            min={0.02}
            max={0.9}
            step={0.02}
            value={windowFraction}
            onChange={(e) =>
              onChange({ windowFraction: parseFloat(e.target.value) })
            }
          />
        </OptRow>
      )}
    </>
  );
}

/** Fit-line options panel — fit type (Polynomial / Robust Cauchy) +
 *  degree (1–6) + Fit / Prediction confidence-band toggles + a master
 *  Statistics toggle that reveals the four per-stat checkboxes
 *  (Equation / RMSE / R² / F Test). Layout mirrors HistogramOptions
 *  and SmootherOptions so the panel feels like the rest of the
 *  Builder. */
function FitLineOptions({ options, onChange, t }: OptionsEditorProps) {
  const fitType = getOpt<string>(options, "fitType", "polynomial");
  const degree = getOpt<number>(options, "degree", 1);
  const showFitCI = getOpt<boolean>(options, "showFitCI", false);
  const showPredCI = getOpt<boolean>(options, "showPredCI", false);
  const showStats = getOpt<boolean>(options, "showStats", false);
  const showEquation = getOpt<boolean>(options, "showEquation", false);
  const showRMSE = getOpt<boolean>(options, "showRMSE", false);
  const showR2 = getOpt<boolean>(options, "showR2", false);
  const showFTest = getOpt<boolean>(options, "showFTest", false);
  return (
    <>
      <OptRow label={t("graph.opt.fitType")}>
        <select
          className="gb-opt-select"
          value={fitType}
          onChange={(e) => onChange({ fitType: e.target.value })}
        >
          <option value="polynomial">
            {t("graph.opt.fitTypes.polynomial")}
          </option>
          <option value="robustCauchy">
            {t("graph.opt.fitTypes.robustCauchy")}
          </option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.fitDegree")}>
        <select
          className="gb-opt-select"
          value={degree}
          onChange={(e) => onChange({ degree: parseInt(e.target.value, 10) })}
        >
          <option value={1}>{t("graph.opt.fitDegrees.1")}</option>
          <option value={2}>{t("graph.opt.fitDegrees.2")}</option>
          <option value={3}>{t("graph.opt.fitDegrees.3")}</option>
          <option value={4}>{t("graph.opt.fitDegrees.4")}</option>
          <option value={5}>{t("graph.opt.fitDegrees.5")}</option>
          <option value={6}>{t("graph.opt.fitDegrees.6")}</option>
        </select>
      </OptRow>
      <OptRow label={t("graph.opt.fitConf.fit")}>
        <input
          type="checkbox"
          checked={showFitCI}
          onChange={(e) => onChange({ showFitCI: e.target.checked })}
        />
      </OptRow>
      <OptRow label={t("graph.opt.fitConf.prediction")}>
        <input
          type="checkbox"
          checked={showPredCI}
          onChange={(e) => onChange({ showPredCI: e.target.checked })}
        />
      </OptRow>
      <OptRow label={t("graph.opt.fitStats")}>
        <input
          type="checkbox"
          checked={showStats}
          onChange={(e) => onChange({ showStats: e.target.checked })}
        />
      </OptRow>
      {showStats && (
        <>
          <OptRow label={t("graph.opt.fitStat.equation")}>
            <input
              type="checkbox"
              checked={showEquation}
              onChange={(e) =>
                onChange({ showEquation: e.target.checked })
              }
            />
          </OptRow>
          <OptRow label={t("graph.opt.fitStat.rmse")}>
            <input
              type="checkbox"
              checked={showRMSE}
              onChange={(e) => onChange({ showRMSE: e.target.checked })}
            />
          </OptRow>
          <OptRow label={t("graph.opt.fitStat.r2")}>
            <input
              type="checkbox"
              checked={showR2}
              onChange={(e) => onChange({ showR2: e.target.checked })}
            />
          </OptRow>
          <OptRow label={t("graph.opt.fitStat.fTest")}>
            <input
              type="checkbox"
              checked={showFTest}
              onChange={(e) => onChange({ showFTest: e.target.checked })}
            />
          </OptRow>
        </>
      )}
    </>
  );
}

interface AddLayerCardProps {
  availableKinds: ElementKind[];
  onAdd: (kind: ElementKind) => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}

function AddLayerCard({ availableKinds, onAdd, t }: AddLayerCardProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Anchored position for the portaled menu. Recomputed when opened and on
  // window resize / ancestor scroll so the menu stays glued to the button
  // and never gets clipped by the surrounding scroll container.
  const [pos, setPos] = useState<{ left: number; top: number; width: number; flipUp: boolean } | null>(null);

  const recompute = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    // Estimate menu height from item count; clamp to a sane max.
    const estItemH = 28;
    const estMenuH = Math.min(availableKinds.length * estItemH + 8, 320);
    const spaceBelow = vh - r.bottom;
    const spaceAbove = r.top;
    const flipUp = spaceBelow < estMenuH + 8 && spaceAbove > spaceBelow;
    const top = flipUp ? Math.max(4, r.top - estMenuH - 4) : Math.min(vh - 4, r.bottom + 4);
    const left = Math.max(4, Math.min(r.left, vw - r.width - 4));
    setPos({ left, top, width: r.width, flipUp });
  }, [availableKinds.length]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    recompute();
    const onWin = () => recompute();
    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true); // capture: catch all ancestor scrolls
    return () => {
      window.removeEventListener("resize", onWin);
      window.removeEventListener("scroll", onWin, true);
    };
  }, [open, recompute]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as Node | null;
      if (!tgt) return;
      if (btnRef.current?.contains(tgt)) return;
      if (menuRef.current?.contains(tgt)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // After first paint, refine top if real height differs from estimate (esp.
  // when flipping above the button).
  useLayoutEffect(() => {
    if (!open || !pos || !menuRef.current) return;
    const real = menuRef.current.getBoundingClientRect();
    const btn = btnRef.current?.getBoundingClientRect();
    if (!btn) return;
    const vh = window.innerHeight;
    if (pos.flipUp) {
      const want = Math.max(4, btn.top - real.height - 4);
      if (Math.abs(want - pos.top) > 0.5) setPos({ ...pos, top: want });
    } else if (pos.top + real.height > vh - 4) {
      // Not enough room — flip up.
      const want = Math.max(4, btn.top - real.height - 4);
      setPos({ ...pos, top: want, flipUp: true });
    }
  }, [open, pos]);

  if (availableKinds.length === 0) return null;
  return (
    <div className="gb-layer-add-wrap">
      <button
        ref={btnRef}
        className="gb-layer-add"
        onClick={() => setOpen((o) => !o)}
        title={t("graph.addLayer")}
      >
        +
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="gb-layer-add-menu gb-layer-add-menu-portal"
          style={{ left: pos.left, top: pos.top, minWidth: pos.width }}
        >
          {availableKinds.map((k) => {
            const def = CHART_TYPE_DEFS.find((c) => c.kind === k);
            return (
              <button
                key={k}
                className="gb-layer-add-item"
                onClick={() => {
                  onAdd(k);
                  setOpen(false);
                }}
              >
                <span className="gb-layer-icon">{def?.icon ?? "▦"}</span>
                <span>{t(`graph.type.${k}`)}</span>
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}

// ---- Legend + per-group Style editor -----------------------------------
// Top half of the panel: a legend listing every group from the Color/
// Overlay encoding (or a single "All" entry when there is no grouping).
// Clicking a row selects it.
//
// Bottom half: a style editor for the selected group with three sections
// (Line, Fill, Point). Whatever active layer kinds (scatter, box plot,
// line, smoother, …) reuse this style — boxplot's body uses Fill, its
// border + median + whiskers use Line, its outliers use Point.

interface LegendStylePanelProps {
  data: GraphData | null;
  encoding: Partial<Record<GraphSlotKey, FieldRef>>;
  /** Active layer kinds — used to pick a sensible Fill default in the
   *  swatch (box plots want a colored fill even when ungrouped, while
   *  scatter / line / bar prefer the JMP "hollow" look). */
  elements: ChartElement[];
  groupStyles: GroupStyleMap;
  /** Group values driving the legend, computed at the parent level so
   *  the same list feeds both the renderer (via spec) and this panel. */
  groupKeys: string[];
  /** Fully-resolved per-group styles (user overrides + palette/categorical
   *  auto-defaults). Used by the swatches and as the "live" preview the
   *  MarkEditor falls back to when a particular mark hasn't been
   *  explicitly overridden yet. */
  effectiveStyles: GroupStyleMap;
  /** Group values currently hidden via the legend show/hide toggle. */
  hiddenGroups: string[];
  /** Flip one group's hidden state. */
  toggleGroupHidden: (groupKey: string) => void;
  setGroupStyle: (groupKey: string, next: GroupStyle | undefined) => void;
  /** Drop every per-group override and return the chart to factory
   *  defaults. Wired to the STYLE editor's Reset button. */
  resetAllGroupStyles: () => void;
  onDropOverlay: (e: React.DragEvent) => void;
  onClearOverlay: () => void;
  width: number;
}

function LegendStylePanel({ data, encoding, elements, groupStyles, groupKeys, effectiveStyles, hiddenGroups, toggleGroupHidden, setGroupStyle, resetAllGroupStyles, onDropOverlay, onClearOverlay, width }: LegendStylePanelProps) {
  const { t } = useTranslation();

  // `data` and `elements` are still part of the public prop contract for
  // historical reasons (other call sites can pass them through); reference
  // them here so TS' noUnusedParameters check stays happy without forcing
  // every caller to drop them.
  void data;
  void elements;

  const [selected, setSelected] = useState<string>(groupKeys[0] ?? DEFAULT_GROUP_KEY);
  // Keep the selection valid when the legend list changes underneath us.
  useEffect(() => {
    if (!groupKeys.includes(selected)) {
      setSelected(groupKeys[0] ?? DEFAULT_GROUP_KEY);
    }
  }, [groupKeys, selected]);

  // Resolve "what color should the swatch / fallback show" for one group.
  // The expensive default-derivation logic lives at the parent in
  // `buildEffectiveStyles`; this thin wrapper just reads from the map and
  // returns a hard-fallback for the rare case where a group key isn't in
  // the map yet (e.g. during a render frame right after data changed).
  const effectiveStyleOf = (key: string): GroupStyle => {
    const eff = effectiveStyles[key];
    if (eff) return eff;
    return {
      line: { color: "#000", lineWidth: 1.5, opacity: 1 },
      fill: { color: "transparent", opacity: 1 },
      point: { color: "#000", fillColor: "#000", marker: "circle", markerSize: 4, opacity: 1 },
    };
  };

  const updateMark = (groupKey: string, mark: "line" | "fill" | "point", patch: Partial<MarkStyle>) => {
    const cur = groupStyles[groupKey] ?? {};
    const curMark = (cur[mark] ?? {}) as MarkStyle;
    setGroupStyle(groupKey, { ...cur, [mark]: { ...curMark, ...patch } });
  };

  /**
   * Apply a color *theme* to Line / Fill / Point at once. The theme picks
   * one base hue from the JMP palette and assigns a darker shade to the
   * Point, the base shade to the Line, and a lighter shade to the Fill
   * so the three sub-marks stay distinguishable when layered.
   * Other per-mark properties (line width, marker, opacity, …) are kept
   * as-is so the user can theme the color independently of size/shape.
   */
  const applyTheme = (groupKey: string, idx: number) => {
    const cur = groupStyles[groupKey] ?? {};
    setGroupStyle(groupKey, {
      ...cur,
      line: { ...(cur.line ?? {}), color: LINE_PALETTE[idx] },
      fill: { ...(cur.fill ?? {}), color: FILL_PALETTE[idx] },
      point: {
        ...(cur.point ?? {}),
        color: POINT_PALETTE[idx],
        fillColor: POINT_PALETTE[idx],
      },
    });
  };

  /**
   * Apply a user-defined custom palette (stored in useGraphPaletteStore).
   * Unlike the built-in `applyTheme`, custom palettes carry their three
   * final per-mark colors verbatim — no `shade()` re-derivation here, so
   * what the user saved is exactly what gets painted.
   */
  const applyCustomTheme = (groupKey: string, p: CustomPalette) => {
    const cur = groupStyles[groupKey] ?? {};
    setGroupStyle(groupKey, {
      ...cur,
      line: { ...(cur.line ?? {}), color: p.line },
      fill: { ...(cur.fill ?? {}), color: p.fill },
      point: {
        ...(cur.point ?? {}),
        color: p.point,
        fillColor: p.point,
      },
    });
  };

  // Custom user-defined palettes (persisted across sessions). The Theme
  // picker below renders these after the built-in swatches and ends with
  // a "+" button that opens AddPaletteDialog.
  const customPalettes = useGraphPaletteStore((s) => s.palettes);
  const addPalette = useGraphPaletteStore((s) => s.addPalette);
  const removePalette = useGraphPaletteStore((s) => s.removePalette);
  const [showAddDialog, setShowAddDialog] = useState(false);
  // Right-click on a custom swatch opens a tiny "Delete" context menu.
  const [paletteCtxMenu, setPaletteCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!paletteCtxMenu) return;
    const close = () => setPaletteCtxMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [paletteCtxMenu]);

  // The Reset button in the STYLE editor header is a *chart-wide* reset,
  // not per-group. It lives in the editor's section header (not next to a
  // legend row), so users reasonably read it as "restore defaults for the
  // whole chart". A per-group-only reset also broke the enabled state
  // (button disabled while viewing an untouched group even though OTHER
  // groups were still customized) and made the only path to clean state a
  // tedious select-each-group / click-reset loop.
  const hasAnyCustomStyles = Object.keys(groupStyles).length > 0;

  const selectedStyle = effectiveStyleOf(selected);
  const storedSelected = groupStyles[selected] ?? {};

  return (
    <div className="gb-legend" style={{ width }}>
      {/* Unified panel header bar (matches Table column panel + LAYERS) */}
      <div className="sp-panel-header">
        <span className="sp-panel-header-title">{t("graph.legend.title")}</span>
      </div>

      <div className="gb-legend-body">
        {/* Overlay slot — placed under the LEGEND header and above the
            first legend entry so the visual hierarchy makes it clear: the
            legend rows below exist *because* this Overlay column is set. */}
        <Slot
          slot="overlay"
          label="Overlay"
          field={encoding.overlay}
          onDrop={onDropOverlay}
          onClear={onClearOverlay}
          onContextMenu={(x, y) => setSlotCtxMenu({ slot: "overlay", x, y })}
          orientation="shelf"
        />

        {/* Legend list */}
        {groupKeys.map((key) => {
          const st = effectiveStyleOf(key);
          const label = key === DEFAULT_GROUP_KEY ? t("graph.legend.allEntries") : (key || "—");
          // Show/hide toggle is per-group and only meaningful when the
          // legend has more than one entry — hiding the only entry would
          // erase the chart. Keep the button rendered (no layout jitter)
          // but disable it for the ungrouped single-row case.
          const isHidden = hiddenGroups.includes(key);
          const canToggle = !!encoding.overlay;
          const hideTitle = isHidden
            ? t("graph.legend.show", { defaultValue: "Show this group" })
            : t("graph.legend.hide", { defaultValue: "Hide this group" });
          return (
            <div
              key={key}
              className={`gb-legend-item${key === selected ? " gb-legend-item-selected" : ""}${isHidden ? " gb-legend-item-hidden" : ""}`}
              onClick={() => setSelected(key)}
            >
              <span className="gb-legend-swatch">
                <CompositeSwatch style={st} />
              </span>
              <span className="gb-legend-label" title={label}>{label}</span>
              <button
                className="gb-legend-toggle"
                onClick={(e) => {
                  // Don't let the click also flip the row's selected
                  // state — the eye button is a discrete action.
                  e.stopPropagation();
                  if (canToggle) toggleGroupHidden(key);
                }}
                disabled={!canToggle}
                title={hideTitle}
                aria-label={hideTitle}
                aria-pressed={isHidden}
              >
                {isHidden ? (
                  // Eye-off (hidden) — outline eye with a diagonal slash.
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M2 8s2.2-4 6-4c1.2 0 2.2.3 3.1.8M14 8s-2.2 4-6 4c-1.2 0-2.2-.3-3.1-.8" />
                    <path d="M6.5 6.5a2 2 0 0 0 2.9 2.9" />
                    <path d="M2.5 13.5l11-11" />
                  </svg>
                ) : (
                  // Eye (visible) — outline almond shape with pupil.
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M1.5 8S4 4 8 4s6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8z" />
                    <circle cx="8" cy="8" r="1.8" />
                  </svg>
                )}
              </button>
            </div>
          );
        })}

        {/* Style editor (bottom half) */}
        <div className="gb-style-editor">
          <div className="sp-panel-header">
            <span className="sp-panel-header-title">{t("graph.style.editorTitle")}</span>
            <button
              className="gb-style-reset"
              onClick={resetAllGroupStyles}
              title={t("graph.style.resetAllHint")}
              disabled={!hasAnyCustomStyles}
            >
              {t("graph.style.reset")}
            </button>
          </div>

          {/* Color theme — one-click recolor of Line/Fill/Point. Each
              theme assigns a darker shade to Point, base shade to Line
              and a lighter shade to Fill so the three sub-marks stay
              visually distinguishable when stacked. Other per-mark
              properties (width, marker shape, opacity, …) are preserved. */}
          <div className="gb-style-section gb-style-theme-section">
            <div
              className="gb-style-section-title"
              title={t("graph.style.themeHint")}
            >
              {t("graph.style.theme")}
            </div>
            <div className="gb-style-row">
              <div className="gb-style-color-row gb-style-theme-row">
                {STYLE_COLORS.map((_, i) => {
                  const matches =
                    selectedStyle.line!.color === LINE_PALETTE[i] &&
                    selectedStyle.fill!.color === FILL_PALETTE[i] &&
                    selectedStyle.point!.color === POINT_PALETTE[i];
                  // Vertical 3-band gradient communicates the shade trio
                  // — Fill (top, light), Line (middle, mid), Point (bottom, dark).
                  const bg = `linear-gradient(180deg, ${FILL_PALETTE[i]} 0 33%, ${LINE_PALETTE[i]} 33% 67%, ${POINT_PALETTE[i]} 67% 100%)`;
                  return (
                    <button
                      key={i}
                      type="button"
                      className={`gb-style-color-swatch gb-style-theme-swatch${matches ? " gb-style-color-selected" : ""}`}
                      style={{ background: bg }}
                      title={`${FILL_PALETTE[i]} / ${LINE_PALETTE[i]} / ${POINT_PALETTE[i]}`}
                      onClick={() => applyTheme(selected, i)}
                    />
                  );
                })}
                {/* Custom user-saved palettes — same swatch styling so
                    they sit visually flush with the built-ins. Right-click
                    opens a delete affordance; left-click applies the theme
                    to the currently selected legend group. */}
                {customPalettes.map((p) => {
                  const matches =
                    selectedStyle.line!.color === p.line &&
                    selectedStyle.fill!.color === p.fill &&
                    selectedStyle.point!.color === p.point;
                  const bg = `linear-gradient(180deg, ${p.fill} 0 33%, ${p.line} 33% 67%, ${p.point} 67% 100%)`;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`gb-style-color-swatch gb-style-theme-swatch${matches ? " gb-style-color-selected" : ""}`}
                      style={{ background: bg }}
                      title={`${p.fill} / ${p.line} / ${p.point}`}
                      onClick={() => applyCustomTheme(selected, p)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setPaletteCtxMenu({ id: p.id, x: e.clientX, y: e.clientY });
                      }}
                    />
                  );
                })}
                <button
                  type="button"
                  className="gb-style-color-swatch gb-style-theme-swatch gb-style-theme-add"
                  title={t("graph.style.addTheme")}
                  onClick={() => setShowAddDialog(true)}
                  aria-label={t("graph.style.addTheme")}
                >
                  +
                </button>
              </div>
            </div>
          </div>

          <MarkEditor
            title={t("graph.mark.point")}
            mark="point"
            value={(storedSelected.point ?? {}) as MarkStyle}
            effective={{
              color: selectedStyle.point!.color!,
              marker: selectedStyle.point!.marker,
              markerSize: selectedStyle.point!.markerSize,
              opacity: selectedStyle.point!.opacity,
            }}
            onChange={(patch) => updateMark(selected, "point", patch)}
            fields={["color", "marker", "markerSize", "opacity"]}
          />
          <MarkEditor
            title={t("graph.mark.line")}
            mark="line"
            value={(storedSelected.line ?? {}) as MarkStyle}
            effective={{
              color: selectedStyle.line!.color!,
              lineWidth: selectedStyle.line!.lineWidth,
              opacity: selectedStyle.line!.opacity,
            }}
            onChange={(patch) => updateMark(selected, "line", patch)}
            fields={["color", "lineWidth", "opacity"]}
          />
          <MarkEditor
            title={t("graph.mark.fill")}
            mark="fill"
            value={(storedSelected.fill ?? {}) as MarkStyle}
            effective={{
              color: selectedStyle.fill!.color!,
              opacity: selectedStyle.fill!.opacity,
            }}
            onChange={(patch) => updateMark(selected, "fill", patch)}
            fields={["color", "opacity"]}
          />
        </div>
      </div>

      {/* Add-theme dialog — rendered inside the panel; the .sp-dialog-overlay
          is position:fixed so it covers the whole viewport regardless of
          this panel's local stacking context. */}
      {showAddDialog && (
        <AddPaletteDialog
          onSave={(p) => addPalette(p)}
          onClose={() => setShowAddDialog(false)}
        />
      )}

      {/* Right-click context menu for deleting a custom palette. Built-in
          STYLE_COLORS swatches don't open this — only entries in
          customPalettes can be deleted (since they're the only ones the
          user created). */}
      {paletteCtxMenu && (
        <div
          ref={ctxMenuRef}
          className="sp-ctx-menu"
          style={{ left: paletteCtxMenu.x, top: paletteCtxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div
            className="sp-ctx-item sp-ctx-danger"
            onClick={() => {
              removePalette(paletteCtxMenu.id);
              setPaletteCtxMenu(null);
            }}
          >
            {t("graph.style.removeTheme")}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Axis settings dialog ----------------------------------------------
// Opened by double-clicking either axis (or its label / title strip)
// inside <Graph>. Modelled after the system Preferences dialog: a
// fixed-width categories nav on the left and a scrollable detail pane on
// the right. The `axis` prop selects between Y (default categories: Axis
// / Tick Grid / Reference Lines) and X (Axis / Tick Grid / Reference
// Lines). Both axes share the same `AxisSettingsEditor`,
// `GridSettingsEditor`, AND `RefLinesEditor` since the override config
// shape is identical between them; only the dialog title, the absence
// of the Y-only auto-spec block, and the X/Y value-field name differ.

interface AxisSettingsDialogProps {
  /** Which axis this dialog edits. Controls the title, the i18n key
   *  prefix for category labels, and whether the auto-spec block is
   *  present (Y only — spec extras live on the response variable). */
  axis: "x" | "y";
  /** Existing manual reference lines on this axis. Y dialog passes
   *  `RefLineY[]`, X dialog passes `RefLineX[]`. The dialog itself
   *  never reads the value field — it just forwards the array to
   *  `RefLinesEditor`, which knows which field to address based on
   *  the `axis` prop. */
  refLines?: RefLineY[] | RefLineX[];
  setRefLines?: (next: RefLineY[] | RefLineX[]) => void;
  /** Whether the auto-spec-limits overlay is currently enabled. The
   *  toggle is global (one flag covers both axes) — the renderer
   *  contributes spec lines on whichever axis has a value-type column
   *  with `extras.spec` metadata. Passed down to the RefLinesEditor so
   *  its header checkbox renders the correct state without round-
   *  tripping through the project store. */
  autoSpecLines?: boolean;
  setAutoSpecLines?: (next: boolean) => void;
  /** Pre-resolved AutoSpec snapshot for the column currently bound to
   *  THIS axis — already filtered to finite values by
   *  GraphBuilderView. `undefined` means either the overlay is off,
   *  this axis has no bound column, or the bound column has no spec
   *  extras. */
  resolvedAutoSpec?: import("@/graphCore").AutoSpec | undefined;
  /** Name of the column currently bound to THIS axis, purely for the
   *  editor's hint copy ("Reading limits from <col>"). */
  autoSpecColName?: string | undefined;
  /** When > 0, this axis is carrying a multi-column melt and the
   *  auto-spec overlay (if enabled) will draw per-column ref lines
   *  instead of a single overlay. Used purely to clarify the hint
   *  copy so users understand WHY the toggle is producing lines even
   *  though no single column is bound. `0` (or `undefined`) means
   *  not in multi-mode. */
  multiValueColCount?: number;
  /** Current axis-override config (range / ticks / decimals / inverse /
   *  axis line / tick position / minor ticks / grid). Both axes use
   *  the same `YAxisConfig` shape. */
  axisConfig: YAxisConfig | undefined;
  setAxisConfig: (next: YAxisConfig | undefined) => void;
  onClose: () => void;
}

type AxisCategoryKey = "axis" | "tickGrid" | "refLines";

function AxisSettingsDialog({
  axis,
  refLines,
  setRefLines,
  autoSpecLines,
  setAutoSpecLines,
  resolvedAutoSpec,
  autoSpecColName,
  multiValueColCount,
  axisConfig,
  setAxisConfig,
  onClose,
}: AxisSettingsDialogProps) {
  const { t } = useTranslation();
  // Axis range / ticks / decimals / inverse is the more frequently
  // adjusted category, so it opens first.
  const [active, setActive] = useState<AxisCategoryKey>("axis");

  // The Axis + Tick Grid category labels are axis-neutral copy ("Axis",
  // "Tick Grid"), so we share the same translation keys under
  // `graph.yAxisSettings.*`. Only the dialog title and (Y-only)
  // Reference Lines label change with axis identity.
  const titleKey = axis === "y" ? "graph.yAxisSettings.title" : "graph.xAxisSettings.title";
  const titleFallback = axis === "y" ? "Y Axis Settings" : "X Axis Settings";

  const categories: { key: AxisCategoryKey; label: string }[] = [
    {
      key: "axis",
      label: t("graph.yAxisSettings.categoryAxis", { defaultValue: "Axis" }),
    },
    {
      key: "tickGrid",
      label: t("graph.yAxisSettings.categoryTickGrid", { defaultValue: "Tick Grid" }),
    },
    {
      key: "refLines",
      label: t("graph.yAxisSettings.categoryRefLines", { defaultValue: "Reference Lines" }),
    },
  ];

  return (
    <div className="sp-dialog-overlay" onClick={onClose}>
      <div
        className="sp-dialog sp-dialog-wide pref-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sp-dialog-title">
          {t(titleKey, { defaultValue: titleFallback })}
        </div>
        <div className="sp-dialog-body pref-body">
          <nav className="pref-nav">
            {categories.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`pref-nav-item${active === c.key ? " pref-nav-item-active" : ""}`}
                onClick={() => setActive(c.key)}
              >
                {c.label}
              </button>
            ))}
          </nav>
          <div className="pref-pane">
            {active === "axis" && (
              <AxisSettingsEditor config={axisConfig} setConfig={setAxisConfig} />
            )}
            {active === "tickGrid" && (
              <GridSettingsEditor config={axisConfig} setConfig={setAxisConfig} />
            )}
            {active === "refLines" && refLines && setRefLines && (
              <RefLinesEditor
                axis={axis}
                refLines={refLines}
                setRefLines={setRefLines}
                autoSpecLines={!!autoSpecLines}
                setAutoSpecLines={setAutoSpecLines}
                resolvedAutoSpec={resolvedAutoSpec}
                autoSpecColName={autoSpecColName}
                multiValueColCount={multiValueColCount}
              />
            )}
          </div>
        </div>
        <div className="sp-dialog-actions">
          <button className="sp-dialog-btn sp-dialog-btn-primary" onClick={onClose}>
            {t("prefs.done")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Axis range / ticks / decimals / inverse editor --------------------
// Form pane inside the AxisSettingsDialog's "Axis" category. Each row is
// label + value-input + auto-state indicator; an empty input means
// "auto", letting ECharts derive the value from the data range. The
// Reset to auto button clears every field in one click, restoring fully
// automatic axis behavior. Axis-agnostic — the same editor backs both
// the X and Y dialogs since the override config shape is identical.

interface AxisSettingsEditorProps {
  config: YAxisConfig | undefined;
  setConfig: (next: YAxisConfig | undefined) => void;
}

/** True when every field in the config is undefined — i.e. we're back to
 *  fully automatic. Used to disable the Reset button and to short-circuit
 *  the patch into a single `undefined` write (cleaner persisted state
 *  than `{}` lingering on every graph item). */
function isAxisConfigEmpty(c: YAxisConfig | undefined): boolean {
  if (!c) return true;
  return (
    c.min === undefined &&
    c.max === undefined &&
    c.tickInterval === undefined &&
    c.decimals === undefined &&
    (c.inverse === undefined || c.inverse === false) &&
    (c.minorTickCount === undefined || c.minorTickCount === 0) &&
    c.showAxisLine === undefined &&
    c.tickPosition === undefined &&
    c.showMajorGrid === undefined &&
    c.showMinorGrid === undefined &&
    isGridLineStyleEmpty(c.majorGridStyle) &&
    isGridLineStyleEmpty(c.minorGridStyle)
  );
}

/** A grid-line style is considered "empty" (= use theme default) when
 *  every field is undefined. Lets us normalize `{ style: { } }` back
 *  to `undefined` so the persisted state stays minimal. */
function isGridLineStyleEmpty(s: GridLineStyle | undefined): boolean {
  if (!s) return true;
  return s.color === undefined && s.width === undefined && s.style === undefined;
}

/** Free-form decimal text input. Uses `type="text"` (rather than
 *  `type="number"`) so the browser doesn't paint the spinner buttons
 *  and so intermediate keystrokes like "1." or "0." aren't silently
 *  rewritten back to the parsed integer by the controlled-input round
 *  trip. We mirror the on-screen text locally and only push valid
 *  positive numbers upstream; the upstream value is left untouched
 *  while the user is mid-typing. */
function DecimalTextInput({
  value,
  onChange,
  placeholder,
  className,
  ariaLabel,
}: {
  value: number | undefined;
  onChange: (n: number | undefined) => void;
  placeholder: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(value !== undefined ? String(value) : "");
  // Sync from the outside (e.g. Reset to auto wiping the parent value)
  // only when the current text no longer parses to the parent value.
  useEffect(() => {
    const trimmed = text.trim();
    const parsed = trimmed === "" ? undefined : Number(trimmed);
    if (parsed !== value) {
      setText(value !== undefined ? String(value) : "");
    }
    // We intentionally only react to external `value` changes; reading
    // `text` here is a snapshot, not a dependency we want to track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      type="text"
      inputMode="decimal"
      className={className}
      value={text}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        const trimmed = t.trim();
        if (trimmed === "") {
          onChange(undefined);
          return;
        }
        const n = Number(trimmed);
        // Only push valid positive values upstream. Intermediate states
        // like "1." or "-" leave the upstream value alone so the user
        // can keep typing without their progress getting reset.
        if (Number.isFinite(n) && n > 0) onChange(n);
      }}
    />
  );
}

function AxisSettingsEditor({ config, setConfig }: AxisSettingsEditorProps) {
  const { t } = useTranslation();
  const cfg = config ?? {};

  /** Patch one field at a time, then normalize an all-empty result back
   *  to `undefined` so we don't leave dead config objects on disk. */
  const patch = useCallback(
    (next: Partial<YAxisConfig>) => {
      const merged: YAxisConfig = { ...cfg, ...next };
      setConfig(isAxisConfigEmpty(merged) ? undefined : merged);
    },
    [cfg, setConfig],
  );

  /** Translate the <input type="number"> string into either a finite
   *  number or `undefined` (= auto). Empty / NaN / whitespace inputs all
   *  collapse to undefined so users can clear a field by erasing the
   *  number. */
  const parseNum = (s: string): number | undefined => {
    const trimmed = s.trim();
    if (trimmed === "") return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  };

  /** Same as parseNum but clamps to an integer within [min, max] —
   *  used by Decimals and Minor Ticks which only accept whole values. */
  const parseInt0 = (s: string, min: number, max: number): number | undefined => {
    const n = parseNum(s);
    if (n === undefined) return undefined;
    const i = Math.round(n);
    if (i < min) return min;
    if (i > max) return max;
    return i;
  };

  const resetAll = useCallback(() => {
    setConfig(undefined);
  }, [setConfig]);

  const empty = isAxisConfigEmpty(cfg);

  return (
    <div className="gb-axis-editor">
      <div className="gb-axis-header">
        <span className="gb-axis-title">
          {t("graph.axis.title", { defaultValue: "Axis" })}
        </span>
        <button
          type="button"
          className="gb-axis-reset"
          onClick={resetAll}
          disabled={empty}
          title={t("graph.axis.resetHint", {
            defaultValue: "Restore fully automatic axis behavior",
          })}
        >
          {t("graph.axis.reset", { defaultValue: "Reset to default" })}
        </button>
      </div>

      {/* Range: min + max on one row so users see them paired. Leaving
          either field blank means "auto" for that bound — the other end
          stays pinned. */}
      <div className="gb-axis-row">
        <label className="gb-axis-label">
          {t("graph.axis.range", { defaultValue: "Range" })}
        </label>
        <div className="gb-axis-range">
          <input
            type="number"
            className="gb-axis-num"
            value={cfg.min ?? ""}
            step="any"
            placeholder={t("graph.axis.auto", { defaultValue: "Auto" })}
            onChange={(e) => patch({ min: parseNum(e.target.value) })}
            aria-label={t("graph.axis.min", { defaultValue: "Min" })}
            title={t("graph.axis.min", { defaultValue: "Min" })}
          />
          <span className="gb-axis-range-sep">—</span>
          <input
            type="number"
            className="gb-axis-num"
            value={cfg.max ?? ""}
            step="any"
            placeholder={t("graph.axis.auto", { defaultValue: "Auto" })}
            onChange={(e) => patch({ max: parseNum(e.target.value) })}
            aria-label={t("graph.axis.max", { defaultValue: "Max" })}
            title={t("graph.axis.max", { defaultValue: "Max" })}
          />
        </div>
      </div>

      {/* Tick density: ECharts `interval` (exact value distance between
          adjacent major ticks). Float-friendly so users can pick e.g.
          0.5; we use a text-based input to avoid the spinner buttons
          and to keep intermediate keystrokes like "0." intact. */}
      <div className="gb-axis-row">
        <label className="gb-axis-label">
          {t("graph.axis.tickInterval", { defaultValue: "Tick interval" })}
        </label>
        <DecimalTextInput
          className="gb-axis-num gb-axis-num-narrow"
          value={cfg.tickInterval}
          placeholder={t("graph.axis.auto", { defaultValue: "Auto" })}
          ariaLabel={t("graph.axis.tickInterval", { defaultValue: "Tick interval" })}
          onChange={(n) => patch({ tickInterval: n })}
        />
      </div>

      {/* Decimal places: hard cap at 10 (more is meaningless on a chart
          axis). 0 is a valid value — show integers only. */}
      <div className="gb-axis-row">
        <label className="gb-axis-label">
          {t("graph.axis.decimals", { defaultValue: "Decimals" })}
        </label>
        <input
          type="number"
          className="gb-axis-num gb-axis-num-narrow"
          value={cfg.decimals ?? ""}
          step={1}
          min={0}
          max={10}
          placeholder={t("graph.axis.auto", { defaultValue: "Auto" })}
          onChange={(e) => patch({ decimals: parseInt0(e.target.value, 0, 10) })}
        />
      </div>

      {/* Minor tick count: number of sub-tick intervals between two
          major ticks (ECharts minorTick.splitNumber). 0 / empty turns
          minor ticks off — the default. Cap at 20 because any higher
          and the ticks merge visually. */}
      <div className="gb-axis-row">
        <label className="gb-axis-label">
          {t("graph.axis.minorTickCount", { defaultValue: "Minor ticks" })}
        </label>
        <input
          type="number"
          className="gb-axis-num gb-axis-num-narrow"
          value={cfg.minorTickCount ?? ""}
          step={1}
          min={0}
          max={20}
          placeholder={t("graph.axis.none", { defaultValue: "None" })}
          onChange={(e) => {
            const n = parseInt0(e.target.value, 0, 20);
            // 0 from the spinner means "off", same as empty — normalize
            // to undefined so isAxisConfigEmpty correctly recognizes it.
            patch({ minorTickCount: n && n > 0 ? n : undefined });
          }}
        />
      </div>

      {/* Inverse: simple checkbox — flips the axis so larger values sit
          at the bottom (useful for ranking charts, downward-better KPIs,
          etc.). */}
      <div className="gb-axis-row">
        <label className="gb-axis-label gb-axis-label-checkbox">
          <input
            type="checkbox"
            checked={cfg.inverse === true}
            onChange={(e) => patch({ inverse: e.target.checked ? true : undefined })}
          />
          <span>{t("graph.axis.inverse", { defaultValue: "Reverse axis direction" })}</span>
        </label>
      </div>

      {/* Axis boundary line + tick marks: a single combined toggle.
          Theme default is "visible" — checking the box leaves the line
          AND the tick marks visible and unlocks the Tick position
          selector below; unchecking hides both, since one without the
          other would leave the user looking at a dangling frame or
          floating tick marks. */}
      <div className="gb-axis-row">
        <label className="gb-axis-label gb-axis-label-checkbox">
          <input
            type="checkbox"
            checked={cfg.showAxisLine !== false}
            onChange={(e) =>
              patch({
                // Keep the field undefined when matching the theme default
                // (visible), so we don't leave dead overrides on disk.
                showAxisLine: e.target.checked ? undefined : false,
                // Hiding the axis line also makes the tick position
                // selector moot — clear it so it goes back to default.
                tickPosition: e.target.checked ? cfg.tickPosition : undefined,
              })
            }
          />
          <span>{t("graph.axis.showAxisLine", { defaultValue: "Show axis line & ticks" })}</span>
        </label>
      </div>

      {/* Tick position: only meaningful when the axis line is visible.
          Disable the radios when the line is hidden so the UI doesn't
          claim to do something it can't. */}
      <div className="gb-axis-row">
        <label className="gb-axis-label">
          {t("graph.axis.tickPosition", { defaultValue: "Tick position" })}
        </label>
        <div className="gb-axis-radio-group">
          {(["outside", "inside"] as const).map((pos) => {
            const checked = (cfg.tickPosition ?? "outside") === pos;
            const disabled = cfg.showAxisLine === false;
            return (
              <label
                key={pos}
                className={`gb-axis-radio${disabled ? " gb-axis-radio-disabled" : ""}`}
              >
                <input
                  type="radio"
                  name="gb-axis-tick-pos"
                  value={pos}
                  checked={checked}
                  disabled={disabled}
                  onChange={() =>
                    patch({
                      // Outside is the theme default — store undefined for it
                      // so all-default state collapses back to no override.
                      tickPosition: pos === "outside" ? undefined : "inside",
                    })
                  }
                />
                <span>
                  {pos === "outside"
                    ? t("graph.axis.tickOutside", { defaultValue: "Outside" })
                    : t("graph.axis.tickInside", { defaultValue: "Inside" })}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---- Axis grid (split-line) editor -------------------------------------
// Form pane inside the AxisSettingsDialog's "Tick Grid" category.
// Controls both the major split-lines (rendered at major ticks — the
// usual gridlines) and the minor split-lines (rendered at
// every minor tick when minor ticks are enabled in the Axis category).
// Each row is a Show checkbox plus a small style strip: color picker,
// dash dropdown, width input. Leaving the style fields empty means "use
// theme default" for that particular sub-field.

interface GridSettingsEditorProps {
  config: YAxisConfig | undefined;
  setConfig: (next: YAxisConfig | undefined) => void;
}

/** Default style displayed in the picker / dropdowns when the user
 *  hasn't customized that gridline yet. Pulled from CSS variables would
 *  be ideal, but we want stable hex values for the color picker so we
 *  hardcode the muted gray ECharts/our theme would use anyway. */
// Per-section theme defaults. Must mirror buildAxisCommon() in
// graphCore/theme.ts — the major split-line picks the darker shade
// so it reads as more prominent than the lighter minor split-line.
// We mirror the constants here (instead of importing from the theme
// module) so the picker / preset comparison stays a pure constant
// expression and doesn't depend on the live theme object the renderer
// uses; the two defaults will normally be the same, but in a custom
// theme override the picker still defaults to these well-known hexes
// rather than a runtime CSS variable.
const GRID_LINE_DEFAULT_COLOR_MAJOR = "#bdbdbd";
const GRID_LINE_DEFAULT_COLOR_MINOR = "#e2e2e2";
const GRID_LINE_DEFAULT_WIDTH = 1;
const GRID_LINE_DEFAULT_STYLE: RefLineStyle = "dashed";

/** Preset color palette for gridlines. Gridlines are usually meant to
 *  be quiet background structure, so the strip leads with the muted
 *  grays (the theme default sits at index 0) and only then exposes a
 *  handful of accent colors for users who want a more deliberate look.
 *  A custom hex is still available via the trailing color picker. */
const GRID_LINE_PRESETS: readonly string[] = [
  "#e2e2e2", // light gray (theme default)
  "#bdbdbd", // medium gray
  "#757575", // dark gray
  "#000000", // black
  "#4a6cf7", // blue accent
  "#2ca678", // green accent
  "#ef8a3a", // orange accent
  "#e74c3c", // red accent
];

/** Paired (major, minor) color themes for the gridline color theme
 *  picker at the top of the Tick Grid editor. Each entry assigns a
 *  darker shade to the major gridline and a lighter shade to the minor
 *  one so a chart that shows both gridlines simultaneously reads as
 *  two distinct grid layers instead of one uniform pattern.
 *
 *  Slot 0 MUST match the section defaults declared above so picking
 *  the leading swatch effectively "resets" both colors back to the
 *  theme default (we write `undefined` for both colors in that case
 *  to keep the persisted config minimal). The rest run through a small
 *  spectrum of useful accents — a click recolors both gridlines at
 *  once while preserving the user's per-section width and dash. */
const GRID_LINE_THEMES: readonly { major: string; minor: string }[] = [
  { major: GRID_LINE_DEFAULT_COLOR_MAJOR, minor: GRID_LINE_DEFAULT_COLOR_MINOR }, // gray (default)
  { major: "#757575", minor: "#bdbdbd" }, // dark gray
  { major: "#455a64", minor: "#b0bec5" }, // slate
  { major: "#1976d2", minor: "#bbdefb" }, // blue
  { major: "#2e7d32", minor: "#c8e6c9" }, // green
  { major: "#f57c00", minor: "#ffe0b2" }, // orange
  { major: "#c62828", minor: "#ffcdd2" }, // red
  { major: "#6a1b9a", minor: "#e1bee7" }, // purple
];

function GridSettingsEditor({ config, setConfig }: GridSettingsEditorProps) {
  const { t } = useTranslation();
  const cfg = config ?? {};

  /** Patch one or more fields on the root config, normalizing the
   *  result back to `undefined` when it ends up fully empty. Used by
   *  the Show checkboxes and by the per-style updater below. */
  const patch = useCallback(
    (next: Partial<YAxisConfig>) => {
      const merged: YAxisConfig = { ...cfg, ...next };
      setConfig(isAxisConfigEmpty(merged) ? undefined : merged);
    },
    [cfg, setConfig],
  );

  /** Patch a single sub-field on either `majorGridStyle` or
   *  `minorGridStyle`. When the resulting style object is fully empty
   *  we collapse it back to `undefined` so we don't leave dead
   *  `{ }` style objects on the persisted config. */
  const patchStyle = useCallback(
    (which: "major" | "minor", next: Partial<GridLineStyle>) => {
      const key = which === "major" ? "majorGridStyle" : "minorGridStyle";
      const cur = (which === "major" ? cfg.majorGridStyle : cfg.minorGridStyle) ?? {};
      const merged: GridLineStyle = { ...cur, ...next };
      patch({ [key]: isGridLineStyleEmpty(merged) ? undefined : merged } as Partial<YAxisConfig>);
    },
    [cfg.majorGridStyle, cfg.minorGridStyle, patch],
  );

  const resetAll = useCallback(() => {
    patch({
      showMajorGrid: undefined,
      showMinorGrid: undefined,
      majorGridStyle: undefined,
      minorGridStyle: undefined,
    });
  }, [patch]);

  /** Apply a paired (major, minor) color theme. Only the `color`
   *  sub-field on each section is touched — width and dash overrides
   *  the user picked earlier are preserved. Picking the default theme
   *  collapses the color back to `undefined` so the persisted style
   *  doesn't carry a redundant explicit hex. */
  const applyGridTheme = useCallback(
    (themeIdx: number) => {
      const theme = GRID_LINE_THEMES[themeIdx];
      if (!theme) return;
      const isDefault = themeIdx === 0;
      const writeColor = (
        cur: GridLineStyle | undefined,
        nextColor: string,
      ): GridLineStyle | undefined => {
        const merged: GridLineStyle = {
          ...(cur ?? {}),
          color: isDefault ? undefined : nextColor,
        };
        return isGridLineStyleEmpty(merged) ? undefined : merged;
      };
      patch({
        majorGridStyle: writeColor(cfg.majorGridStyle, theme.major),
        minorGridStyle: writeColor(cfg.minorGridStyle, theme.minor),
      });
    },
    [cfg.majorGridStyle, cfg.minorGridStyle, patch],
  );

  /** True when every grid-related override is back to default. Used to
   *  disable the Reset button — same UX pattern as the Axis editor. */
  const gridEmpty =
    cfg.showMajorGrid === undefined &&
    cfg.showMinorGrid === undefined &&
    isGridLineStyleEmpty(cfg.majorGridStyle) &&
    isGridLineStyleEmpty(cfg.minorGridStyle);

  /** Render one (Show, style) section. Major and minor are visually
   *  identical so we factor the section to avoid drift between them. */
  const renderGridSection = (which: "major" | "minor") => {
    const isMajor = which === "major";
    // Theme defaults: BOTH major and minor gridlines are hidden out of
    // the box (see theme.ts's splitLine/minorSplitLine `show:false`).
    // The checkbox must reflect that or else it will display "checked"
    // on a chart that's actually showing nothing — and any toggle the
    // user makes will be erased by the `nextShown === defaultShown ?
    // undefined : nextShown` shortcut below, which would silently
    // refuse to persist a `true`.
    const shown = isMajor
      ? (cfg.showMajorGrid ?? false)
      : (cfg.showMinorGrid ?? false);
    const style = (isMajor ? cfg.majorGridStyle : cfg.minorGridStyle) ?? {};
    // Per-section default color: major picks the darker swatch so the
    // two sections are visually distinguishable when both are on. We
    // capture the section's default here once and reuse it for the
    // "swatch selected" check and the "persist as undefined when the
    // user picks the default" logic below.
    const defaultColor = isMajor
      ? GRID_LINE_DEFAULT_COLOR_MAJOR
      : GRID_LINE_DEFAULT_COLOR_MINOR;
    const color = style.color ?? defaultColor;
    const width = style.width ?? GRID_LINE_DEFAULT_WIDTH;
    const dash = style.style ?? GRID_LINE_DEFAULT_STYLE;
    // When the section is hidden, the style controls are visually
    // dimmed and disabled because they have no effect on a hidden grid.
    return (
      <div className={`gb-grid-section${shown ? "" : " gb-grid-section-off"}`}>
        <label className="gb-axis-label-checkbox gb-grid-section-toggle">
          <input
            type="checkbox"
            checked={shown}
            onChange={(e) => {
              // Both major and minor are hidden by theme default, so an
              // unchecked checkbox matches the default → persist as
              // undefined (keeps the saved config minimal). A checked
              // checkbox always needs an explicit `true` override so the
              // transform-layer `buildAxisOverrides` emits a splitLine
              // fragment that flips `show:false` back to `true`.
              const defaultShown = false;
              const nextShown = e.target.checked;
              const fieldName = isMajor ? "showMajorGrid" : "showMinorGrid";
              patch({
                [fieldName]: nextShown === defaultShown ? undefined : nextShown,
              } as Partial<YAxisConfig>);
            }}
          />
          <span className="gb-grid-section-label">
            {isMajor
              ? t("graph.grid.showMajor", { defaultValue: "Major gridlines" })
              : t("graph.grid.showMinor", { defaultValue: "Minor gridlines" })}
          </span>
        </label>

        <div className="gb-grid-style-row">
          {/* Preset color strip + custom picker. Muted grays up front
              (gridlines should usually fade into the chrome) followed
              by a few accent hues for users who want something bolder.
              The trailing color picker is the escape hatch for any
              exact hex. Mirrors the Reference Lines color UI so the
              two editors feel consistent. */}
          <div className="gb-refline-swatch-row gb-grid-swatch-row">
            {GRID_LINE_PRESETS.map((preset) => {
              const selected =
                (style.color ?? defaultColor).toLowerCase() ===
                preset.toLowerCase();
              return (
                <button
                  key={preset}
                  type="button"
                  className={`gb-refline-swatch${selected ? " gb-refline-swatch-selected" : ""}`}
                  style={{ background: preset }}
                  disabled={!shown}
                  // Storing the per-section default color back as
                  // `undefined` keeps the persisted style minimal —
                  // picking the section's default swatch effectively
                  // "resets" the color.
                  onClick={() =>
                    patchStyle(which, {
                      color: preset === defaultColor ? undefined : preset,
                    })
                  }
                  title={preset}
                  aria-label={preset}
                  aria-pressed={selected}
                />
              );
            })}
            <span className="gb-refline-swatch-divider" />
            <input
              type="color"
              className={`gb-refline-color-picker${
                !GRID_LINE_PRESETS.some(
                  (p) => p.toLowerCase() === color.toLowerCase(),
                )
                  ? " gb-refline-color-picker-active"
                  : ""
              }`}
              value={color}
              disabled={!shown}
              onChange={(e) =>
                patchStyle(which, {
                  color: e.target.value === defaultColor ? undefined : e.target.value,
                })
              }
              title={t("graph.refLine.customColor", { defaultValue: "Custom color" })}
              aria-label={t("graph.refLine.customColor", { defaultValue: "Custom color" })}
            />
          </div>

          {/* Dash + width row: no color control here anymore — the swatch
              strip above is the canonical color picker. */}
          <div className="gb-grid-line-row">
            <select
              className="gb-grid-dash"
              value={dash}
              disabled={!shown}
              onChange={(e) => patchStyle(which, { style: e.target.value as RefLineStyle })}
              title={t("graph.grid.style", { defaultValue: "Line style" })}
              aria-label={t("graph.grid.style", { defaultValue: "Line style" })}
            >
              <option value="solid">{t("graph.refLine.styleSolid", { defaultValue: "Solid" })}</option>
              <option value="dashed">{t("graph.refLine.styleDashed", { defaultValue: "Dashed" })}</option>
              <option value="dotted">{t("graph.refLine.styleDotted", { defaultValue: "Dotted" })}</option>
            </select>
            <input
              type="number"
              className="gb-grid-width"
              value={width}
              disabled={!shown}
              min={0.5}
              max={5}
              step={0.5}
              onChange={(e) => {
                const n = Number(e.target.value);
                patchStyle(which, {
                  width: Number.isFinite(n) && n > 0 ? n : undefined,
                });
              }}
              title={t("graph.grid.width", { defaultValue: "Width" })}
              aria-label={t("graph.grid.width", { defaultValue: "Width" })}
            />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="gb-axis-editor">
      <div className="gb-axis-header">
        <span className="gb-axis-title">
          {t("graph.grid.title", { defaultValue: "Tick Grid" })}
        </span>
        <button
          type="button"
          className="gb-axis-reset"
          onClick={resetAll}
          disabled={gridEmpty}
          title={t("graph.grid.resetHint", {
            defaultValue: "Restore default grid display",
          })}
        >
          {t("graph.axis.reset", { defaultValue: "Reset to default" })}
        </button>
      </div>

      {/* Color theme — one-click recolor of both major and minor
          gridlines. Each swatch is a 2-band horizontal gradient where
          the left half is the major color and the right half is the
          minor color, so users can preview the pair before applying.
          Selection is detected against the resolved (override-or-
          default) color of each section so the leading default swatch
          highlights for a clean / unmodified config. */}
      <div
        className="gb-grid-theme-row"
        title={t("graph.grid.themeHint", {
          defaultValue: "Set major and minor gridline colors at once",
        })}
      >
        <span className="gb-grid-theme-label">
          {t("graph.grid.theme", { defaultValue: "Theme" })}
        </span>
        <div className="gb-grid-theme-swatches">
          {GRID_LINE_THEMES.map((theme, i) => {
            const majorCur = (
              cfg.majorGridStyle?.color ?? GRID_LINE_DEFAULT_COLOR_MAJOR
            ).toLowerCase();
            const minorCur = (
              cfg.minorGridStyle?.color ?? GRID_LINE_DEFAULT_COLOR_MINOR
            ).toLowerCase();
            const selected =
              majorCur === theme.major.toLowerCase() &&
              minorCur === theme.minor.toLowerCase();
            const bg = `linear-gradient(90deg, ${theme.major} 0 50%, ${theme.minor} 50% 100%)`;
            return (
              <button
                key={i}
                type="button"
                className={`gb-refline-swatch${selected ? " gb-refline-swatch-selected" : ""}`}
                style={{ background: bg }}
                title={`${theme.major} / ${theme.minor}`}
                aria-label={`${theme.major} / ${theme.minor}`}
                aria-pressed={selected}
                onClick={() => applyGridTheme(i)}
              />
            );
          })}
        </div>
      </div>

      {renderGridSection("major")}
      {renderGridSection("minor")}

      <div className="gb-grid-hint">
        {t("graph.grid.minorHint", {
          defaultValue:
            "Minor gridlines require at least one minor tick. Set Minor ticks in the Axis tab first.",
        })}
      </div>
    </div>
  );
}

// ---- Reference lines editor -------------------------------------------
// Card-per-line editor used inside the AxisSettingsDialog's right pane.
// Axis-agnostic: the `axis` prop picks whether each card edits the Y
// value (`RefLineY.y`, horizontal marker on the Y axis) or the X value
// (`RefLineX.x`, vertical marker on the X axis). The auto-spec block is
// Y-only because spec extras (LSL / Target / USL) live on the response
// variable column bound to Y. The chart (transform.ts -> buildRefLines-
// Carrier) attaches the rendered markLines to an invisible scatter
// series so every chart type benefits, and silently skips lines whose
// axis is currently categorical (no meaningful position there — the
// lines are preserved in the spec and reappear when the axis becomes
// value-type again, e.g. after a Swap X & Y).

interface RefLinesEditorProps {
  /** Which axis this editor targets. Picks the value-field name
   *  (`y` or `x`) used to read / write each card, the i18n copy
   *  (horizontal vs. vertical marker), and whether the Y-only
   *  auto-spec-limits block is rendered. */
  axis: "x" | "y";
  refLines: RefLineY[] | RefLineX[];
  setRefLines: (next: RefLineY[] | RefLineX[]) => void;
  /** When true, the chart auto-draws red (LSL/USL) and green (Target)
   *  reference lines based on the bound column's `spec` extras. The
   *  toggle is global — enabling it surfaces spec lines on whichever
   *  axis (or both) has a value-type column carrying spec metadata. */
  autoSpecLines?: boolean;
  setAutoSpecLines?: (next: boolean) => void;
  /** Pre-resolved spec snapshot for the column bound to THIS axis. */
  resolvedAutoSpec?: import("@/graphCore").AutoSpec | undefined;
  /** Name of the column bound to THIS axis — used in the helper hint. */
  autoSpecColName?: string | undefined;
  /** Number of source columns contributing per-column spec lines on
   *  THIS axis when a multi-column melt is active. > 0 switches the
   *  auto-spec hint into multi-column mode; 0 / undefined means the
   *  axis carries at most one bound column. */
  multiValueColCount?: number;
}

/** Saturated / primary-color palette for reference lines. The chart's
 *  GROUP_COLORS palette intentionally uses *muted* hues so data series
 *  read as natural; ref lines (spec limits, targets, control bounds)
 *  need to *visually stand out* against that data, so we offer a parallel
 *  palette of high-saturation pure-ish colors. Users can still pick any
 *  custom color via the trailing color picker. */
const REF_LINE_PRESETS: readonly string[] = [
  "#E60000", // pure red
  "#FF6F00", // vivid orange
  "#FFC400", // amber / gold
  "#76FF03", // lime
  "#00C853", // vivid green
  "#00B0FF", // vivid cyan
  "#2962FF", // vivid blue
  "#6200EA", // deep purple
  "#D500F9", // vivid magenta
  "#000000", // black
];

/** Default color for a freshly-added reference line. First preset \u2014
 *  high-contrast red so the new line is immediately visible against any
 *  background or chart palette. */
const REF_LINE_DEFAULT_COLOR = REF_LINE_PRESETS[0];

/** Mint a stable, collision-resistant id for a new ref line. Using a
 *  timestamp + a per-render counter avoids the React-list-key churn we'd
 *  see if we recycled array indexes. */
let _refLineSeq = 0;
function nextRefLineId(): string {
  _refLineSeq += 1;
  return `rl-${Date.now().toString(36)}-${_refLineSeq}`;
}

function RefLinesEditor({
  axis,
  refLines,
  setRefLines,
  autoSpecLines,
  setAutoSpecLines,
  resolvedAutoSpec,
  autoSpecColName,
  multiValueColCount,
}: RefLinesEditorProps) {
  const { t } = useTranslation();
  // Axis indirection: `valueField` picks which field on each card we
  // read / write. Kept as a single source of truth so the rest of this
  // component never branches on `axis` for data access — only for copy
  // (horizontal vs. vertical marker) and for the Y-only auto-spec block.
  const valueField: "x" | "y" = axis === "x" ? "x" : "y";
  // Cast helpers: at runtime each line is either RefLineY (axis="y")
  // or RefLineX (axis="x"); we treat them uniformly via the indirection.
  // The cast keeps the read/write call sites concise without leaking
  // `any` through the public API surface.
  const readValue = (r: RefLineY | RefLineX): number =>
    (r as Record<string, number>)[valueField];
  const writeValue = (n: number): Record<string, number> => ({ [valueField]: n });

  const addLine = useCallback(() => {
    // Build the new line using the axis-appropriate value field so
    // RefLineY gets `{y:0}` and RefLineX gets `{x:0}`. Cast to the
    // declared union after construction.
    const next = {
      id: nextRefLineId(),
      [valueField]: 0,
      label: "",
      style: "dashed" as RefLineStyle,
      color: REF_LINE_DEFAULT_COLOR,
      width: 1,
    } as RefLineY | RefLineX;
    setRefLines([...(refLines ?? []), next] as RefLineY[] | RefLineX[]);
  }, [refLines, setRefLines, valueField]);

  const updateLine = useCallback(
    (id: string, patch: Partial<RefLineY> | Partial<RefLineX>) => {
      setRefLines(
        ((refLines ?? []) as (RefLineY | RefLineX)[]).map((r) =>
          r.id === id ? ({ ...r, ...patch } as RefLineY | RefLineX) : r,
        ) as RefLineY[] | RefLineX[],
      );
    },
    [refLines, setRefLines],
  );

  const removeLine = useCallback(
    (id: string) => {
      setRefLines(
        ((refLines ?? []) as (RefLineY | RefLineX)[]).filter((r) => r.id !== id) as RefLineY[] | RefLineX[],
      );
    },
    [refLines, setRefLines],
  );

  const lines = (refLines ?? []) as (RefLineY | RefLineX)[];

  // Auto-spec preview state. We render up to three chips (LSL / Target
  // / USL) mirroring the colors the chart will use. When the toggle is
  // on but no limits resolve, the hint copy explains why. Available on
  // BOTH axes: whichever axis has a value-type column carrying
  // `extras.spec` metadata gets its own overlay snapshot.
  const autoChips: { key: "lsl" | "target" | "usl"; value: number; color: string; label: string }[] = [];
  if (autoSpecLines && resolvedAutoSpec) {
    if (resolvedAutoSpec.lsl !== undefined) {
      autoChips.push({ key: "lsl", value: resolvedAutoSpec.lsl, color: "#E60000", label: "LSL" });
    }
    if (resolvedAutoSpec.target !== undefined) {
      autoChips.push({ key: "target", value: resolvedAutoSpec.target, color: "#00C853", label: "Target" });
    }
    if (resolvedAutoSpec.usl !== undefined) {
      autoChips.push({ key: "usl", value: resolvedAutoSpec.usl, color: "#E60000", label: "USL" });
    }
  }

  // Axis-aware copy used in the auto-spec hint. The toggle reads
  // "Auto-show spec limits" identically on both axes — the difference
  // is just which column the limits are sourced from ("the Y column" /
  // "the X column"), surfaced in the contextual hint below.
  const axisColCopy = axis === "y" ? "Y" : "X";

  return (
    <div className="gb-refline-editor">
      {/* Auto spec-limit toggle. Available on both axes: when on, the
          chart reads LSL / Target / USL from THIS axis's bound column
          (via its `extras.spec` metadata) and overlays red / green
          dashed lines. The toggle itself is global — flipping it on
          either dialog activates the overlay everywhere applicable. */}
      {setAutoSpecLines && (
        <div className="gb-refline-auto-block">
          <label className="gb-refline-auto-toggle">
            <input
              type="checkbox"
              checked={!!autoSpecLines}
              onChange={(e) => setAutoSpecLines(e.target.checked)}
            />
            <span>{t("graph.refLine.autoSpec", { defaultValue: "Auto-show spec limits" })}</span>
          </label>
          <div className="gb-refline-auto-hint">
            {autoSpecLines
              ? (multiValueColCount && multiValueColCount > 0)
                ? t("graph.refLine.autoSpecMulti", {
                    defaultValue: "Drawing per-column spec lines from {{n}} multi-mode columns.",
                    n: multiValueColCount,
                  })
                : autoChips.length > 0
                ? t("graph.refLine.autoSpecActive", {
                    defaultValue: "Reading limits from {{col}}.",
                    col: autoSpecColName ?? "",
                  })
                : autoSpecColName
                  ? t("graph.refLine.autoSpecMissing", {
                      defaultValue: "The {{axis}} column \"{{col}}\" has no spec extras (LSL / Target / USL).",
                      axis: axisColCopy,
                      col: autoSpecColName,
                    })
                  : t("graph.refLine.autoSpecNoCol", {
                      defaultValue: "Drop a column on {{axis}} to read its spec limits.",
                      axis: axisColCopy,
                    })
              : (multiValueColCount && multiValueColCount > 0)
                ? t("graph.refLine.autoSpecHintMulti", {
                    defaultValue: "Read each multi-mode column's LSL / Target / USL and overlay them as per-column reference lines on the {{axis}} axis.",
                    axis: axisColCopy,
                  })
                : t("graph.refLine.autoSpecHint", {
                    defaultValue: "Read LSL / Target / USL from the {{axis}} column's spec extras and overlay them as colored reference lines.",
                    axis: axisColCopy,
                  })}
          </div>
          {autoChips.length > 0 && (
            <div className="gb-refline-auto-chips">
              {autoChips.map((c) => (
                <span
                  key={c.key}
                  className="gb-refline-auto-chip"
                  style={{ borderColor: c.color, color: c.color }}
                  title={`${c.label} = ${c.value}`}
                >
                  <span className="gb-refline-auto-chip-dash" style={{ background: c.color }} />
                  {c.label} = {c.value}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Section header: title + Add button. Title sits flush with the
          pane padding so it reads as a normal settings-pane section. */}
      <div className="gb-refline-header">
        <span className="gb-refline-title">
          {t("graph.refLine.title", { defaultValue: "Reference Lines" })}
        </span>
        <button
          type="button"
          className="gb-refline-add"
          onClick={addLine}
        >
          + {t("graph.refLine.add", { defaultValue: "Add reference line" })}
        </button>
      </div>

      {lines.length === 0 ? (
        <div className="gb-refline-empty">
          {axis === "y"
            ? t("graph.refLine.emptyY", {
                defaultValue: "No reference lines yet. Click \u201cAdd reference line\u201d to draw a horizontal marker on the Y axis.",
              })
            : t("graph.refLine.emptyX", {
                defaultValue: "No reference lines yet. Click \u201cAdd reference line\u201d to draw a vertical marker on the X axis.",
              })}
        </div>
      ) : (
        <div className="gb-refline-list">
          {lines.map((r) => {
            const currentHex = normalizeHex(r.color);
            // A color is "custom" when it doesn't match any preset — in
            // that case we highlight the picker swatch instead of a
            // preset chip so the user can see at a glance that this
            // card is on a user-defined color.
            const isCustom = !REF_LINE_PRESETS.some(
              (p) => p.toLowerCase() === currentHex.toLowerCase(),
            );
            return (
              <div key={r.id} className="gb-refline-card">
                {/* Preset color strip + free color picker. Saturated
                    presets up front so users get a one-click contrast
                    choice; the picker at the end is the escape hatch
                    for any exact hex. */}
                <div className="gb-refline-swatch-row">
                  {REF_LINE_PRESETS.map((preset) => {
                    const selected = preset.toLowerCase() === currentHex.toLowerCase();
                    return (
                      <button
                        key={preset}
                        type="button"
                        className={`gb-refline-swatch${selected ? " gb-refline-swatch-selected" : ""}`}
                        style={{ background: preset }}
                        onClick={() => updateLine(r.id, { color: preset })}
                        title={preset}
                        aria-label={preset}
                        aria-pressed={selected}
                      />
                    );
                  })}
                  <span className="gb-refline-swatch-divider" />
                  <input
                    type="color"
                    className={`gb-refline-color-picker${isCustom ? " gb-refline-color-picker-active" : ""}`}
                    value={currentHex}
                    onChange={(e) => updateLine(r.id, { color: e.target.value })}
                    title={t("graph.refLine.customColor", { defaultValue: "Custom color" })}
                  />
                </div>

                {/* Form row: label / Y / style / width / remove. */}
                <div className="gb-refline-form-row">
                  <input
                    type="text"
                    className="gb-refline-label-input"
                    value={r.label}
                    placeholder={t("graph.refLine.label", { defaultValue: "Label" })}
                    onChange={(e) => updateLine(r.id, { label: e.target.value })}
                  />
                  <input
                    type="number"
                    className="gb-refline-num"
                    value={Number.isFinite(readValue(r)) ? readValue(r) : 0}
                    step="any"
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      updateLine(r.id, writeValue(Number.isFinite(n) ? n : 0));
                    }}
                  />
                  <select
                    className="gb-refline-style"
                    value={r.style}
                    onChange={(e) => updateLine(r.id, { style: e.target.value as RefLineStyle })}
                  >
                    <option value="solid">{t("graph.refLine.styleSolid", { defaultValue: "Solid" })}</option>
                    <option value="dashed">{t("graph.refLine.styleDashed", { defaultValue: "Dashed" })}</option>
                    <option value="dotted">{t("graph.refLine.styleDotted", { defaultValue: "Dotted" })}</option>
                  </select>
                  <input
                    type="number"
                    className="gb-refline-width"
                    value={r.width}
                    min={1}
                    max={10}
                    step={0.5}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      updateLine(r.id, { width: Number.isFinite(n) && n > 0 ? n : 1 });
                    }}
                  />
                  <button
                    type="button"
                    className="gb-refline-remove"
                    onClick={() => removeLine(r.id)}
                    title={t("graph.refLine.remove", { defaultValue: "Remove" })}
                    aria-label={t("graph.refLine.remove", { defaultValue: "Remove" })}
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Coerce a stored color to a strict #RRGGBB form so <input type="color">
 *  doesn't fall back to #000000 on shorthand / named colors. */
function normalizeHex(c: string | undefined): string {
  if (!c) return "#888888";
  const s = c.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const r = s[1], g = s[2], b = s[3];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return "#888888";
}

/** Categorical palette for legend defaults — must match DEFAULT_CATEGORICAL
 *  in graphCore/theme.ts. Sorted by contrast: vivid hues first, muted/gray
 *  last, so auto-assigned legend colors stay maximally distinct. */
const GROUP_COLORS = [
  "#4a6cf7", "#ef8a3a", "#2ca678", "#e74c3c", // blue / orange / green / red
  "#9168d6", "#c4ad36", "#d56cb1", "#3aa6b9", // purple / yellow / pink / teal
  "#5d8aa8", "#8c6e3a", "#b87333", "#7f8c8d", // slate / brown / copper / gray
];

/** Build the fully-resolved per-group style map handed to the renderer
 *  (`spec.styles`) and to the legend swatches.
 *
 *  Resolution rules (in priority order):
 *    1. Any explicit per-mark override the user has set (Line/Fill/Point)
 *       wins for that mark.
 *    2. For unset marks, when grouped:
 *       a) Use the user's saved CustomPalettes for the first N groups
 *          (so users get THEIR favourite colors before falling back to
 *          the built-in palette). Palette.point/line/fill map straight
 *          onto the three sub-marks.
 *       b) Beyond that, derive shades from GROUP_COLORS — but offset
 *          the index by the palette count so the first un-palette group
 *          still gets the highest-contrast built-in color.
 *    3. When not grouped (single DEFAULT_GROUP_KEY), fill with the JMP
 *       look: black line/point, transparent fill — EXCEPT for boxplot
 *       layers where the box body IS the primary mark, so we substitute
 *       a neutral grey (matching transform.ts' `neutralBoxFill`).
 *
 *  The returned map is ALWAYS fully populated for every key in
 *  `groupKeys` — every entry has line/fill/point objects with all
 *  required sub-fields. The legend swatches and the STYLE editor depend
 *  on that contract; falling through to `undefined` crashes the
 *  editor's `selectedStyle.line.color` lookup. */
function buildEffectiveStyles(
  groupKeys: string[],
  userStyles: GroupStyleMap,
  customPalettes: CustomPalette[],
  isGrouped: boolean,
  hasBoxplot: boolean,
): GroupStyleMap {
  const out: GroupStyleMap = { ...userStyles };
  groupKeys.forEach((key, idx) => {
    let autoLine: MarkStyle;
    let autoFill: MarkStyle;
    let autoPoint: MarkStyle;
    if (!isGrouped) {
      // Ungrouped: JMP look. baseColor='#000000' here mirrors
      // resolveGroupStyle() in transform.ts so the chart and the
      // editor swatches stay in lockstep.
      autoLine = { color: "#000000", lineWidth: 1.5, opacity: 1 };
      autoFill = {
        color: hasBoxplot ? shade("#000000", SHADE_RATIO_FILL) : "transparent",
        opacity: 1,
      };
      autoPoint = { color: "#000000", fillColor: "#000000", marker: "circle", markerSize: 4, opacity: 1 };
    } else if (idx < customPalettes.length) {
      const p = customPalettes[idx];
      autoLine = { color: p.line, lineWidth: 1.5, opacity: 1 };
      autoFill = { color: p.fill, opacity: 1 };
      autoPoint = { color: p.point, fillColor: p.point, marker: "circle", markerSize: 4, opacity: 1 };
    } else {
      const fallbackIdx = (idx - customPalettes.length) % GROUP_COLORS.length;
      const base = GROUP_COLORS[fallbackIdx];
      autoLine = { color: shade(base, SHADE_RATIO_LINE), lineWidth: 1.5, opacity: 1 };
      autoFill = { color: shade(base, SHADE_RATIO_FILL), opacity: 1 };
      autoPoint = {
        color: shade(base, SHADE_RATIO_POINT),
        fillColor: shade(base, SHADE_RATIO_POINT),
        marker: "circle",
        markerSize: 4,
        opacity: 1,
      };
    }
    const user = userStyles[key];
    out[key] = {
      line: user?.line ?? autoLine,
      fill: user?.fill ?? autoFill,
      point: user?.point ?? autoPoint,
    };
  });
  return out;
}

/** Composite swatch: combines line + fill rect + point so the user sees
 *  exactly what the three sub-marks of this group will look like. */
function CompositeSwatch({ style }: { style: GroupStyle }) {
  const w = 36, h = 14;
  const cy = h / 2;
  const lineColor = style.line?.color ?? "#000";
  const lineWidth = style.line?.lineWidth ?? 1.5;
  const lineOpacity = style.line?.opacity ?? 1;
  const fillColor = style.fill?.color ?? "transparent";
  const fillOpacity = style.fill?.opacity ?? 1;
  const pointColor = style.point?.color ?? "#000";
  const pointFill = style.point?.fillColor ?? pointColor;
  const pointMarker: MarkerShape = style.point?.marker ?? "circle";
  const pointSize = style.point?.markerSize ?? 4;
  const pointOpacity = style.point?.opacity ?? 1;
  const r = Math.max(2, Math.min(5, pointSize / 2));
  const isHollow = pointMarker.startsWith("empty");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      {/* fill rect (left third) */}
      <rect x={2} y={3} width={8} height={8} fill={fillColor} fillOpacity={fillOpacity} stroke={lineColor} strokeWidth={lineWidth} strokeOpacity={lineOpacity} />
      {/* line (middle) */}
      <line x1={12} y1={cy} x2={24} y2={cy} stroke={lineColor} strokeWidth={lineWidth} opacity={lineOpacity} />
      {/* point (right) */}
      <circle cx={30} cy={cy} r={r} fill={isHollow ? "transparent" : pointFill} stroke={pointColor} strokeWidth={1} opacity={pointOpacity} />
    </svg>
  );
}

interface MarkEditorProps {
  title: string;
  mark: "line" | "fill" | "point";
  value: MarkStyle;
  effective: { color: string; lineWidth?: number; markerSize?: number; opacity?: number; marker?: MarkerShape };
  onChange: (patch: Partial<MarkStyle>) => void;
  fields: Array<"color" | "lineWidth" | "markerSize" | "marker" | "opacity">;
}

function MarkEditor({ title, mark, value, effective, onChange, fields }: MarkEditorProps) {
  const { t } = useTranslation();
  const palette = MARK_PALETTE[mark];
  return (
    <div className="gb-style-section">
      <div className="gb-style-section-title">{title}</div>
      {fields.includes("color") && (
        <div className="gb-style-row">
          <span className="gb-style-label">{t("graph.style.color")}</span>
          <div className="gb-style-color-row">
            {palette.map((c) => (
              <button
                key={c}
                className={`gb-style-color-swatch${(value.color ?? effective.color) === c ? " gb-style-color-selected" : ""}`}
                style={{ background: c }}
                title={c}
                onClick={() => onChange(mark === "fill" ? { color: c } : { color: c, fillColor: c })}
              />
            ))}
            <input
              type="color"
              className="gb-style-color-picker"
              value={value.color ?? effective.color}
              onChange={(e) => onChange(mark === "fill" ? { color: e.target.value } : { color: e.target.value, fillColor: e.target.value })}
              title={t("graph.style.color")}
            />
          </div>
        </div>
      )}
      {fields.includes("marker") && (
        <div className="gb-style-row">
          <span className="gb-style-label">{t("graph.style.marker")}</span>
          <select
            className="gb-style-select"
            value={value.marker ?? effective.marker ?? "circle"}
            onChange={(e) => onChange({ marker: e.target.value as MarkerShape })}
          >
            {MARKER_SHAPES.map((m) => (
              <option key={m} value={m}>{t(`graph.shape.${m}`)}</option>
            ))}
          </select>
        </div>
      )}
      {fields.includes("markerSize") && (
        <div className="gb-style-row">
          <span className="gb-style-label">{t("graph.style.markerSize")}</span>
          <input
            type="number"
            className="gb-style-number"
            min={1}
            max={32}
            step={1}
            value={value.markerSize ?? effective.markerSize ?? 4}
            onChange={(e) => onChange({ markerSize: Number(e.target.value) })}
          />
        </div>
      )}
      {fields.includes("lineWidth") && (
        <div className="gb-style-row">
          <span className="gb-style-label">{t("graph.style.lineWidth")}</span>
          <input
            type="number"
            className="gb-style-number"
            min={0}
            max={10}
            step={0.5}
            value={value.lineWidth ?? effective.lineWidth ?? 1.5}
            onChange={(e) => onChange({ lineWidth: Number(e.target.value) })}
          />
        </div>
      )}
      {fields.includes("opacity") && (
        <div className="gb-style-row">
          <span className="gb-style-label">{t("graph.style.opacity")}</span>
          <input
            type="range"
            className="gb-style-range"
            min={0}
            max={1}
            step={0.05}
            value={value.opacity ?? effective.opacity ?? 1}
            onChange={(e) => onChange({ opacity: Number(e.target.value) })}
          />
          <span className="gb-style-value">{Math.round((value.opacity ?? effective.opacity ?? 1) * 100)}%</span>
        </div>
      )}
    </div>
  );
}

/** A small JMP-like preset palette used by the legend's color picker.
 *  This is the *base* (mid-shade) palette; per-mark pickers (Point / Line /
 *  Fill) derive darker / mid / lighter variants from these via `shade()`
 *  so a single applied theme stays visually layered (the fill doesn't
 *  swallow the line; the point still pops against both). */
const STYLE_COLORS = [
  "#000000", "#444444", "#888888", "#bbbbbb",
  "#e74c3c", "#f39c12",
  "#2ca678", "#27ae60",
  "#3498db", "#4a6cf7",
  "#9168d6", "#d56cb1",
];

/** Per-mark shade ratios — Point darkest, Line mid (base), Fill lightest.
 *  Picked so that applying one color family across all three sub-marks
 *  keeps each mark distinguishable from the others. */
export const SHADE_RATIO_POINT = -0.2;
export const SHADE_RATIO_LINE = 0;
export const SHADE_RATIO_FILL = 0.55;

/** Mix `hex` toward black (ratio<0) or white (ratio>0). ratio in [-1,1]. */
export function shade(hex: string, ratio: number): string {
  if (!hex || ratio === 0) return hex;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const hh = m[1];
  const r = parseInt(hh.slice(0, 2), 16);
  const g = parseInt(hh.slice(2, 4), 16);
  const b = parseInt(hh.slice(4, 6), 16);
  const mix = (c: number) =>
    ratio < 0 ? Math.round(c * (1 + ratio)) : Math.round(c + (255 - c) * ratio);
  const clamp = (n: number) => Math.max(0, Math.min(255, n));
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, "0");
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}

const POINT_PALETTE = STYLE_COLORS.map((c) => shade(c, SHADE_RATIO_POINT));
const LINE_PALETTE = STYLE_COLORS.map((c) => shade(c, SHADE_RATIO_LINE));
const FILL_PALETTE = STYLE_COLORS.map((c) => shade(c, SHADE_RATIO_FILL));

const MARK_PALETTE: Record<"line" | "fill" | "point", string[]> = {
  line: LINE_PALETTE,
  fill: FILL_PALETTE,
  point: POINT_PALETTE,
};

const MARKER_SHAPES: MarkerShape[] = [
  "circle",
  "emptyCircle",
  "square",
  "emptySquare",
  "diamond",
  "emptyDiamond",
  "triangle",
  "emptyTriangle",
];
