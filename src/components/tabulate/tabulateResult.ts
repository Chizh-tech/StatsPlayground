export interface HeaderSpan {
  label: unknown;
  start: number;
  span: number;
}

const NUMERIC_DUCKDB_TYPES = new Set([
  "TINYINT",
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "UTINYINT",
  "USMALLINT",
  "UINTEGER",
  "UBIGINT",
  "HUGEINT",
  "UHUGEINT",
  "FLOAT",
  "REAL",
  "DOUBLE",
  "DECIMAL",
  "NUMERIC",
]);

export function isNumericDuckDbType(dataType: string): boolean {
  return NUMERIC_DUCKDB_TYPES.has(dataType.trim().toUpperCase().split("(", 1)[0]);
}

export function canShowReadyResult(
  cellCount: number,
  datasetAvailable: boolean,
  statisticCount: number,
): boolean {
  return datasetAvailable && statisticCount > 0 && cellCount > 0;
}

export function cellIndex(
  rowIndex: number,
  columnIndex: number,
  statisticIndex: number,
  columnCount: number,
  statisticCount: number,
): number {
  return ((rowIndex * columnCount) + columnIndex) * statisticCount + statisticIndex;
}

export function totalIndex(memberIndex: number, statisticIndex: number, statisticCount: number): number {
  return (memberIndex * statisticCount) + statisticIndex;
}

export function buildHeaderSpans(members: ReadonlyArray<ReadonlyArray<unknown>>): HeaderSpan[][] {
  if (members.length === 0) {
    return [];
  }

  const depth = members[0]?.length ?? 0;
  const spansByDepth: HeaderSpan[][] = [];

  for (let level = 0; level < depth; level += 1) {
    const levelSpans: HeaderSpan[] = [];
    let start = 0;

    while (start < members.length) {
      const label = members[start][level];
      let end = start + 1;

      while (end < members.length && samePrefix(members[start], members[end], level + 1)) {
        end += 1;
      }

      levelSpans.push({ label, start, span: end - start });
      start = end;
    }

    spansByDepth.push(levelSpans);
  }

  return spansByDepth;
}

export function isLatestSequence(sequence: number, latestSequence: number): boolean {
  return sequence === latestSequence;
}

export function parseQuantileInput(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

export function reorderForDrop<T>(items: readonly T[], from: number, target: number): T[] {
  if (from < 0 || from >= items.length) {
    return [...items];
  }
  const next = [...items];
  const [entry] = next.splice(from, 1);
  const boundedTarget = Math.max(0, Math.min(items.length, target));
  const insertionIndex = from < boundedTarget ? boundedTarget - 1 : boundedTarget;
  next.splice(insertionIndex, 0, entry);
  return next;
}

function samePrefix(
  left: ReadonlyArray<unknown>,
  right: ReadonlyArray<unknown>,
  prefixLength: number,
): boolean {
  for (let index = 0; index < prefixLength; index += 1) {
    if (!Object.is(left[index], right[index])) {
      return false;
    }
  }
  return true;
}