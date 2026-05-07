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

import { useEffect, useMemo, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { dataService } from "@/services/dataService";
import { Graph, inferFieldType, type FieldRef, type FieldType, type GraphSpec, type GraphData, type ChartElement, type ElementKind } from "@/graphCore";
import type { DatasetMeta } from "@/types/data";
import type { GraphBuilderItem, GraphSlotKey } from "@/types/graphBuilder";
import { useGraphBuilderStore } from "@/stores/useGraphBuilderStore";
import { useProjectStore } from "@/stores/useProjectStore";

interface GraphBuilderViewProps {
  item: GraphBuilderItem;
  dataset: DatasetMeta;
}

/** 所有可用的编码槽位 */
type SlotKey = GraphSlotKey;

interface SlotDef {
  key: SlotKey;
  label: string;
  /** 是否允许多个字段（当前均限制为 1） */
}

const SHELF_SLOTS: SlotDef[] = [
  { key: "overlay", label: "Overlay" },
  { key: "color", label: "Color" },
  { key: "size", label: "Size" },
  { key: "groupX", label: "Group X" },
  { key: "groupY", label: "Group Y" },
  { key: "wrap", label: "Wrap" },
];

interface ChartTypeDef {
  kind: ElementKind;
  icon: string; // 简单文字/符号图标（暂用 SVG path 太重）
}

const CHART_TYPE_DEFS: ChartTypeDef[] = [
  { kind: "points", icon: "●" },
  { kind: "line", icon: "╱" },
  { kind: "bar", icon: "▮" },
  { kind: "histogram", icon: "▦" },
  { kind: "boxplot", icon: "⊟" },
  { kind: "smoother", icon: "～" },
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
        if (cancelled) return;
        setColumns(fields);
        setColSqlTypes(sqlTypes);
        setData({ columns: result.columns, rows: result.rows });
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
    (Object.keys(encoding) as SlotKey[]).forEach((k) => {
      const v = encoding[k];
      if (v) (enc as any)[k] = v;
    });
    return {
      datasetId: dataset.id,
      datasetName: dataset.name,
      encoding: enc,
      elements: finalElements,
    };
  }, [encoding, finalElements, dataset.id, dataset.name]);

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

  const toggleElement = useCallback((kind: ElementKind) => {
    setElements((prev) => {
      const idx = prev.findIndex((e) => e.kind === kind);
      if (idx >= 0) {
        // 切换 enabled（若仅剩一个则保持）
        return prev.map((e, i) =>
          i === idx ? { ...e, enabled: !(e.enabled ?? true) } : e,
        );
      }
      return [...prev, { kind, enabled: true }];
    });
  }, []);

  const startOver = () => {
    setEncoding({});
    setElements([{ kind: "points", enabled: true }]);
  };

  const hasSmoother = finalElements.some((e) => e.kind === "smoother" && e.enabled !== false);
  const activeKinds = new Set(
    finalElements.filter((e) => e.enabled !== false).map((e) => e.kind),
  );

  return (
    <div className="gb-root">
      {/* 顶部工具条：图形类型 */}
      <div className="gb-toolbar">
        <div className="gb-toolbar-left">
          <button className="gb-tb-btn" onClick={startOver}>{t("graph.startOver")}</button>
        </div>
        <div className="gb-toolbar-spacer" />
        <div className="gb-chart-types">
          {CHART_TYPE_DEFS.map((ct) => {
            const label = t(`graph.type.${ct.kind}`);
            return (
              <button
                key={ct.kind}
                className={`gb-ct-btn${activeKinds.has(ct.kind) ? " gb-ct-btn-active" : ""}`}
                onClick={() => toggleElement(ct.kind)}
                title={label}
              >
                <span className="gb-ct-icon">{ct.icon}</span>
                <span className="gb-ct-label">{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="gb-body">
        {/* 左栏 */}
        <div className="gb-left">
          {/* Reuse the same column-panel styling as the data table view so the
              two left rails look and feel identical. Items remain draggable so
              they can be dropped into encoding slots. */}
          <div className="sp-cols-panel gb-cols-panel">
            <div className="sp-cols-panel-header">
              <span className="sp-cols-panel-title">
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

          {activeKinds.has("points") && (
            <div className="gb-section">
              <div className="gb-section-title">{t("graph.scatterSection")}</div>
              <div className="gb-elem-row">
                <span className="gb-elem-label">{t("graph.sizeEnc")}</span>
                <span className="gb-elem-val">{encoding.size?.name ?? "—"}</span>
              </div>
              <div className="gb-elem-row">
                <span className="gb-elem-label">{t("graph.colorEnc")}</span>
                <span className="gb-elem-val">{encoding.color?.name ?? "—"}</span>
              </div>
            </div>
          )}

          {hasSmoother && (
            <div className="gb-section">
              <div className="gb-section-title">{t("graph.smootherSection")}</div>
              <div className="gb-elem-row">
                <span className="gb-elem-label">Lambda</span>
                <input
                  type="range"
                  min={0.05}
                  max={0.9}
                  step={0.01}
                  value={smootherLambda}
                  onChange={(e) => setSmootherLambda(parseFloat(e.target.value))}
                  className="gb-slider"
                />
                <span className="gb-elem-val">{smootherLambda.toFixed(2)}</span>
              </div>
            </div>
          )}
        </div>

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
              ) : !encoding.x && !encoding.y && !activeKinds.has("histogram") ? (
                <div className="gb-empty">{t("graph.dragHint")}</div>
              ) : (
                <Graph spec={spec} data={data} />
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

        {/* 右栏：编码槽列表 */}
        <div className="gb-right">
          {SHELF_SLOTS.filter((s) => s.key !== "groupX" && s.key !== "groupY").map((s) => (
            <Slot
              key={s.key}
              slot={s.key}
              label={s.label}
              field={encoding[s.key]}
              onDrop={(e) => handleDropOnSlot(s.key, e)}
              onClear={() => clearSlot(s.key)}
              orientation="shelf"
            />
          ))}
        </div>
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
