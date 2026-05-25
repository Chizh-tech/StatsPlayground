/**
 * Graph Builder — Local Data Filter panel.
 *
 * Renders the left-most vertical column when the Filter button is toggled
 * on. Each rule maps one source column to a type-appropriate selector:
 *
 *   - continuous (numeric)        → min / max number inputs
 *   - categorical (ordinal/nominal/id) → search + scrollable checkbox list
 *   - datetime                    → start / end <input type="date">
 *
 * Rules are joined with explicit AND/OR; the first rule's connector is
 * hidden. Combination is strict left-to-right (no precedence) — see
 * filterEngine.ts.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FieldRef, GraphData, FieldType } from "@/graphCore";
import type {
  GraphFilterCategorical,
  GraphFilterContinuous,
  GraphFilterDate,
  GraphFilterRuleItem,
  GraphFilterOp,
  GraphFilterRule,
} from "@/types/graphFilter";
import { distinctColumnValues, numericColumnExtent } from "./filterEngine";

interface FilterPanelProps {
  data: GraphData | null;
  columns: FieldRef[];
  filters: GraphFilterRuleItem[];
  onChange: (next: GraphFilterRuleItem[]) => void;
  onClose: () => void;
  width: number;
}

/** Map a column FieldType to the filter rule kind we render for it. */
function ruleKindFor(t: FieldType): GraphFilterRule["kind"] {
  if (t === "continuous") return "continuous";
  if (t === "datetime") return "date";
  return "categorical";
}

/** Seed a rule with sensible defaults for the column's data. */
function makeRule(field: FieldRef, data: GraphData | null): GraphFilterRule {
  const kind = ruleKindFor(field.type);
  if (kind === "continuous") {
    return { kind: "continuous", field, min: null, max: null };
  }
  if (kind === "date") {
    return { kind: "date", field, start: null, end: null };
  }
  // Categorical: pre-select every distinct value so the rule starts as
  // pass-through (toggling off boxes narrows the result).
  const all = distinctColumnValues(data, field.name);
  return { kind: "categorical", field, selected: all };
}

let _ruleIdSeq = 0;
function nextRuleId(): string {
  _ruleIdSeq++;
  return `flt-${Date.now().toString(36)}-${_ruleIdSeq}`;
}

export function FilterPanel({
  data,
  columns,
  filters,
  onChange,
  onClose,
  width,
}: FilterPanelProps) {
  const { t } = useTranslation();

  // Columns not yet used as a filter — keeps the "Add filter" dropdown
  // free of duplicates. Multiple rules per column could be useful but
  // adds UX cost; collapse to one per column for v1.
  const usedNames = useMemo(
    () => new Set(filters.map((f) => f.rule.field.name)),
    [filters],
  );
  const available = useMemo(
    () => columns.filter((c) => !usedNames.has(c.name)),
    [columns, usedNames],
  );

  // Local "Add filter" picker state — a controlled <select> reset to ""
  // after each add so the next add starts fresh.
  const [picked, setPicked] = useState("");

  const addRule = (name: string) => {
    const field = columns.find((c) => c.name === name);
    if (!field) return;
    const item: GraphFilterRuleItem = {
      id: nextRuleId(),
      op: filters.length === 0 ? "AND" : "AND",
      rule: makeRule(field, data),
    };
    onChange([...filters, item]);
    setPicked("");
  };

  const updateRule = (id: string, patch: Partial<GraphFilterRuleItem>) => {
    onChange(filters.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  };

  const removeRule = (id: string) => {
    onChange(filters.filter((f) => f.id !== id));
  };

  return (
    <div className="gb-filter-panel" style={{ width }}>
      <div className="sp-panel-header gb-filter-header">
        <span className="sp-panel-header-title">
          {t("graph.filter.title", { defaultValue: "Filters" })}
        </span>
        <button
          className="gb-filter-close"
          onClick={onClose}
          title={t("graph.filter.close", { defaultValue: "Hide filters" })}
        >
          ×
        </button>
      </div>

      <div className="gb-filter-body">
        <div className="gb-filter-add">
          <select
            className="gb-filter-add-select"
            value={picked}
            onChange={(e) => {
              const v = e.target.value;
              if (v) addRule(v);
            }}
          >
            <option value="">
              {available.length === 0
                ? t("graph.filter.allUsed", {
                    defaultValue: "All columns already filtered",
                  })
                : t("graph.filter.addPlaceholder", {
                    defaultValue: "Add filter column…",
                  })}
            </option>
            {available.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {filters.length === 0 ? (
          <div className="gb-filter-empty">
            {t("graph.filter.empty", {
              defaultValue: "Pick a column above to add a filter rule.",
            })}
          </div>
        ) : (
          <div className="gb-filter-list">
            {filters.map((item, i) => (
              <FilterCard
                key={item.id}
                index={i}
                item={item}
                data={data}
                onChange={(patch) => updateRule(item.id, patch)}
                onRemove={() => removeRule(item.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- One rule card -------------------------------------------------------

interface FilterCardProps {
  index: number;
  item: GraphFilterRuleItem;
  data: GraphData | null;
  onChange: (patch: Partial<GraphFilterRuleItem>) => void;
  onRemove: () => void;
}

function FilterCard({ index, item, data, onChange, onRemove }: FilterCardProps) {
  const { t } = useTranslation();
  const { rule } = item;

  // Inline op toggle: first rule has no preceding rule to join with.
  const opBar =
    index === 0 ? null : (
      <div className="gb-filter-op-bar">
        <button
          className={`gb-filter-op-btn${item.op === "AND" ? " active" : ""}`}
          onClick={() => onChange({ op: "AND" })}
          title={t("graph.filter.andTitle", { defaultValue: "AND with previous" })}
        >
          AND
        </button>
        <button
          className={`gb-filter-op-btn${item.op === "OR" ? " active" : ""}`}
          onClick={() => onChange({ op: "OR" as GraphFilterOp })}
          title={t("graph.filter.orTitle", { defaultValue: "OR with previous" })}
        >
          OR
        </button>
      </div>
    );

  return (
    <>
      {opBar}
      <div className="gb-filter-card">
        <div className="gb-filter-card-head">
          <span className="gb-filter-card-name" title={rule.field.name}>
            {rule.field.name}
          </span>
          <button
            className="gb-filter-card-x"
            onClick={onRemove}
            title={t("graph.filter.removeRule", { defaultValue: "Remove rule" })}
          >
            ×
          </button>
        </div>
        <div className="gb-filter-card-body">
          {rule.kind === "continuous" && (
            <ContinuousEditor
              rule={rule}
              data={data}
              onChange={(next) => onChange({ rule: next })}
            />
          )}
          {rule.kind === "date" && (
            <DateEditor rule={rule} onChange={(next) => onChange({ rule: next })} />
          )}
          {rule.kind === "categorical" && (
            <CategoricalEditor
              rule={rule}
              data={data}
              onChange={(next) => onChange({ rule: next })}
            />
          )}
        </div>
      </div>
    </>
  );
}

// ---- Type-specific editors ----------------------------------------------

function ContinuousEditor({
  rule,
  data,
  onChange,
}: {
  rule: GraphFilterContinuous;
  data: GraphData | null;
  onChange: (next: GraphFilterContinuous) => void;
}) {
  const { t } = useTranslation();
  // Extent recomputed only when the data/column identity changes — the
  // extent is over the UN-filtered data so it's stable across rule edits.
  const extent = useMemo(
    () => numericColumnExtent(data, rule.field.name),
    [data, rule.field.name],
  );
  const minPh = extent ? String(extent[0]) : "min";
  const maxPh = extent ? String(extent[1]) : "max";

  const parse = (s: string): number | null => {
    if (s.trim() === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  return (
    <div className="gb-filter-range">
      <label className="gb-filter-range-row">
        <span className="gb-filter-range-label">
          {t("graph.filter.min", { defaultValue: "Min" })}
        </span>
        <input
          type="number"
          className="gb-filter-num"
          value={rule.min ?? ""}
          placeholder={minPh}
          onChange={(e) => onChange({ ...rule, min: parse(e.target.value) })}
        />
      </label>
      <label className="gb-filter-range-row">
        <span className="gb-filter-range-label">
          {t("graph.filter.max", { defaultValue: "Max" })}
        </span>
        <input
          type="number"
          className="gb-filter-num"
          value={rule.max ?? ""}
          placeholder={maxPh}
          onChange={(e) => onChange({ ...rule, max: parse(e.target.value) })}
        />
      </label>
    </div>
  );
}

function DateEditor({
  rule,
  onChange,
}: {
  rule: GraphFilterDate;
  onChange: (next: GraphFilterDate) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="gb-filter-range">
      <label className="gb-filter-range-row">
        <span className="gb-filter-range-label">
          {t("graph.filter.start", { defaultValue: "Start" })}
        </span>
        <input
          type="date"
          className="gb-filter-date"
          value={rule.start ?? ""}
          onChange={(e) => onChange({ ...rule, start: e.target.value || null })}
        />
      </label>
      <label className="gb-filter-range-row">
        <span className="gb-filter-range-label">
          {t("graph.filter.end", { defaultValue: "End" })}
        </span>
        <input
          type="date"
          className="gb-filter-date"
          value={rule.end ?? ""}
          onChange={(e) => onChange({ ...rule, end: e.target.value || null })}
        />
      </label>
    </div>
  );
}

function CategoricalEditor({
  rule,
  data,
  onChange,
}: {
  rule: GraphFilterCategorical;
  data: GraphData | null;
  onChange: (next: GraphFilterCategorical) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");

  // Distinct values from the UN-filtered data (filterEngine helper) —
  // this list stays stable while the user toggles boxes within the rule.
  const all = useMemo(
    () => distinctColumnValues(data, rule.field.name),
    [data, rule.field.name],
  );

  const selectedSet = useMemo(() => new Set(rule.selected), [rule.selected]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((v) => v.toLowerCase().includes(q));
  }, [all, query]);

  const toggle = (v: string) => {
    const next = new Set(selectedSet);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    // Preserve `all`'s order so re-renders are deterministic.
    onChange({ ...rule, selected: all.filter((x) => next.has(x)) });
  };

  const selectAll = () => onChange({ ...rule, selected: all.slice() });
  const clearAll = () => onChange({ ...rule, selected: [] });

  return (
    <div className="gb-filter-cats">
      <input
        type="text"
        className="gb-filter-search"
        value={query}
        placeholder={t("graph.filter.searchValues", { defaultValue: "Search…" })}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="gb-filter-cats-actions">
        <button className="gb-filter-mini-btn" onClick={selectAll}>
          {t("graph.filter.selectAll", { defaultValue: "All" })}
        </button>
        <button className="gb-filter-mini-btn" onClick={clearAll}>
          {t("graph.filter.clearAll", { defaultValue: "None" })}
        </button>
        <span className="gb-filter-cats-count">
          {rule.selected.length}/{all.length}
        </span>
      </div>
      <div className="gb-filter-cats-list">
        {visible.length === 0 ? (
          <div className="gb-filter-cats-empty">
            {t("graph.filter.noMatches", { defaultValue: "No matches" })}
          </div>
        ) : (
          visible.map((v) => (
            <label key={v} className="gb-filter-cat-item">
              <input
                type="checkbox"
                checked={selectedSet.has(v)}
                onChange={() => toggle(v)}
              />
              <span className="gb-filter-cat-label" title={v}>
                {v === "" ? <em>(blank)</em> : v}
              </span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}
