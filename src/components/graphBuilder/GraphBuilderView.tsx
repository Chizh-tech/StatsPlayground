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
import { Graph, inferFieldType, DEFAULT_GROUP_KEY, type FieldRef, type FieldType, type GraphSpec, type GraphData, type ChartElement, type ElementKind, type MarkStyle, type GroupStyle, type GroupStyleMap, type MarkerShape } from "@/graphCore";
import type { DatasetMeta } from "@/types/data";
import type { GraphBuilderItem, GraphSlotKey } from "@/types/graphBuilder";
import { useGraphBuilderStore } from "@/stores/useGraphBuilderStore";
import { useProjectStore } from "@/stores/useProjectStore";
import { useGraphPaletteStore, type CustomPalette } from "@/stores/useGraphPaletteStore";
import { ctxMenuRef } from "@/utils/ctxMenu";
import { AddPaletteDialog } from "./AddPaletteDialog";

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
  // Vertical split inside the left rail: percentage of the rail's height
  // that goes to the column list, the rest to LAYERS. Mirrors the
  // history-divider pattern in HistoryPanel.
  const [leftTopPct, setLeftTopPct] = useState(50);
  const leftRailRef = useRef<HTMLDivElement>(null);
  const startSideResize = useCallback(
    (side: "left" | "right") => (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = side === "left" ? leftWidth : rightWidth;
      const dir = side === "left" ? 1 : -1;
      const onMove = (ev: MouseEvent) => {
        const next = Math.max(160, Math.min(500, startW + dir * (ev.clientX - startX)));
        if (side === "left") setLeftWidth(next);
        else setRightWidth(next);
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
    [leftWidth, rightWidth],
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
      styles: item.groupStyles,
    };
  }, [encoding, finalElements, dataset.id, dataset.name, item.groupStyles]);

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

  /** Clear every per-group override at once — used by the STYLE editor's
   *  Reset button. Lives at the parent level (not inside the panel) so a
   *  multi-group reset is a single atomic store write, instead of N writes
   *  that would each trigger a re-render. */
  const resetAllGroupStyles = useCallback(() => {
    if (!item.groupStyles || Object.keys(item.groupStyles).length === 0) return;
    updateItem(item.id, { groupStyles: {} });
    markDirty();
  }, [item.id, item.groupStyles, updateItem, markDirty]);

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
        </div>
        <div className="gb-toolbar-spacer" />
      </div>

      <div className="gb-body">
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
                <Graph spec={spec} data={data} valueOrders={valueOrders} />
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
          setGroupStyle={setGroupStyle}
          resetAllGroupStyles={resetAllGroupStyles}
          onDropOverlay={(e) => handleDropOnSlot("overlay", e)}
          onClearOverlay={() => clearSlot("overlay")}
          width={rightWidth}
        />
      </div>
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
  setGroupStyle: (groupKey: string, next: GroupStyle | undefined) => void;
  /** Drop every per-group override and return the chart to factory
   *  defaults. Wired to the STYLE editor's Reset button. */
  resetAllGroupStyles: () => void;
  onDropOverlay: (e: React.DragEvent) => void;
  onClearOverlay: () => void;
  width: number;
}

function LegendStylePanel({ data, encoding, elements, groupStyles, setGroupStyle, resetAllGroupStyles, onDropOverlay, onClearOverlay, width }: LegendStylePanelProps) {
  const { t } = useTranslation();

  // Overlay drives legend grouping. Drop a categorical column onto the
  // Overlay slot at the top of this panel to split the chart by that
  // column's values; otherwise the panel shows a single "All" entry that
  // styles the entire chart at once.
  const groupField = encoding.overlay;
  const groupKeys = useMemo<string[]>(() => {
    if (!groupField || !data) return [DEFAULT_GROUP_KEY];
    const idx = data.columns.indexOf(groupField.name);
    if (idx < 0) return [DEFAULT_GROUP_KEY];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of data.rows) {
      const v = r[idx];
      const k = v == null ? "" : String(v);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    return out.length > 0 ? out : [DEFAULT_GROUP_KEY];
  }, [groupField, data]);

  const [selected, setSelected] = useState<string>(groupKeys[0] ?? DEFAULT_GROUP_KEY);
  // Keep the selection valid when the legend list changes underneath us.
  useEffect(() => {
    if (!groupKeys.includes(selected)) {
      setSelected(groupKeys[0] ?? DEFAULT_GROUP_KEY);
    }
  }, [groupKeys, selected]);

  // Effective style currently applied to a group (override merged with the
  // group's categorical default color). Used to render the legend swatches.
  //
  // Default per-mark shades mirror the chart-side `resolveGroupStyle`:
  // each group gets a base hue (its slot in GROUP_COLORS) which is then
  // split into three shades — Point dark, Line mid, Fill light — so the
  // three sub-marks render distinctly when layered. Without grouping,
  // single-color charts keep the JMP look (black point + line, hollow fill)
  // — EXCEPT when a box plot layer is active, since the box body IS the
  // primary mark and rendering it transparent would make the chart look
  // empty. In that case the swatch shows a neutral grey (shaded from the
  // ungrouped foreground color) — matching what transform.ts paints when
  // no Fill override exists. Earlier this used the categorical-blue light
  // shade, which made post-Reset boxes look like the user had picked a
  // blue theme; grey reads as "default / neutral", consistent with JMP.
  const hasBoxplot = elements.some((e) => e.kind === "boxplot" && e.enabled !== false);
  const effectiveStyleOf = (key: string, idx: number): GroupStyle => {
    const stored = groupStyles[key] ?? {};
    const baseColor = groupField ? GROUP_COLORS[idx % GROUP_COLORS.length] : "#000000";
    const lineDefault = groupField ? shade(baseColor, SHADE_RATIO_LINE) : baseColor;
    const fillDefault = groupField
      ? shade(baseColor, SHADE_RATIO_FILL)
      : (hasBoxplot ? shade(baseColor, SHADE_RATIO_FILL) : "transparent");
    const pointDefault = groupField ? shade(baseColor, SHADE_RATIO_POINT) : baseColor;
    return {
      line: {
        color: stored.line?.color ?? lineDefault,
        lineWidth: stored.line?.lineWidth ?? 1.5,
        opacity: stored.line?.opacity ?? 1,
      },
      fill: {
        color: stored.fill?.color ?? fillDefault,
        opacity: stored.fill?.opacity ?? 1,
      },
      point: {
        color: stored.point?.color ?? pointDefault,
        fillColor: stored.point?.fillColor ?? stored.point?.color ?? pointDefault,
        marker: stored.point?.marker ?? "circle",
        markerSize: stored.point?.markerSize ?? 4,
        opacity: stored.point?.opacity ?? 1,
      },
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

  const selectedIdx = Math.max(0, groupKeys.indexOf(selected));
  const selectedStyle = effectiveStyleOf(selected, selectedIdx);
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
        {groupKeys.map((key, idx) => {
          const st = effectiveStyleOf(key, idx);
          const label = key === DEFAULT_GROUP_KEY ? t("graph.legend.allEntries") : (key || "—");
          return (
            <div
              key={key}
              className={`gb-legend-item${key === selected ? " gb-legend-item-selected" : ""}`}
              onClick={() => setSelected(key)}
            >
              <span className="gb-legend-swatch">
                <CompositeSwatch style={st} />
              </span>
              <span className="gb-legend-label" title={label}>{label}</span>
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

/** Categorical palette for legend defaults — must match getGraphTheme() */
const GROUP_COLORS = [
  "#4a6cf7", "#ef8a3a", "#2ca678", "#e74c3c",
  "#9168d6", "#8c6e3a", "#d56cb1", "#7f8c8d",
  "#c4ad36", "#3aa6b9", "#5d8aa8", "#b87333",
];

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
