import { useMemo, useState } from "react";
import { EXTRA_DEFS, EXTRA_KINDS, type ExtraKind } from "@/types/columnExtras";

/**
 * Per-column "additional properties" bag (same shape as ColumnDisplayProps.extras).
 * Indexed by visible column index (matching DataTableView's `cols`).
 */
export type ColExtrasArray = ReadonlyArray<Record<string, unknown> | null>;

interface ManageExtrasDialogProps {
  cols: string[];
  colExtras: ColExtrasArray;
  /** User confirmed edits — caller updates state + persists. */
  onApply: (next: Array<Record<string, unknown> | null>) => void;
  onClose: () => void;
}

interface FlatField {
  kind: ExtraKind;
  fieldKey: string;
  /** Header text e.g. "规格 / 下限" or just "单位" for single-field kinds. */
  header: string;
  type: "text" | "number" | "longtext";
}

/** Build the flat list of grid sub-columns from selected kinds. */
function flattenFields(kinds: ExtraKind[]): FlatField[] {
  const out: FlatField[] = [];
  for (const k of kinds) {
    const def = EXTRA_DEFS[k];
    const single = def.fields.length === 1;
    for (const f of def.fields) {
      out.push({
        kind: k,
        fieldKey: f.key,
        header: single ? def.label : `${def.label} / ${f.label}`,
        type: f.type,
      });
    }
  }
  return out;
}

/**
 * 管理附加属性 dialog.
 *
 * Step 1 — select which columns and which extra kinds to include in the
 *          batch table. Defaults: all columns checked; kinds = union of
 *          kinds already present on any column (or all kinds if none).
 * Step 2 — editable grid: rows = selected columns, columns = expanded
 *          fields of the selected kinds. Edits stage locally; "应用" writes
 *          back via onApply, "重新载入" discards local edits.
 */
export function ManageExtrasDialog({
  cols, colExtras, onApply, onClose,
}: ManageExtrasDialogProps) {
  // ---- Step 1 state ----
  const initialCheckedCols = useMemo(() => new Set(cols.map((_, i) => i)), [cols]);
  const initialCheckedKinds = useMemo<Set<ExtraKind>>(() => {
    const present = new Set<ExtraKind>();
    for (const e of colExtras) {
      if (!e) continue;
      for (const k of EXTRA_KINDS) {
        if (e[k] !== undefined) present.add(k);
      }
    }
    return present.size > 0 ? present : new Set(EXTRA_KINDS);
  }, [colExtras]);

  const [step, setStep] = useState<1 | 2>(1);
  const [checkedCols, setCheckedCols] = useState<Set<number>>(initialCheckedCols);
  const [checkedKinds, setCheckedKinds] = useState<Set<ExtraKind>>(initialCheckedKinds);

  // ---- Step 2 state: staged edits, shape ColExtrasArray scoped to selected cols ----
  // Map keyed by col index for sparse edits; values mirror the extras shape.
  // Initialized when entering step 2.
  const [staged, setStaged] = useState<Map<number, Record<string, unknown>>>(new Map());

  const selectedColIndices = useMemo(
    () => Array.from(checkedCols).sort((a, b) => a - b),
    [checkedCols],
  );
  const selectedKinds = useMemo(
    () => EXTRA_KINDS.filter((k) => checkedKinds.has(k)),
    [checkedKinds],
  );
  const flatFields = useMemo(() => flattenFields(selectedKinds), [selectedKinds]);

  const enterStep2 = () => {
    if (selectedColIndices.length === 0 || selectedKinds.length === 0) return;
    // Seed staged with current extras for selected cols (deep-ish copy)
    const seeded = new Map<number, Record<string, unknown>>();
    for (const ci of selectedColIndices) {
      const cur = colExtras[ci];
      seeded.set(ci, cur ? structuredClone(cur) as Record<string, unknown> : {});
    }
    setStaged(seeded);
    setStep(2);
  };

  const reload = () => {
    const seeded = new Map<number, Record<string, unknown>>();
    for (const ci of selectedColIndices) {
      const cur = colExtras[ci];
      seeded.set(ci, cur ? structuredClone(cur) as Record<string, unknown> : {});
    }
    setStaged(seeded);
  };

  const getCellValue = (ci: number, f: FlatField): string => {
    const colE = staged.get(ci);
    if (!colE) return "";
    const kindObj = colE[f.kind] as Record<string, unknown> | undefined;
    const v = kindObj?.[f.fieldKey];
    return v == null ? "" : String(v);
  };

  const setCellValue = (ci: number, f: FlatField, raw: string) => {
    setStaged((prev) => {
      const next = new Map(prev);
      const colE = { ...(next.get(ci) ?? {}) };
      const kindObj: Record<string, unknown> = { ...((colE[f.kind] as Record<string, unknown> | undefined) ?? {}) };
      let value: unknown;
      if (f.type === "number") {
        value = raw === "" ? null : Number(raw);
        if (typeof value === "number" && Number.isNaN(value)) value = null;
      } else {
        value = raw;
      }
      kindObj[f.fieldKey] = value;
      colE[f.kind] = kindObj;
      next.set(ci, colE);
      return next;
    });
  };

  /** Compose the final extras array, merging staged edits into the existing
   *  per-column extras. Untouched columns are preserved as-is. Kinds NOT in
   *  the user's selected-kinds set are also preserved as-is (we only edit
   *  the kinds the user explicitly chose). */
  const apply = () => {
    const result: Array<Record<string, unknown> | null> = cols.map((_, i) => {
      const cur = colExtras[i];
      return cur ? { ...cur } : null;
    });
    for (const ci of selectedColIndices) {
      const stagedE = staged.get(ci) ?? {};
      const merged: Record<string, unknown> = { ...(result[ci] ?? {}) };
      // Replace each selected kind from the staged edits; if the staged
      // kind value is empty (all fields null/blank), drop the kind.
      for (const k of selectedKinds) {
        const stagedVal = stagedE[k] as Record<string, unknown> | undefined;
        if (stagedVal === undefined) continue;
        const allEmpty = Object.values(stagedVal).every(
          (v) => v == null || v === "",
        );
        if (allEmpty) {
          delete merged[k];
        } else {
          merged[k] = stagedVal;
        }
      }
      result[ci] = Object.keys(merged).length > 0 ? merged : null;
    }
    onApply(result);
    onClose();
  };

  // ---- Render ----
  return (
    <div className="sp-dialog-overlay">
      <div
        className="sp-dialog"
        style={{ width: step === 1 ? 540 : "min(960px, 90vw)", maxWidth: "90vw" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sp-dialog-title">
          管理附加属性 {step === 1 ? "— 选择列与属性" : `— 批量编辑（${selectedColIndices.length} 列）`}
        </div>
        <div className="sp-dialog-body">
          {step === 1 ? (
            <Step1
              cols={cols}
              checkedCols={checkedCols}
              setCheckedCols={setCheckedCols}
              checkedKinds={checkedKinds}
              setCheckedKinds={setCheckedKinds}
            />
          ) : (
            <Step2
              cols={cols}
              selectedColIndices={selectedColIndices}
              flatFields={flatFields}
              getCellValue={getCellValue}
              setCellValue={setCellValue}
            />
          )}
        </div>
        <div className="sp-dialog-actions">
          <button className="sp-dialog-btn" onClick={onClose}>取消</button>
          {step === 1 ? (
            <button
              className="sp-dialog-btn sp-dialog-btn-primary"
              onClick={enterStep2}
              disabled={selectedColIndices.length === 0 || selectedKinds.length === 0}
            >下一步</button>
          ) : (
            <>
              <button className="sp-dialog-btn" onClick={() => setStep(1)}>← 返回</button>
              <button className="sp-dialog-btn" onClick={reload}>重新载入</button>
              <button className="sp-dialog-btn sp-dialog-btn-primary" onClick={apply}>应用到列</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Step 1 sub-view ----
interface Step1Props {
  cols: string[];
  checkedCols: Set<number>;
  setCheckedCols: (next: Set<number>) => void;
  checkedKinds: Set<ExtraKind>;
  setCheckedKinds: (next: Set<ExtraKind>) => void;
}

function Step1({
  cols, checkedCols, setCheckedCols, checkedKinds, setCheckedKinds,
}: Step1Props) {
  const toggleCol = (i: number) => {
    const next = new Set(checkedCols);
    if (next.has(i)) next.delete(i); else next.add(i);
    setCheckedCols(next);
  };
  const toggleKind = (k: ExtraKind) => {
    const next = new Set(checkedKinds);
    if (next.has(k)) next.delete(k); else next.add(k);
    setCheckedKinds(next);
  };
  const allColsChecked = checkedCols.size === cols.length;
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="sp-dialog-label" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>列（{checkedCols.size}/{cols.length}）</span>
          <button
            className="sp-dialog-btn"
            style={{ padding: "0 6px", fontSize: 11 }}
            onClick={() => setCheckedCols(allColsChecked ? new Set() : new Set(cols.map((_, i) => i)))}
          >{allColsChecked ? "全不选" : "全选"}</button>
        </div>
        <div className="sp-extras-picker-list">
          {cols.map((name, i) => (
            <label key={i} className="sp-extras-picker-item">
              <input
                type="checkbox"
                checked={checkedCols.has(i)}
                onChange={() => toggleCol(i)}
              />
              <span className="sp-extras-picker-item-name">{name || `(列 ${i + 1})`}</span>
            </label>
          ))}
        </div>
      </div>
      <div style={{ flex: "0 0 200px" }}>
        <div className="sp-dialog-label">附加属性</div>
        <div className="sp-extras-picker-list">
          {EXTRA_KINDS.map((k) => (
            <label key={k} className="sp-extras-picker-item">
              <input
                type="checkbox"
                checked={checkedKinds.has(k)}
                onChange={() => toggleKind(k)}
              />
              <span className="sp-extras-picker-item-name">{EXTRA_DEFS[k].label}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---- Step 2 sub-view ----
interface Step2Props {
  cols: string[];
  selectedColIndices: number[];
  flatFields: FlatField[];
  getCellValue: (ci: number, f: FlatField) => string;
  setCellValue: (ci: number, f: FlatField, raw: string) => void;
}

function Step2({
  cols, selectedColIndices, flatFields, getCellValue, setCellValue,
}: Step2Props) {
  return (
    <div className="sp-extras-batch-wrapper">
      <div className="sp-extras-batch-hint">
        提示：可以直接从 Excel 复制单元格区域粘贴进来；编辑后点击"应用到列"。
      </div>
      <div className="sp-extras-batch-scroll">
        <table className="sp-extras-batch-table">
          <thead>
            <tr>
              <th className="sp-extras-batch-th-name">列名</th>
              {flatFields.map((f, i) => (
                <th key={i} className="sp-extras-batch-th">{f.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {selectedColIndices.map((ci) => (
              <tr key={ci}>
                <td className="sp-extras-batch-td-name" title={cols[ci]}>{cols[ci]}</td>
                {flatFields.map((f, fi) => (
                  <td key={fi} className="sp-extras-batch-td">
                    <input
                      className="sp-extras-batch-input"
                      type={f.type === "number" ? "number" : "text"}
                      value={getCellValue(ci, f)}
                      onChange={(e) => setCellValue(ci, f, e.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
