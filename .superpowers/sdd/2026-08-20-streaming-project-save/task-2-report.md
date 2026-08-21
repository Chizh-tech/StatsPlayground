# Task 2 Report - Race-Free Save Coordinator Foundation

Date: 2026-08-21
Branch: feature/streaming-project-save
Task brief: .superpowers/sdd/2026-08-20-streaming-project-save/task-2-brief.md

## Scope Completed

- Added `SaveCoordinator` foundation using `Mutex<CoordinatorState>` + `Condvar`.
- Added RAII guards:
  - `MutationPermit<'_>` from `mutation_permit()`.
  - `SaveGuard<'_>` from `begin_save()`.
- Implemented atomic save-intent registration (`save_waiting = true`) before waiting for active mutations.
- Implemented concurrent save rejection as `AppError::Busy`.
- Implemented mutation blocking during save intent waiting and active saving as `AppError::ReadOnly`.
- Implemented poison-safe behavior with `AppError` returns (no panic/unwrap/expect in non-test code).
- Added coordinator to `AppState` constructor.
- Added deterministic barrier/channel concurrency tests for waiting, busy rejection, read-only blocking, and guard drop restoration after success and synthetic error path.

Out of scope and not implemented in this task:
- Mutation command guards (Task 6)
- Streaming writer (Task 4)
- Async command surface (Task 5)
- Frontend save state updates (Task 7)

## RED Evidence (TDD First)

Command:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml services::save_coordinator::tests -- --nocapture
```

Observed RED compiler failures before implementation:

- unresolved import `super::SaveCoordinator`
- missing `AppError::Busy`
- missing `AppError::ReadOnly`

This confirmed tests failed for the intended missing coordinator/error surface.

## GREEN Evidence

Command:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml services::save_coordinator::tests -- --nocapture
```

Result:

- `5 passed; 0 failed; 0 ignored`

Command:

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
```

Result:

- completed successfully (warnings only).

## Concurrency Invariants Enforced

1. Save intent is registered atomically before waiting, preventing TOCTOU acquisition of new mutation permits.
2. At most one save can be waiting/active at any time.
3. New mutation permits are rejected while `save_waiting` or `saving` is true.
4. Save start waits for `active_mutations == 0`.
5. Dropping `MutationPermit` decrements active count and notifies waiters.
6. Dropping `SaveGuard` clears save flags and notifies waiters.
7. Poisoned lock/wait paths return `AppError` and avoid panics in non-test code; `Drop` paths do best-effort cleanup and notify.

## Files Changed

- src-tauri/src/services/save_coordinator.rs
- src-tauri/src/services/mod.rs
- src-tauri/src/state.rs
- src-tauri/src/error.rs
- .superpowers/sdd/2026-08-20-streaming-project-save/task-2-report.md (ignored artifact)

## Concerns

1. New `Busy`/`ReadOnly` variants are currently only exercised in coordinator tests; command-level plumbing in later tasks will consume them.
2. `is_saving()` returns `true` if lock is poisoned (conservative fail-closed); this is intentional for safety but should be documented for future command/UI behavior.
3. Condvar wake-ups are `notify_all` for correctness; if contention grows significantly, later optimization can revisit wake strategy with command-level metrics.

## Round 1 Fixes (Review Head 6a9355852f7e9cb35037044d600a82647e29fa76)

### Findings Addressed

1. Replaced scheduler-sensitive `Barrier + try_recv` assertions with deterministic synchronization:
  - Added test-only observer hooks (`#[cfg(test)]`) inside `SaveCoordinator` to signal:
    - `save_waiting` registered
    - each wait-loop entry while `begin_save` is blocked on active mutations
    - save transitioned to active
  - Tests now block on condvar-backed observer state transitions before asserting read-only rejection and save-blocked behavior.
  - No sleeps, polling loops, or production overhead were introduced.
  - All spawned threads are joined; no hanging background workers.

2. Added meaningful edge-case tests and behavior documentation by executable assertions:
  - Spurious wake-up handling: verify `begin_save` re-checks condition and remains blocked until mutations drain.
  - Deliberate guard leak via `mem::forget`: documented as fail-closed behavior (`ReadOnly`) and explicitly tested without creating a hanging join.
  - Underflow defense: synthetic drop path from zero confirms mutation count cannot go negative.
  - Poisoned mutex drop-path safety: both `MutationPermit` and `SaveGuard` drops are tested with a poisoned state mutex and verified not to panic.

3. Replaced saturating increment with exact checked increment:
  - `active_mutations` now uses `checked_add(1)`.
  - Overflow returns `AppError::Busy("Too many concurrent mutations to safely start a save")`.
  - Added focused overflow test with controlled test-only state injection (`usize::MAX`), avoiding unrealistic permit loops.

4. Poison behavior is fail-closed and non-panicking:
  - `is_saving()` still returns `true` on poison (conservative fail-closed semantics).
  - `Drop` implementations do best-effort cleanup and never panic when lock acquisition fails due to poison.

5. API and scope remain unchanged:
  - No public API surface changes.
  - Observer hooks and state helpers are `#[cfg(test)]` only, zero-cost in non-test builds.

### TDD Notes

- RED: `mutation_permit_overflow_returns_error` failed while implementation still used `saturating_add`.
- GREEN: after `checked_add` migration and underflow-safe drop adjustment, all focused save coordinator tests passed.

### Round 1 Verification

Command:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml services::save_coordinator::tests -- --nocapture
```

Result:

- `10 passed; 0 failed`

Command:

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
```

Result:

- success; warnings only (no new errors)
