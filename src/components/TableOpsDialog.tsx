import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { dataService } from "@/services/dataService";
import { DualListPicker } from "@/components/DualListPicker";
import type { DatasetMeta } from "@/types/data";

// ─── Types ───

export type TableOpType =
  | "summary" | "subset" | "sort" | "stack"
  | "split" | "transpose" | "join" | "update" | "concatenate";

/**
 * Each form registers its primary (Confirm) action with the parent through
 * `setPrimary`, so that Confirm and Cancel can be rendered together in the
 * outer footer. `null` means no Confirm button is shown.
 */
export type PrimaryAction = { disabled: boolean; onClick: () => void };
export type SetPrimary = (p: PrimaryAction | null) => void;

interface Props {
  op: TableOpType;
  datasets: DatasetMeta[];
  activeDatasetId: string | null;
  onClose: () => void;
  onCreated: (ds: DatasetMeta) => void;     // new table created
  onUpdated: () => void;                     // existing table modified (update)
}

// ─── Shared helpers ───

function ColCheckList({
  cols, selected, onChange, label,
}: {
  cols: [string, string][];
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
  label: string;
}) {
  const lastClickedRef = useRef<number | null>(null);

  const handleItemClick = useCallback((e: React.MouseEvent, index: number) => {
    // Prevent default label→checkbox toggle; we handle it ourselves
    e.preventDefault();
    const name = cols[index][0];
    const next = new Set(selected);

    if (e.shiftKey && lastClickedRef.current !== null) {
      // Shift+click: range select/deselect from last clicked to current
      const from = Math.min(lastClickedRef.current, index);
      const to = Math.max(lastClickedRef.current, index);
      const adding = !selected.has(name);
      for (let i = from; i <= to; i++) {
        if (adding) next.add(cols[i][0]); else next.delete(cols[i][0]);
      }
    } else if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd+click: toggle single item without affecting others
      if (next.has(name)) next.delete(name); else next.add(name);
    } else {
      // Plain click: toggle single item
      if (next.has(name)) next.delete(name); else next.add(name);
    }

    lastClickedRef.current = index;
    onChange(next);
  }, [cols, selected, onChange]);

  return (
    <div className="sp-dialog-field">
      <label className="sp-dialog-label">{label}</label>
      <div className="sp-col-checklist">
        {cols.map(([name, type_], i) => (
          <label
            key={name}
            className="sp-col-check-item"
            title={type_}
            onMouseDown={(e) => handleItemClick(e, i)}
          >
            <input
              type="checkbox"
              checked={selected.has(name)}
              readOnly
              tabIndex={-1}
            />
            <span>{name}</span>
            <span className="sp-col-type-hint">{type_}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function DatasetSelect({
  datasets, value, onChange, label, exclude,
}: {
  datasets: DatasetMeta[];
  value: string;
  onChange: (v: string) => void;
  label: string;
  exclude?: string;
}) {
  const { t } = useTranslation();
  const filtered = exclude ? datasets.filter(d => d.id !== exclude) : datasets;
  return (
    <div className="sp-dialog-field">
      <label className="sp-dialog-label">{label}</label>
      <select className="sp-dialog-select" value={value} onChange={e => onChange(e.target.value)}>
        <option value="">{t("tableOp.selectTablePlaceholder")}</option>
        {filtered.map(d => (
          <option key={d.id} value={d.id}>{d.name} ({d.rowCount}×{d.colCount})</option>
        ))}
      </select>
    </div>
  );
}

// ─── Main Component ───

export function TableOpsDialog({ op, datasets, activeDatasetId, onClose, onCreated, onUpdated }: Props) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [primary, setPrimary] = useState<PrimaryAction | null>(null);

  // Source dataset (most ops work on the active dataset)
  const [sourceId, setSourceId] = useState(activeDatasetId ?? "");
  const [cols, setCols] = useState<[string, string][]>([]);

  // Load columns when source changes
  useEffect(() => {
    if (!sourceId) { setCols([]); return; }
    dataService.getColumns(sourceId).then(setCols).catch(() => setCols([]));
  }, [sourceId]);

  const sourceName = datasets.find(d => d.id === sourceId)?.name ?? "";

  // Memoized so child forms can put `exec` in their useLayoutEffect deps without
  // re-registering primary on every parent render.
  const exec = useCallback(async (fn: () => Promise<DatasetMeta | void>) => {
    setError(null);
    setBusy(true);
    try {
      const result = await fn();
      if (result && typeof result === "object" && "id" in result) {
        onCreated(result as DatasetMeta);
      } else {
        onUpdated();
      }
      onClose();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [onCreated, onUpdated, onClose]);

  const title: Record<TableOpType, string> = {
    summary: t("tableOp.summary"),
    subset: t("tableOp.subset"),
    sort: t("tableOp.sort"),
    stack: t("tableOp.stack"),
    split: t("tableOp.split"),
    transpose: t("tableOp.transpose"),
    join: t("tableOp.join"),
    update: t("tableOp.update"),
    concatenate: t("tableOp.concatenate"),
  };

  const confirmDisabled = busy || !primary || primary.disabled;

  return (
    <div className="sp-dialog-overlay" onMouseDown={onClose}>
      <div className="sp-dialog sp-dialog-wide" onMouseDown={e => e.stopPropagation()}>
        <div className="sp-dialog-title">{title[op]}</div>
        <div className="sp-dialog-body">
          {/* Source dataset selector (for most ops) */}
          {op !== "join" && op !== "update" && op !== "concatenate" && (
            <DatasetSelect datasets={datasets} value={sourceId} onChange={setSourceId} label={t("tableOp.sourceTable")} />
          )}

          {/* Per-op UI */}
          {op === "sort" && <SortForm sourceId={sourceId} cols={cols} sourceName={sourceName} exec={exec} setPrimary={setPrimary} t={t} />}
          {op === "subset" && <SubsetForm sourceId={sourceId} cols={cols} sourceName={sourceName} exec={exec} setPrimary={setPrimary} t={t} />}
          {op === "summary" && <SummaryForm sourceId={sourceId} cols={cols} sourceName={sourceName} exec={exec} setPrimary={setPrimary} t={t} />}
          {op === "transpose" && <TransposeForm sourceId={sourceId} sourceName={sourceName} exec={exec} setPrimary={setPrimary} t={t} />}
          {op === "stack" && <StackForm sourceId={sourceId} cols={cols} sourceName={sourceName} exec={exec} setPrimary={setPrimary} t={t} />}
          {op === "split" && <SplitForm sourceId={sourceId} cols={cols} sourceName={sourceName} exec={exec} setPrimary={setPrimary} t={t} />}
          {op === "join" && <JoinForm datasets={datasets} activeId={activeDatasetId} exec={exec} setPrimary={setPrimary} t={t} />}
          {op === "update" && <UpdateForm datasets={datasets} activeId={activeDatasetId} exec={exec} setPrimary={setPrimary} t={t} />}
          {op === "concatenate" && <ConcatenateForm datasets={datasets} activeId={activeDatasetId} exec={exec} setPrimary={setPrimary} t={t} />}

          {error && <div className="sp-dialog-error">{error}</div>}
        </div>
        <div className="sp-dialog-actions">
          <button
            className="sp-dialog-btn sp-dialog-btn-primary"
            disabled={confirmDisabled}
            onClick={() => primary?.onClick()}
          >{t("common.confirm")}</button>
          <button className="sp-dialog-btn" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Sort ───

function SortForm({ sourceId, cols, sourceName, exec, setPrimary, t }: {
  sourceId: string; cols: [string, string][]; sourceName: string;
  exec: (fn: () => Promise<DatasetMeta | void>) => void; setPrimary: SetPrimary; t: TFunction;
}) {
  const [sortCol, setSortCol] = useState("");
  const [sortOrder, setSortOrder] = useState("asc");

  useEffect(() => { if (cols.length > 0 && !sortCol) setSortCol(cols[0][0]); }, [cols]);

  useLayoutEffect(() => {
    setPrimary({
      disabled: !sourceId || !sortCol,
      onClick: () => exec(() => dataService.sortTable(sourceId, [sortCol], [sortOrder], t("tableOp.resultSuffix.sort", { name: sourceName }))),
    });
  }, [setPrimary, sourceId, sortCol, sortOrder, sourceName, exec, t]);

  return (
    <>
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.sortColumn")}</label>
        <select className="sp-dialog-select" value={sortCol} onChange={e => setSortCol(e.target.value)}>
          {cols.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.sortOrder")}</label>
        <select className="sp-dialog-select" value={sortOrder} onChange={e => setSortOrder(e.target.value)}>
          <option value="asc">{t("tableOp.sortAsc")}</option>
          <option value="desc">{t("tableOp.sortDesc")}</option>
        </select>
      </div>
    </>
  );
}

// ─── Subset ───

function SubsetForm({ sourceId, cols, sourceName, exec, setPrimary, t }: {
  sourceId: string; cols: [string, string][]; sourceName: string;
  exec: (fn: () => Promise<DatasetMeta | void>) => void; setPrimary: SetPrimary; t: TFunction;
}) {
  const [selectedCols, setSelectedCols] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  // Select all by default
  useEffect(() => { setSelectedCols(new Set(cols.map(([n]) => n))); }, [cols]);

  useLayoutEffect(() => {
    setPrimary({
      disabled: !sourceId || selectedCols.size === 0,
      onClick: () => exec(() => dataService.subsetTable(sourceId, [...selectedCols], filter || null, t("tableOp.resultSuffix.subset", { name: sourceName }))),
    });
  }, [setPrimary, sourceId, selectedCols, filter, sourceName, exec, t]);

  return (
    <>
      <ColCheckList cols={cols} selected={selectedCols} onChange={setSelectedCols} label={t("tableOp.subsetColumns")} />
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.subsetWhere")}</label>
        <input className="sp-dialog-input" value={filter} onChange={e => setFilter(e.target.value)}
          placeholder={t("tableOp.subsetWherePlaceholder")} />
      </div>
    </>
  );
}

// ─── Summary ───

function SummaryForm({ sourceId, cols, sourceName, exec, setPrimary, t }: {
  sourceId: string; cols: [string, string][]; sourceName: string;
  exec: (fn: () => Promise<DatasetMeta | void>) => void; setPrimary: SetPrimary; t: TFunction;
}) {
  const [statCols, setStatCols] = useState<Set<string>>(new Set());
  const [groupCols, setGroupCols] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState<Set<string>>(new Set(["n", "mean", "std", "min", "max"]));

  const allStats = [
    { key: "n", label: t("tableOp.stat_count") },
    { key: "mean", label: t("tableOp.stat_mean") },
    { key: "std", label: t("tableOp.stat_std") },
    { key: "min", label: t("tableOp.stat_min") },
    { key: "max", label: t("tableOp.stat_max") },
    { key: "sum", label: t("tableOp.stat_sum") },
    { key: "median", label: t("tableOp.stat_median") },
  ];

  useLayoutEffect(() => {
    setPrimary({
      disabled: !sourceId || statCols.size === 0 || stats.size === 0,
      onClick: () => exec(() => dataService.summaryTable(sourceId, [...statCols], [...groupCols], [...stats], t("tableOp.resultSuffix.summary", { name: sourceName }))),
    });
  }, [setPrimary, sourceId, statCols, groupCols, stats, sourceName, exec, t]);

  return (
    <>
      <ColCheckList cols={cols} selected={statCols} onChange={setStatCols} label={t("tableOp.summaryColumns")} />
      <ColCheckList cols={cols} selected={groupCols} onChange={setGroupCols} label={t("tableOp.summaryGroupBy")} />
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.summaryStats")}</label>
        <div className="sp-col-checklist">
          {allStats.map(s => (
            <label key={s.key} className="sp-col-check-item">
              <input type="checkbox" checked={stats.has(s.key)}
                onChange={e => {
                  const next = new Set(stats);
                  if (e.target.checked) next.add(s.key); else next.delete(s.key);
                  setStats(next);
                }} />
              <span>{s.label}</span>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

// ─── Transpose ───

function TransposeForm({ sourceId, sourceName, exec, setPrimary, t }: {
  sourceId: string; sourceName: string;
  exec: (fn: () => Promise<DatasetMeta | void>) => void; setPrimary: SetPrimary; t: TFunction;
}) {
  useLayoutEffect(() => {
    setPrimary({
      disabled: !sourceId,
      onClick: () => exec(() => dataService.transposeTable(sourceId, t("tableOp.resultSuffix.transpose", { name: sourceName }))),
    });
  }, [setPrimary, sourceId, sourceName, exec, t]);
  return null;
}

// ─── Stack ───

function StackForm({ sourceId, cols, sourceName, exec, setPrimary, t }: {
  sourceId: string; cols: [string, string][]; sourceName: string;
  exec: (fn: () => Promise<DatasetMeta | void>) => void; setPrimary: SetPrimary; t: TFunction;
}) {
  const [stackOrder, setStackOrder] = useState<string[]>([]);

  // Reset whenever the source table changes.
  useEffect(() => { setStackOrder([]); }, [sourceId]);

  // Drop any stack entries that no longer exist in the current column list.
  useEffect(() => {
    const valid = new Set(cols.map(c => c[0]));
    setStackOrder(prev => prev.filter(n => valid.has(n)));
  }, [cols]);

  const items = useMemo(
    () => cols.map(([name, type_]) => ({ key: name, label: name, hint: type_ })),
    [cols],
  );
  const idCount = items.length - stackOrder.length;
  const idCols = useMemo(() => {
    const stacked = new Set(stackOrder);
    return cols.map(([n]) => n).filter(n => !stacked.has(n));
  }, [cols, stackOrder]);

  useLayoutEffect(() => {
    setPrimary({
      disabled: !sourceId || stackOrder.length === 0,
      onClick: () => exec(() => dataService.stackTable(
        sourceId,
        stackOrder,
        idCols,
        t("tableOp.resultSuffix.stack", { name: sourceName }),
      )),
    });
  }, [setPrimary, sourceId, stackOrder, idCols, sourceName, exec, t]);

  return (
    <>
      <DualListPicker
        items={items}
        selected={stackOrder}
        onChange={setStackOrder}
        availableLabel={t("tableOp.stackAvailable", { defaultValue: "Available columns" })}
        selectedLabel={t("tableOp.stackSelected", { defaultValue: "Stack columns" })}
        emptyHint={t("tableOp.stackEmptyHint", { defaultValue: "Select columns on the left, then click ‘Add’." })}
      />

      <div className="sp-dlp-info-note">
        {t("tableOp.stackInfoNote", {
          defaultValue: "Other {{count}} column(s) will be kept as identifier columns.",
          count: idCount,
        })}
      </div>
    </>
  );
}

// ─── Split ───

function SplitForm({ sourceId, cols, sourceName, exec, setPrimary, t }: {
  sourceId: string; cols: [string, string][]; sourceName: string;
  exec: (fn: () => Promise<DatasetMeta | void>) => void; setPrimary: SetPrimary; t: TFunction;
}) {
  const [splitCol, setSplitCol] = useState("");
  const [valueCol, setValueCol] = useState("");
  const [idCols, setIdCols] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (cols.length >= 2 && !splitCol) {
      setSplitCol(cols[0][0]);
      setValueCol(cols[1][0]);
    }
  }, [cols]);

  useLayoutEffect(() => {
    setPrimary({
      disabled: !sourceId || !splitCol || !valueCol || splitCol === valueCol,
      onClick: () => exec(() => dataService.splitTable(sourceId, splitCol, valueCol, [...idCols], t("tableOp.resultSuffix.split", { name: sourceName }))),
    });
  }, [setPrimary, sourceId, splitCol, valueCol, idCols, sourceName, exec, t]);

  return (
    <>
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.splitKeyCol")}</label>
        <select className="sp-dialog-select" value={splitCol} onChange={e => setSplitCol(e.target.value)}>
          {cols.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.splitValueCol")}</label>
        <select className="sp-dialog-select" value={valueCol} onChange={e => setValueCol(e.target.value)}>
          {cols.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <ColCheckList cols={cols.filter(([n]) => n !== splitCol && n !== valueCol)} selected={idCols} onChange={setIdCols} label={t("tableOp.splitGroupCols")} />
    </>
  );
}

// ─── Join ───

function JoinForm({ datasets, activeId, exec, setPrimary, t }: {
  datasets: DatasetMeta[]; activeId: string | null;
  exec: (fn: () => Promise<DatasetMeta | void>) => void; setPrimary: SetPrimary; t: TFunction;
}) {
  const [leftId, setLeftId] = useState(activeId ?? "");
  const [rightId, setRightId] = useState("");
  const [joinType, setJoinType] = useState("inner");
  const [leftKey, setLeftKey] = useState("");
  const [rightKey, setRightKey] = useState("");
  const [leftCols, setLeftCols] = useState<[string, string][]>([]);
  const [rightCols, setRightCols] = useState<[string, string][]>([]);

  useEffect(() => {
    if (leftId) dataService.getColumns(leftId).then(setLeftCols).catch(() => setLeftCols([]));
    else setLeftCols([]);
  }, [leftId]);
  useEffect(() => {
    if (rightId) dataService.getColumns(rightId).then(setRightCols).catch(() => setRightCols([]));
    else setRightCols([]);
  }, [rightId]);
  useEffect(() => { if (leftCols.length > 0 && !leftKey) setLeftKey(leftCols[0][0]); }, [leftCols]);
  useEffect(() => { if (rightCols.length > 0 && !rightKey) setRightKey(rightCols[0][0]); }, [rightCols]);

  const leftName = datasets.find(d => d.id === leftId)?.name ?? "";
  const rightName = datasets.find(d => d.id === rightId)?.name ?? "";

  useLayoutEffect(() => {
    setPrimary({
      disabled: !leftId || !rightId || !leftKey || !rightKey,
      onClick: () => exec(() => dataService.joinTables(leftId, rightId, joinType, leftKey, rightKey, t("tableOp.resultSuffix.join", { left: leftName, right: rightName }))),
    });
  }, [setPrimary, leftId, rightId, joinType, leftKey, rightKey, leftName, rightName, exec, t]);

  return (
    <>
      <DatasetSelect datasets={datasets} value={leftId} onChange={setLeftId} label={t("tableOp.joinLeftTable")} />
      <DatasetSelect datasets={datasets} value={rightId} onChange={setRightId} label={t("tableOp.joinRightTable")} exclude={leftId} />
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.joinType")}</label>
        <select className="sp-dialog-select" value={joinType} onChange={e => setJoinType(e.target.value)}>
          <option value="inner">{t("tableOp.joinInner")}</option>
          <option value="left">{t("tableOp.joinLeft")}</option>
          <option value="right">{t("tableOp.joinRight")}</option>
          <option value="full">{t("tableOp.joinFull")}</option>
        </select>
      </div>
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.joinLeftCol")}</label>
        <select className="sp-dialog-select" value={leftKey} onChange={e => setLeftKey(e.target.value)}>
          {leftCols.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.joinRightCol")}</label>
        <select className="sp-dialog-select" value={rightKey} onChange={e => setRightKey(e.target.value)}>
          {rightCols.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
    </>
  );
}

// ─── Update ───

function UpdateForm({ datasets, activeId, exec, setPrimary, t }: {
  datasets: DatasetMeta[]; activeId: string | null;
  exec: (fn: () => Promise<DatasetMeta | void>) => void; setPrimary: SetPrimary; t: TFunction;
}) {
  const [leftId, setLeftId] = useState(activeId ?? "");
  const [rightId, setRightId] = useState("");
  const [matchCol, setMatchCol] = useState("");
  const [updateCols, setUpdateCols] = useState<Set<string>>(new Set());
  const [leftCols, setLeftCols] = useState<[string, string][]>([]);
  const [rightCols, setRightCols] = useState<[string, string][]>([]);

  useEffect(() => {
    if (leftId) dataService.getColumns(leftId).then(setLeftCols).catch(() => setLeftCols([]));
    else setLeftCols([]);
  }, [leftId]);
  useEffect(() => {
    if (rightId) dataService.getColumns(rightId).then(setRightCols).catch(() => setRightCols([]));
    else setRightCols([]);
  }, [rightId]);
  useEffect(() => { if (leftCols.length > 0 && !matchCol) setMatchCol(leftCols[0][0]); }, [leftCols]);

  // Update cols = intersection of left and right cols (excluding matchCol)
  const commonCols: [string, string][] = rightCols.filter(
    ([n]) => n !== matchCol && leftCols.some(([ln]) => ln === n)
  );

  useLayoutEffect(() => {
    setPrimary({
      disabled: !leftId || !rightId || !matchCol || updateCols.size === 0,
      onClick: () => exec(() => dataService.updateTable(leftId, rightId, matchCol, [...updateCols])),
    });
  }, [setPrimary, leftId, rightId, matchCol, updateCols, exec]);

  return (
    <>
      <DatasetSelect datasets={datasets} value={leftId} onChange={setLeftId} label={t("tableOp.updateTarget")} />
      <DatasetSelect datasets={datasets} value={rightId} onChange={setRightId} label={t("tableOp.updateSource")} exclude={leftId} />
      <div className="sp-dialog-field">
        <label className="sp-dialog-label">{t("tableOp.updateMatchCol")}</label>
        <select className="sp-dialog-select" value={matchCol} onChange={e => setMatchCol(e.target.value)}>
          {leftCols.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      {commonCols.length > 0 && (
        <ColCheckList cols={commonCols} selected={updateCols} onChange={setUpdateCols} label={t("tableOp.updateCols")} />
      )}
    </>
  );
}

// ─── Concatenate ───

function ConcatenateForm({ datasets, activeId, exec, setPrimary, t }: {
  datasets: DatasetMeta[]; activeId: string | null;
  exec: (fn: () => Promise<DatasetMeta | void>) => void; setPrimary: SetPrimary; t: TFunction;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(activeId ? [activeId] : []));

  const dsItems: [string, string][] = datasets.map(d => [d.id, `${d.name} (${d.rowCount}×${d.colCount})`]);

  useLayoutEffect(() => {
    setPrimary({
      disabled: selected.size < 2,
      onClick: () => exec(() => dataService.concatenateTables([...selected], t("tableOp.concatResult"))),
    });
  }, [setPrimary, selected, exec, t]);

  return (
    <div className="sp-dialog-field">
      <label className="sp-dialog-label">{t("tableOp.concatPickTables")}</label>
      <div className="sp-col-checklist">
        {dsItems.map(([id, label]) => (
          <label key={id} className="sp-col-check-item">
            <input
              type="checkbox"
              checked={selected.has(id)}
              onChange={e => {
                const next = new Set(selected);
                if (e.target.checked) next.add(id); else next.delete(id);
                setSelected(next);
              }}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
