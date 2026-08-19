# Performance Baselines

StatsPlayground performance work uses deterministic DuckDB-generated data so
measurements do not include CSV parsing, network access, or fixture file I/O.
Run baselines from `src-tauri` with a release build:

```powershell
cargo run --release --example performance_baseline --features perf-harness -- --rows 100000 --columns 20 --operation query
cargo run --release --example performance_baseline --features perf-harness -- --rows 100000 --columns 20 --operation paste
cargo run --release --example performance_baseline --features perf-harness -- --rows 100000 --columns 20 --operation restore
```

The last stdout line is machine-readable JSON:

```json
{"rows":100000,"columns":20,"operation":"query","setupMs":108,"operationMs":7,"totalMs":116,"resultRows":500}
```

Fields:

- `setupMs`: create the in-memory engine and generate the managed table with a
  set-based DuckDB `range()` query.
- `operationMs`: time spent in the selected application operation.
- `totalMs`: setup and operation wall-clock time.
- `resultRows`: rows returned or affected by the operation.

The current `paste` baseline deliberately includes construction of the nested
string payload consumed by `paste_at_position`. This represents part of the
existing end-to-end cost and exposes its peak-memory weakness, but it is not a
pure DuckDB ingestion measurement. Pressure runs can require several hundred
megabytes until Phase 4 replaces this payload with streaming TSV ingestion.

## Recorded Baseline

Date: 2026-08-18

Machine: Intel Core i7-1850H-class Windows laptop with NVMe storage, using the
Rust `release` profile. The first build took several minutes; compilation time
is excluded from the JSON operation timings.

| Rows | Columns | Operation | Setup | Operation | Total | Result rows |
|---:|---:|---|---:|---:|---:|---:|
| 100,000 | 20 | query | 108 ms | 7 ms | 116 ms | 500 |
| 100,000 | 20 | query (Phase 1 exit, 2026-08-19) | 150 ms | 9 ms | 159 ms | 500 |

This baseline demonstrates that set-based DuckDB generation and bounded reads
are already fast. It does not measure the current WebView full-table JSON IPC,
React state copies, SQL isolation snapshot copy, or project JSON restoration;
those are measured by the other operations and phase-specific instrumentation.

Absolute timing thresholds do not run in normal CI because shared runner
hardware varies. Normal tests assert fixture shape and bounded result sizes.
Release acceptance compares phase timings and memory on the same machine class.
