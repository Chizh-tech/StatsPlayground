# Performance Baselines

StatsPlayground performance work uses deterministic DuckDB-generated data so
measurements do not include CSV parsing, network access, or fixture file I/O.
Run baselines from `src-tauri` with a release build:

```powershell
cargo run --release --example performance_baseline --features perf-harness -- --rows 100000 --columns 20 --operation query
cargo run --release --example performance_baseline --features perf-harness -- --rows 100000 --columns 20 --operation paste
cargo run --release --example performance_baseline --features perf-harness -- --rows 100000 --columns 20 --operation restore
cargo run --release --example performance_baseline --features perf-harness -- --rows 300000 --columns 20 --operation graph
```

The last stdout line is machine-readable JSON:

```json
{"rows":300000,"columns":20,"operation":"graph","setupMs":231,"operationMs":562,"totalMs":795,"resultRows":300000,"selectedColumns":3,"queryMs":552,"encodeMs":10,"decodeMs":"desktop_only","drawMs":"desktop_only","processedRows":300000,"transferredBytes":6078360}
```

Fields:

- `setupMs`: create the in-memory engine and generate the managed table with a
  set-based DuckDB `range()` query.
- `operationMs`: time spent in the selected application operation.
- `totalMs`: setup and operation wall-clock time.
- `resultRows`: rows returned or affected by the operation.
- `selectedColumns`: projected column count reported by `graph`.
- `queryMs`: backend projection/query pass time for the graph request.
- `encodeMs`: backend graph chunk encoding overhead.
- `decodeMs` / `drawMs`: `desktop_only` placeholders in CLI runs because Node
  benchmarks do not run repository Canvas/WebView rendering.
- `processedRows`: graph service completion row count.
- `transferredBytes`: header + payload + terminal bytes emitted by the graph
  stream.

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

## GraphBuilderView Old-Path Baseline (Pending Desktop Capture)

Task 1 requires a manual baseline note for the old `GraphBuilderView` path at
300,000 rows and 20 columns. This environment can run the Rust perf harness,
but cannot produce a reproducible desktop WebView wall-time and peak-working-set
measurement without the interactive UI session.

Use this release command to keep the data shape aligned with the baseline run:

```powershell
cargo run --release --manifest-path src-tauri/Cargo.toml --example performance_baseline --features perf-harness -- --rows 300000 --columns 20 --operation graph
```

## Task 8 Unified Graph Gate (2026-08-21)

Command:

```powershell
cargo run --release --manifest-path src-tauri/Cargo.toml --example performance_baseline --features perf-harness -- --rows 300000 --columns 20 --operation graph
```

Environment facts:

- OS: Windows
- Build profile: Rust `release` with `--features perf-harness`
- Operation mode: Full Data (no sampling fallback)
- Graph request: `x=region`, `y=cost`, `elements=[points]`
- Processed rows: `300000`

Recorded JSON:

```json
{"rows":300000,"columns":20,"operation":"graph","setupMs":231,"operationMs":562,"totalMs":795,"resultRows":300000,"selectedColumns":3,"queryMs":552,"encodeMs":10,"decodeMs":"desktop_only","drawMs":"desktop_only","processedRows":300000,"transferredBytes":6078360}
```

Desktop gate status:

- Cold complete-frame: `PENDING_DESKTOP_CAPTURE`
- Warm complete-frame: `PENDING_DESKTOP_CAPTURE`
- WebView tasks >200 ms: `PENDING_DESKTOP_CAPTURE`
- Desktop transferred bytes (WebView-observed): `PENDING_DESKTOP_CAPTURE`
- Peak working set: `PENDING_DESKTOP_CAPTURE`

Reason pending: this non-interactive CLI harness can verify backend graph
streaming and byte counts, but it cannot objectively drive and measure a full
desktop WebView frame lifecycle for the existing 300,000-row project.

Executable desktop capture instructions:

1. Start the desktop app and open a project containing one table with exactly
  `300000` rows.
2. Open Graph Builder, ensure sampling mode is Full Data, and bind `region` to
  X and `cost` to Y.
3. Use DevTools Performance panel to capture cold and warm complete-frame runs.
4. Record long tasks over 200 ms and transferred bytes from the stream events.
5. In a second PowerShell shell, run the working-set capture script below while
  triggering the graph render.

```powershell
$proc = Get-Process -Name StatsPlayground -ErrorAction Stop
$baseline = [pscustomobject]@{
  WorkingSet64 = $proc.WorkingSet64
  PeakWorkingSet64 = $proc.PeakWorkingSet64
}

"READY: put focus on the desktop UI action that triggers graph render."
"Press Enter here at the exact moment you click render in the UI."
Read-Host | Out-Null
$start = Get-Date
"START marker: $($start.ToString('o'))"

"Press Enter here when the graph is fully painted and interactive."
Read-Host | Out-Null
$stop = Get-Date
"STOP marker:  $($stop.ToString('o'))"

$proc = Get-Process -Id $proc.Id -ErrorAction Stop
$capture = [pscustomobject]@{
  WallMs = [math]::Round(($stop - $start).TotalMilliseconds, 3)
  WorkingSet64 = $proc.WorkingSet64
  PeakWorkingSet64 = $proc.PeakWorkingSet64
  DeltaWorkingSet64 = $proc.WorkingSet64 - $baseline.WorkingSet64
  DeltaPeakWorkingSet64 = $proc.PeakWorkingSet64 - $baseline.PeakWorkingSet64
}
$capture | Format-List
```

Manual UI actions (old `GraphBuilderView` path, desktop app):

1. Start StatsPlayground desktop build that still uses old `GraphBuilderView`.
2. Create/open a workspace and load a table with exactly 300,000 rows and 20
   columns.
3. Open graph builder and choose a graph type that renders immediately from the
   selected table (no additional filters/transforms).
4. Ensure the table is selected as graph input, then trigger the final action
  that renders the chart while running the canonical capture script above.

Timing note:

- The command block above captures both wall-time (`WallMs`) and memory deltas
  using explicit start/stop markers.
- For repeatability, run three captures and record median `WallMs` and highest
  `PeakWorkingSet64`.

Recorded values:

- Old-path wall time (ms): PENDING_DESKTOP_CAPTURE
- Old-path peak working set (bytes): PENDING_DESKTOP_CAPTURE
