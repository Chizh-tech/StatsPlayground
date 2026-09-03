# StatsPlayground
An ultra-lightweight, open-source, and extensible data analysis tool.

## DataLink

SQLite DataLink supports read-only object discovery, schema inspection, 100-row
preview, selective snapshot import, append with exact schema matching, bounded
streaming, progress, cancellation, and atomic rollback.

SQLite import preserves BLOB values as DuckDB BLOB, keeps DATE/TIME values as
text, and rejects invalid numeric conversions without leaving partial data.
