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
import { Graph, inferFieldType, isMissing, DEFAULT_GROUP_KEY, type FieldRef, type FieldType, type GraphSpec, type GraphData, type ChartElement, type ElementKind, type MarkStyle, type GroupStyle, type GroupStyleMap, type MarkerShape, type RefLineY, type RefLineStyle, type YAxisConfig, type GridLineStyle } from "@/graphCore";
import type { DatasetMeta } from "@/types/data";
import type { GraphBuilderItem, GraphSlotKey } from "@/types/graphBuilder";
import type { FilterRuleItem } from "@/types/filter";
import { useGraphBuilderStore } from "@/stores/useGraphBuilderStore";
import { useProjectStore } from "@/stores/useProjectStore";
import { useGraphPaletteStore, type CustomPalette } from "@/stores/useGraphPaletteStore";
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
  { kind: "boxplot", icon: "⊟" },
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

  const [columns, setColumns] = useState<FieldRef[]>([]);
  const [colSqlTypes, setColSqlTypes] = useState<string[]>([]);
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Y-axis settings dialog open state. Opened by double-clicking the Y
  // axis (or its label/title area) in <Graph>; closed via the dialog's
  // Done button or overlay click.
  const [yAxisDialogOpen, setYAxisDialogOpen] = useState(false);
  // Per-column user-defined value ordering, keyed by column name. Populated
  // from the dataset's `ColumnDisplayProps.extras.valueOrder.values`. Used
  // by <Graph> to reorder categorical X axes, legend entries, boxplot
  // category positions, and faceted-panel ordering. Re-fetched on focus so
  // edits made in DataTableView take effect when the user switches back to
  // the graph tab.
  const [valueOrders, setValueOrders] = useState<Record<string, string[]>>({});

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
  const setSmootherLambda = useCallback(
    (v: number) => {
      updateItem(item.id, { smootherLambda: v });
      markDirty();
    },
    [item.id, updateItem, markDirty],
  );
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
        for (const p of displayProps) {
          const ex = p.extras as Record<string, unknown> | undefined;
          const node = ex?.valueOrder as { values?: unknown } | undefined;
          const vals = node?.values;
          if (!Array.isArray(vals) || vals.length === 0) continue;
          const colName = cols[p.colIndex]?.[0];
          if (!colName) continue;
          vo[colName] = vals.map((v) => String(v));
        }
        setColumns(fields);
        setColSqlTypes(sqlTypes);
        setData({ columns: result.columns, rows: result.rows });
        setValueOrders(vo);
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

  /** 同步元素的 options（如平滑器 lambda） */
  const finalElements = useMemo<ChartElement[]>(() => {
    return elements.map((el) =>
      el.kind === "smoother"
        ? { ...el, options: { ...el.options, lambda: smootherLambda } }
        : el,
    );
  }, [elements, smootherLambda]);

  const spec = useMemo<GraphSpec>(() => {
    const enc: GraphSpec["encoding"] = {};
    // Color / Size / Wrap encoding channels were removed in favour of the
    // per-group Style editor. Drop them when building the spec so legacy
    // projects don't surprise the user with auto-coloring or auto-sizing.
    const SKIP_KEYS = new Set<SlotKey>(["color", "size", "wrap"]);
    (Object.keys(encoding) as SlotKey[]).forEach((k) => {
      if (SKIP_KEYS.has(k)) return;
      const v = encoding[k];
      if (v) (enc as any)[k] = v;
    });
    return {
      datasetId: dataset.id,
      datasetName: dataset.name,
      encoding: enc,
      elements: finalElements,
      styles: effectiveStyles,
      hiddenGroups: item.hiddenGroups,
      refLinesY: item.refLinesY,
      yAxis: item.yAxis,
    };
  }, [encoding, finalElements, dataset.id, dataset.name, effectiveStyles, item.hiddenGroups, item.refLinesY, item.yAxis]);

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

  /** Replace the Y-axis configuration (range / tick density / decimals /
   *  inverse). Passing `undefined` (or all-undefined fields via the
   *  AxisSettingsEditor's Reset button) restores fully automatic
   *  behavior — the renderer's `buildYAxisOverrides` emits an empty
   *  fragment when every field is undefined. */
  const setYAxisConfig = useCallback(
    (next: YAxisConfig | undefined) => {
      updateItem(item.id, { yAxis: next });
      markDirty();
    },
    [item.id, updateItem, markDirty],
  );

  // 拖放处理
  const onDragStart = (e: React.DragEvent, field: FieldRef) => {
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(field));
    // 同时写入 text/plain 作为傅底（部分 WebView 对自定义 MIME 不友好）
    try { e.dataTransfer.setData("text/plain", JSON.stringify(field)); } catch { /* ignore */ }
    e.dataTransfer.effectAllowed = "copy";
  };

  const handleDropOnSlot = (slot: SlotKey, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const raw =
      e.dataTransfer.getData(DRAG_MIME) ||
      e.dataTransfer.getData("text/plain");
    if (!raw) return;
    try {
      const field = JSON.parse(raw) as FieldRef;
      setEncoding((prev) => ({ ...prev, [slot]: field }));
    } catch {
      // ignore
    }
  };

  const clearSlot = (slot: SlotKey) => {
    setEncoding((prev) => {
      const next = { ...prev };
      delete next[slot];
      return next;
    });
  };

  /** Add a new layer (chart kind) — enables it if already present. */
  const addElement = useCallback((kind: ElementKind) => {
    setElements((prev) => {
      const idx = prev.findIndex((e) => e.kind === kind);
      if (idx >= 0) {
        return prev.map((e, i) => (i === idx ? { ...e, enabled: true } : e));
      }
      return [...prev, { kind, enabled: true }];
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

  const startOver = () => {
    setEncoding({});
    setElements([{ kind: "points", enabled: true }]);
  };

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
                return (
                  <div
                    key={c.name}
                    className="sp-cols-panel-item"
                    draggable
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
            orientation="horizontal-top"
          />

          {/* 画布 + 左侧 Y 轴槽 + 右侧 Group Y 槽 */}
          <div className="gb-canvas-row">
            <Slot
              slot="y"
              label="Y"
              field={encoding.y}
              onDrop={(e) => handleDropOnSlot("y", e)}
              onClear={() => clearSlot("y")}
              orientation="vertical-left"
              required
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
                try {
                  const field = JSON.parse(raw) as FieldRef;
                  setEncoding((prev) => {
                    if (!prev.x) return { ...prev, x: field };
                    if (!prev.y) return { ...prev, y: field };
                    return { ...prev, y: field };
                  });
                } catch {
                  // ignore
                }
              }}
            >
              {loading ? (
                <div className="gb-empty">{t("graph.loading")}</div>
              ) : error ? (
                <div className="gb-empty gb-error">{error}</div>
              ) : !data ? (
                <div className="gb-empty">{t("graph.noData")}</div>
              ) : !encoding.y && !activeKinds.has("histogram") ? (
                <div className="gb-empty">{t("graph.dragHint")}</div>
              ) : (
                // `filteredData` is null iff `data` is null; the `!data`
                // branch above already handled that, so `filteredData ?? data`
                // is non-null here and just satisfies the type checker.
                <Graph
                  spec={spec}
                  data={filteredData ?? data}
                  valueOrders={valueOrders}
                  onYAxisDblClick={() => setYAxisDialogOpen(true)}
                />
              )}
            </div>
            <Slot
              slot="groupY"
              label="Group Y"
              field={encoding.groupY}
              onDrop={(e) => handleDropOnSlot("groupY", e)}
              onClear={() => clearSlot("groupY")}
              orientation="vertical-right"
            />
          </div>

          {/* X 轴槽 */}
          <Slot
            slot="x"
            label="X"
            field={encoding.x}
            onDrop={(e) => handleDropOnSlot("x", e)}
            onClear={() => clearSlot("x")}
            orientation="horizontal-bottom"
            required
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
          addition. Today it has two categories: Axis (range / ticks /
          decimals / inverse) and Reference Lines. */}
      {yAxisDialogOpen && (
        <YAxisSettingsDialog
          refLines={item.refLinesY ?? []}
          setRefLines={setRefLinesY}
          yAxisConfig={item.yAxis}
          setYAxisConfig={setYAxisConfig}
          onClose={() => setYAxisDialogOpen(false)}
        />
      )}
    </div>
  );
}

interface SlotProps {
  slot: SlotKey;
  label: string;
  field?: FieldRef;
  onDrop: (e: React.DragEvent) => void;
  onClear: () => void;
  orientation: "horizontal-top" | "horizontal-bottom" | "vertical-left" | "vertical-right" | "shelf";
  required?: boolean;
}

function Slot({ label, field, onDrop, onClear, orientation, required }: SlotProps) {
  const { t } = useTranslation();
  const [over, setOver] = useState(false);
  return (
    <div
      className={`gb-slot gb-slot-${orientation}${over ? " gb-slot-over" : ""}${field ? " gb-slot-filled" : ""}`}
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
    >
      {!field && (
        <span className="gb-slot-label">{label}{required ? " *" : ""}</span>
      )}
      {field && (
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
  const jitter = getOpt<string>(options, "jitter", "auto");
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
          <option value="auto">{t("graph.opt.auto")}</option>
          <option value="none">{t("graph.opt.summary.none")}</option>
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
  const jitter = getOpt<string>(options, "jitter", "auto");
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
          <option value="auto">{t("graph.opt.auto")}</option>
          <option value="none">{t("graph.opt.summary.none")}</option>
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

// ---- Y-axis settings dialog --------------------------------------------
// Opened by double-clicking the Y axis (or its label / title area) inside
// <Graph>. Modelled after the system Preferences dialog: a fixed-width
// categories nav on the left and a scrollable detail pane on the right.
// Today there's one category — "Reference Lines" — but the structure
// makes adding range / log-scale / tick-format settings later a one-line
// nav-item addition.

interface YAxisSettingsDialogProps {
  refLines: RefLineY[];
  setRefLines: (next: RefLineY[]) => void;
  yAxisConfig: YAxisConfig | undefined;
  setYAxisConfig: (next: YAxisConfig | undefined) => void;
  onClose: () => void;
}

type YAxisCategoryKey = "axis" | "tickGrid" | "refLines";

function YAxisSettingsDialog({
  refLines,
  setRefLines,
  yAxisConfig,
  setYAxisConfig,
  onClose,
}: YAxisSettingsDialogProps) {
  const { t } = useTranslation();
  // Axis range / ticks / decimals / inverse is the more frequently
  // adjusted category, so it opens first.
  const [active, setActive] = useState<YAxisCategoryKey>("axis");

  const categories: { key: YAxisCategoryKey; label: string }[] = [
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
          {t("graph.yAxisSettings.title", { defaultValue: "Y Axis Settings" })}
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
              <AxisSettingsEditor config={yAxisConfig} setConfig={setYAxisConfig} />
            )}
            {active === "tickGrid" && (
              <GridSettingsEditor config={yAxisConfig} setConfig={setYAxisConfig} />
            )}
            {active === "refLines" && (
              <RefLinesEditor refLines={refLines} setRefLines={setRefLines} />
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

// ---- Y-axis range / ticks / decimals / inverse editor ------------------
// Form pane inside the YAxisSettingsDialog's "Axis" category. Each row is
// label + value-input + auto-state indicator; an empty input means
// "auto", letting ECharts derive the value from the data range. The
// Reset to auto button clears every field in one click, restoring fully
// automatic axis behavior.

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
    c.tickCount === undefined &&
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

  /** Same as parseNum but clamps to a non-negative integer — used by
   *  Tick Count (splitNumber) and Decimals which only accept whole
   *  non-negative values. */
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
          {t("graph.axis.reset", { defaultValue: "Reset to auto" })}
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

      {/* Tick density: ECharts splitNumber. We cap at 50 because larger
          values produce visually unreadable grids on the typical canvas
          size; bottom at 1 because 0 would mean "no ticks at all". */}
      <div className="gb-axis-row">
        <label className="gb-axis-label">
          {t("graph.axis.tickCount", { defaultValue: "Tick count" })}
        </label>
        <input
          type="number"
          className="gb-axis-num gb-axis-num-narrow"
          value={cfg.tickCount ?? ""}
          step={1}
          min={1}
          max={50}
          placeholder={t("graph.axis.auto", { defaultValue: "Auto" })}
          onChange={(e) => patch({ tickCount: parseInt0(e.target.value, 1, 50) })}
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

      {/* Axis boundary line: toggles the line drawn at the axis edge.
          Theme default is "visible" — checking the box leaves it visible
          and unlocks the Tick position selector below; unchecking
          explicitly hides the line. */}
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
          <span>{t("graph.axis.showAxisLine", { defaultValue: "Show axis line" })}</span>
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

// ---- Y-axis grid (split-line) editor -----------------------------------
// Form pane inside the YAxisSettingsDialog's "Tick Grid" category.
// Controls both the major split-lines (rendered at major ticks — the
// usual horizontal grid lines) and the minor split-lines (rendered at
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
const GRID_LINE_DEFAULT_COLOR = "#e2e2e2";
const GRID_LINE_DEFAULT_WIDTH = 1;
const GRID_LINE_DEFAULT_STYLE: RefLineStyle = "dashed";

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
    // Theme defaults: major grid visible (dashed gray), minor grid
    // hidden. Reflect that as the initial checkbox state when the user
    // hasn't overridden it yet, so the UI matches what they see.
    const shown = isMajor
      ? (cfg.showMajorGrid ?? true)
      : (cfg.showMinorGrid ?? false);
    const style = (isMajor ? cfg.majorGridStyle : cfg.minorGridStyle) ?? {};
    const color = style.color ?? GRID_LINE_DEFAULT_COLOR;
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
              // Theme default for major is shown, minor is hidden — write
              // undefined when the new value matches default so we keep
              // the persisted config minimal.
              const defaultShown = isMajor ? true : false;
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
          <input
            type="color"
            className="gb-grid-color"
            value={color}
            disabled={!shown}
            onChange={(e) => patchStyle(which, { color: e.target.value })}
            title={t("graph.grid.color", { defaultValue: "Color" })}
            aria-label={t("graph.grid.color", { defaultValue: "Color" })}
          />
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
          {t("graph.axis.reset", { defaultValue: "Reset to auto" })}
        </button>
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

// ---- Y-axis reference lines editor -------------------------------------
// Card-per-line editor used inside the YAxisSettingsDialog's right pane.
// Each card lets the user pick the Y value, label text, line dash style,
// color, and stroke width for one horizontal reference line. The chart
// (transform.ts -> buildRefLinesCarrier) attaches the rendered markLines
// to an invisible scatter series so every chart type benefits.

interface RefLinesEditorProps {
  refLines: RefLineY[];
  setRefLines: (next: RefLineY[]) => void;
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

function RefLinesEditor({ refLines, setRefLines }: RefLinesEditorProps) {
  const { t } = useTranslation();

  const addLine = useCallback(() => {
    const next: RefLineY = {
      id: nextRefLineId(),
      y: 0,
      label: "",
      style: "dashed",
      color: REF_LINE_DEFAULT_COLOR,
      width: 1,
    };
    setRefLines([...(refLines ?? []), next]);
  }, [refLines, setRefLines]);

  const updateLine = useCallback(
    (id: string, patch: Partial<RefLineY>) => {
      setRefLines((refLines ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r)));
    },
    [refLines, setRefLines],
  );

  const removeLine = useCallback(
    (id: string) => {
      setRefLines((refLines ?? []).filter((r) => r.id !== id));
    },
    [refLines, setRefLines],
  );

  const lines = refLines ?? [];

  return (
    <div className="gb-refline-editor">
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
          {t("graph.refLine.empty", {
            defaultValue: "No reference lines yet. Click \u201cAdd reference line\u201d to draw a horizontal marker on the Y axis.",
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
                    value={Number.isFinite(r.y) ? r.y : 0}
                    step="any"
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      updateLine(r.id, { y: Number.isFinite(n) ? n : 0 });
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
