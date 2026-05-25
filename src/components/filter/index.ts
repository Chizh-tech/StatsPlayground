/**
 * Local Data Filter — shared module.
 *
 * Re-exports the panel UI and the predicate engine so consumers can do
 * `import { FilterPanel, applyFilters, type FilterRuleItem } from "@/components/filter"`.
 */

export { FilterPanel } from "./FilterPanel";
export {
  applyFilters,
  applyFiltersWithIndex,
  distinctColumnValues,
  numericColumnExtent,
} from "./filterEngine";
