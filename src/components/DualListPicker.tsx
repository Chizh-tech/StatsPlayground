/**
 * DualListPicker — JMP-style two-pane chooser.
 *
 * The left pane lists every item not yet selected; the right pane lists the
 * chosen items in the order they were added. The middle column has Add/Remove
 * buttons; double-click on either side moves a single item across.
 *
 * Selection inside each pane supports plain click, Ctrl/Cmd-click and
 * Shift-click range, and is independent of the moved-across membership state.
 *
 * The component is fully controlled: it owns only the highlight state inside
 * each pane. The ordered list of chosen keys is held by the parent via the
 * `selected` prop and updated via `onChange`.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface DualListPickerItem {
  /** Stable identifier passed back via `selected` / `onChange`. */
  key: string;
  /** Main text shown in each row. */
  label: string;
  /** Optional secondary text shown right-aligned (e.g. column type). */
  hint?: string;
  /** Optional native tooltip; defaults to `hint` then `label`. */
  title?: string;
}

interface Props {
  /** Full universe of items the user can pick from. */
  items: DualListPickerItem[];
  /** Ordered list of currently chosen keys. Items not in `items` are ignored. */
  selected: string[];
  /** Called with the new ordered list whenever the user moves items. */
  onChange: (next: string[]) => void;
  availableLabel: string;
  selectedLabel: string;
  /** Override button labels. Defaults are pulled from i18n (picker.add etc). */
  addLabel?: string;
  removeLabel?: string;
  addAllLabel?: string;
  removeAllLabel?: string;
  /** Shown inside the right pane when no items are chosen. */
  emptyHint?: string;
  /** Optional extra class on the outer container. */
  className?: string;
}

export function DualListPicker({
  items, selected, onChange,
  availableLabel, selectedLabel,
  addLabel, removeLabel, addAllLabel, removeAllLabel,
  emptyHint, className,
}: Props) {
  const { t } = useTranslation();
  const [leftSel, setLeftSel] = useState<Set<string>>(new Set());
  const [rightSel, setRightSel] = useState<Set<string>>(new Set());
  const lastLeftClickRef = useRef<number | null>(null);
  const lastRightClickRef = useRef<number | null>(null);

  const addText = addLabel ?? t("picker.add", { defaultValue: "Add" });
  const removeText = removeLabel ?? t("picker.remove", { defaultValue: "Remove" });
  const addAllText = addAllLabel ?? t("picker.addAll", { defaultValue: "Add All" });
  const removeAllText = removeAllLabel ?? t("picker.removeAll", { defaultValue: "Remove All" });

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const available = useMemo(
    () => items.filter(it => !selectedSet.has(it.key)),
    [items, selectedSet],
  );
  const selectedItems = useMemo(() => {
    const lookup = new Map(items.map(it => [it.key, it]));
    const out: DualListPickerItem[] = [];
    for (const k of selected) {
      const it = lookup.get(k);
      if (it) out.push(it);
    }
    return out;
  }, [items, selected]);

  const pickRange = useCallback((rows: DualListPickerItem[], from: number, to: number) => {
    const lo = Math.min(from, to), hi = Math.max(from, to);
    const out = new Set<string>();
    for (let i = lo; i <= hi; i++) out.add(rows[i].key);
    return out;
  }, []);

  const handlePaneClick = useCallback((
    e: React.MouseEvent,
    index: number,
    rows: DualListPickerItem[],
    sel: Set<string>,
    setSel: (s: Set<string>) => void,
    lastRef: React.MutableRefObject<number | null>,
  ) => {
    e.preventDefault();
    const key = rows[index].key;
    if (e.shiftKey && lastRef.current !== null) {
      setSel(pickRange(rows, lastRef.current, index));
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(sel);
      if (next.has(key)) next.delete(key); else next.add(key);
      setSel(next);
    } else {
      setSel(new Set([key]));
    }
    lastRef.current = index;
  }, [pickRange]);

  const moveRight = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    const seen = new Set(selected);
    const out = [...selected];
    for (const k of keys) if (!seen.has(k)) { out.push(k); seen.add(k); }
    if (out.length !== selected.length) onChange(out);
    setLeftSel(new Set());
    setRightSel(new Set(keys));
    lastLeftClickRef.current = null;
  }, [selected, onChange]);

  const moveLeft = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    const drop = new Set(keys);
    const next = selected.filter(k => !drop.has(k));
    if (next.length !== selected.length) onChange(next);
    setRightSel(new Set());
    setLeftSel(new Set(keys));
    lastRightClickRef.current = null;
  }, [selected, onChange]);

  return (
    <div className={`sp-dlp${className ? ` ${className}` : ""}`}>
      <div className="sp-dlp-pane">
        <div className="sp-dlp-pane-header">
          {availableLabel}
          <span className="sp-dlp-pane-count">{available.length}</span>
        </div>
        <div className="sp-dlp-list">
          {available.map((it, i) => (
            <div
              key={it.key}
              className={`sp-dlp-list-item${leftSel.has(it.key) ? " is-selected" : ""}`}
              title={it.title ?? it.hint ?? it.label}
              onMouseDown={(e) => handlePaneClick(e, i, available, leftSel, setLeftSel, lastLeftClickRef)}
              onDoubleClick={() => moveRight([it.key])}
            >
              <span className="sp-dlp-list-name">{it.label}</span>
              {it.hint != null && <span className="sp-dlp-hint">{it.hint}</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="sp-dlp-actions">
        <button
          type="button"
          className="sp-dialog-btn"
          disabled={leftSel.size === 0}
          onClick={() => moveRight([...leftSel])}
          title={addText}
        >{addText}</button>
        <button
          type="button"
          className="sp-dialog-btn"
          disabled={rightSel.size === 0}
          onClick={() => moveLeft([...rightSel])}
          title={removeText}
        >{removeText}</button>
        <button
          type="button"
          className="sp-dialog-btn"
          disabled={available.length === 0}
          onClick={() => moveRight(available.map(it => it.key))}
          title={addAllText}
        >{addAllText}</button>
        <button
          type="button"
          className="sp-dialog-btn"
          disabled={selectedItems.length === 0}
          onClick={() => moveLeft(selectedItems.map(it => it.key))}
          title={removeAllText}
        >{removeAllText}</button>
      </div>

      <div className="sp-dlp-pane">
        <div className="sp-dlp-pane-header">
          {selectedLabel}
          <span className="sp-dlp-pane-count">{selectedItems.length}</span>
        </div>
        <div className="sp-dlp-list">
          {selectedItems.length === 0 && emptyHint ? (
            <div className="sp-dlp-list-empty">{emptyHint}</div>
          ) : selectedItems.map((it, i) => (
            <div
              key={it.key}
              className={`sp-dlp-list-item${rightSel.has(it.key) ? " is-selected" : ""}`}
              title={it.title ?? it.hint ?? it.label}
              onMouseDown={(e) => handlePaneClick(e, i, selectedItems, rightSel, setRightSel, lastRightClickRef)}
              onDoubleClick={() => moveLeft([it.key])}
            >
              <span className="sp-dlp-list-name">{it.label}</span>
              {it.hint != null && <span className="sp-dlp-hint">{it.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
