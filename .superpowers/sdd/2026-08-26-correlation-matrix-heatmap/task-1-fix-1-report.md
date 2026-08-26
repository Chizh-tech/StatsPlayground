# Task 1 Fix Report (Round 1)

## Scope
- Target worktree: `C:\Users\v-zhichuang\git\ashton2914\StatsPlayground-issue-44`
- Scope constraint followed: only Task 1 implementation/tests plus this fix report.
- Code file changed: `src-tauri/src/engine/correlation.rs`

## Review Findings Addressed

### 1) Enforce equal-length API contract unconditionally
Problem:
- `correlate` used `debug_assert_eq!(left.len(), right.len())`, so release builds could silently truncate via `zip`.

Fix:
- Replaced debug-only check with unconditional assertion:
  - `assert!(left.len() == right.len(), "left and right columns must have equal length: left={}, right={}", ...)`
- Added tests-first regression:
  - `correlate_panics_on_mismatched_lengths_with_clear_message`
  - Verifies panic happens and message explicitly explains equal-length contract.

### 2) Normalize finite signed zero for tie ordering/equality
Problem:
- `f64::total_cmp` treats `-0.0` and `+0.0` as distinct order/equality classes, which incorrectly split ties in rank/tie-count logic.

Fix:
- Added normalization during pairwise finite extraction:
  - `normalize_signed_zero(value)` maps any `value == 0.0` to canonical `+0.0`.
- This keeps Pearson behavior unchanged while fixing tie semantics used by Spearman and Kendall.
- Added tests-first regressions:
  - `spearman_treats_negative_and_positive_zero_as_same_tie`
  - `kendall_treats_negative_and_positive_zero_as_same_tie`

### 3) Strengthen Kendall test coverage
Added:
- `kendall_tau_b_is_negative_one_for_reverse_order` (explicit reverse ordering case, tau = -1)
- `kendall_tau_b_accounts_for_joint_ties` (dataset with joint ties)

## Tests-First Evidence

### RED after adding tests (before fixes)
Command:
- `cargo test engine::correlation::tests --lib`

Observed failures:
- `correlate_panics_on_mismatched_lengths_with_clear_message`
- `spearman_treats_negative_and_positive_zero_as_same_tie`
- `kendall_treats_negative_and_positive_zero_as_same_tie`

### GREEN after implementation
Commands:
- `cargo fmt`
- `cargo test engine::correlation::tests --lib`

Result:
- `test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 214 filtered out`

## Complexity / Dependency Constraints
- Kendall implementation remains O(n log n) (merge-sort inversion counting path unchanged).
- No new dependencies were added.

## Commit
- Message requested: `fix(stats): handle correlation edge cases`
- Includes:
  - `src-tauri/src/engine/correlation.rs`
  - `.superpowers/sdd/2026-08-26-correlation-matrix-heatmap/task-1-fix-1-report.md`

## Notes / Concerns
- Worktree contains many unrelated pre-existing modified files; these were intentionally not staged or altered.
