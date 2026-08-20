import { useEffect, useMemo, useState } from "react";
import {
  decodeGraphPayload,
  type GraphAggregatePacket,
  type DecodedGraphChunk,
  type DecodedRawPointChunk,
  type GraphChunkHeader,
  type GraphDataCompletion,
  type GraphDataFrame,
  type GraphDataRequest,
  type GraphFieldBinding,
  type GraphSampling,
  type GraphElementRequest,
  type GraphViewport,
} from "../../types/graphData.ts";
import type { GraphBuilderItem } from "../../types/graphBuilder";
import type { DatasetMeta, TableWindowFilter } from "../../types/data";
import type { FilterRuleItem } from "../../types/filter";

const VIEWPORT_DEBOUNCE_MS = 120;

interface PendingGraphState {
  request: GraphDataRequest;
  chunks: DecodedRawPointChunk[];
  aggregates: GraphAggregatePacket[];
  chunkIndexes: Set<number>;
  finalChunkIndex: number | null;
  dictionaries: Record<string, readonly string[]>;
  extents: Record<string, { min: number; max: number }>;
}

export interface GraphStreamState {
  committed: GraphDataFrame | null;
  pending: PendingGraphState | null;
  pendingHeader: GraphChunkHeader | null;
  error: string | null;
  status: "idle" | "pending" | "ready" | "error";
}

export type GraphStreamMessage =
  | { type: "start"; request: GraphDataRequest }
  | { type: "header"; header: GraphChunkHeader }
  | { type: "payload"; payload: ArrayBuffer }
  | { type: "aggregate"; packet: GraphAggregatePacket }
  | { type: "chunk"; chunk: DecodedGraphChunk }
  | { type: "complete"; completion: GraphDataCompletion }
  | { type: "error"; requestId: string; generation: number; error: string };

export interface GraphDataPipelineResult {
  frame: GraphDataFrame | null;
  status: GraphStreamState["status"];
  error: string | null;
  pendingRequest: GraphDataRequest | null;
}

function idleStatus(committed: GraphDataFrame | null): GraphStreamState["status"] {
  return committed ? "ready" : "idle";
}

export function createInitialGraphStreamState(
  committed: GraphDataFrame | null = null,
): GraphStreamState {
  return {
    committed,
    pending: null,
    pendingHeader: null,
    error: null,
    status: idleStatus(committed),
  };
}

function isMatchingPending(state: GraphStreamState, requestId: string, generation: number): boolean {
  if (!state.pending) {
    return false;
  }
  return (
    state.pending.request.requestId === requestId
    && state.pending.request.generation === generation
  );
}

function failPending(state: GraphStreamState, error: string): GraphStreamState {
  return {
    ...state,
    pending: null,
    pendingHeader: null,
    error,
    status: "error",
  };
}

function bitIsSet(bitmap: Uint8Array | undefined, rowIndex: number): boolean {
  if (!bitmap) {
    return true;
  }
  const byteIndex = rowIndex >> 3;
  if (byteIndex >= bitmap.length) {
    return false;
  }
  const mask = 1 << (rowIndex & 7);
  return (bitmap[byteIndex] & mask) !== 0;
}

function updateExtent(
  extents: Record<string, { min: number; max: number }>,
  key: string,
  value: number,
): void {
  if (!Number.isFinite(value)) {
    return;
  }
  const current = extents[key];
  if (!current) {
    extents[key] = { min: value, max: value };
    return;
  }
  if (value < current.min) {
    current.min = value;
  }
  if (value > current.max) {
    current.max = value;
  }
}

function applyChunkExtents(
  extents: Record<string, { min: number; max: number }>,
  chunk: DecodedGraphChunk,
): Record<string, { min: number; max: number }> {
  const next = { ...extents };
  for (let row = 0; row < chunk.rowCount; row += 1) {
    if (bitIsSet(chunk.validity.x, row)) {
      updateExtent(next, "x", Number(chunk.xValues[row]));
    }
    if (bitIsSet(chunk.validity.y, row)) {
      updateExtent(next, "y", Number(chunk.yValues[row]));
    }
    if (chunk.sizeValues && bitIsSet(chunk.validity.size, row)) {
      updateExtent(next, "size", Number(chunk.sizeValues[row]));
    }
    if (chunk.zValues && bitIsSet(chunk.validity.z, row)) {
      updateExtent(next, "z", Number(chunk.zValues[row]));
    }
  }
  return next;
}

function toRawChunk(chunk: DecodedGraphChunk): DecodedRawPointChunk {
  return {
    chunkIndex: chunk.chunkIndex,
    rowOffset: chunk.rowOffset,
    rowCount: chunk.rowCount,
    xValues: chunk.xValues,
    yValues: chunk.yValues,
    rowIds: chunk.rowIds,
    zValues: chunk.zValues,
    groupCodes: chunk.groupCodes,
    sizeValues: chunk.sizeValues,
    sourceCodes: chunk.sourceCodes,
    facetXCodes: chunk.facetXCodes,
    facetYCodes: chunk.facetYCodes,
    facetZCodes: chunk.facetZCodes,
    wrapCodes: chunk.wrapCodes,
    roleVectors: chunk.roleVectors,
    validity: chunk.validity,
  };
}

function ingestDecodedChunk(state: GraphStreamState, chunk: DecodedGraphChunk): GraphStreamState {
  if (!state.pending) {
    return state;
  }
  if (
    chunk.requestId !== state.pending.request.requestId
    || chunk.generation !== state.pending.request.generation
  ) {
    return state;
  }
  if (state.pending.chunkIndexes.has(chunk.chunkIndex)) {
    return failPending(state, `duplicate graph chunk index ${chunk.chunkIndex}`);
  }
  if (
    state.pending.finalChunkIndex !== null
    && chunk.chunkIndex > state.pending.finalChunkIndex
  ) {
    return failPending(state, "graph chunk arrived after final chunk marker");
  }

  let finalChunkIndex = state.pending.finalChunkIndex;
  if (chunk.finalChunk) {
    if (finalChunkIndex !== null && finalChunkIndex !== chunk.chunkIndex) {
      return failPending(state, "graph stream emitted multiple final chunks");
    }
    finalChunkIndex = chunk.chunkIndex;
  }

  const chunkIndexes = new Set(state.pending.chunkIndexes);
  chunkIndexes.add(chunk.chunkIndex);

  const dictionaries = { ...state.pending.dictionaries, ...chunk.dictionaries };
  const chunks = [...state.pending.chunks, toRawChunk(chunk)];
  const extents = applyChunkExtents(state.pending.extents, chunk);

  return {
    ...state,
    pending: {
      ...state.pending,
      chunks,
      chunkIndexes,
      finalChunkIndex,
      dictionaries,
      extents,
    },
    pendingHeader: null,
    error: null,
    status: "pending",
  };
}

function hasCoherentCompletion(pending: PendingGraphState, chunksSent: number): boolean {
  if (pending.finalChunkIndex === null) {
    return false;
  }
  if (chunksSent !== pending.finalChunkIndex + 1) {
    return false;
  }
  if (pending.chunkIndexes.size !== chunksSent) {
    return false;
  }
  for (let index = 0; index <= pending.finalChunkIndex; index += 1) {
    if (!pending.chunkIndexes.has(index)) {
      return false;
    }
  }
  return true;
}

export function reduceGraphStream(state: GraphStreamState, message: GraphStreamMessage): GraphStreamState {
  switch (message.type) {
    case "start": {
      return {
        ...state,
        pending: {
          request: message.request,
          chunks: [],
          aggregates: [],
          chunkIndexes: new Set<number>(),
          finalChunkIndex: null,
          dictionaries: {},
          extents: {},
        },
        pendingHeader: null,
        error: null,
        status: "pending",
      };
    }
    case "header": {
      if (!isMatchingPending(state, message.header.requestId, message.header.generation)) {
        return state;
      }
      const expectedIndex = state.pending?.chunkIndexes.size ?? 0;
      if (message.header.chunkIndex !== expectedIndex) {
        return failPending(
          state,
          `graph header chunk index ${message.header.chunkIndex} arrived out of order (expected ${expectedIndex})`,
        );
      }
      if (state.pendingHeader) {
        return failPending(state, "graph header arrived before payload for previous chunk");
      }
      if (state.pending?.chunkIndexes.has(message.header.chunkIndex)) {
        return failPending(state, `duplicate graph chunk index ${message.header.chunkIndex}`);
      }
      return {
        ...state,
        pendingHeader: message.header,
      };
    }
    case "payload": {
      if (!state.pending) {
        return state;
      }
      const header = state.pendingHeader;
      if (!header) {
        return failPending(state, "graph payload arrived without a matching header");
      }
      try {
        const decoded = decodeGraphPayload(header, message.payload);
        return ingestDecodedChunk(state, decoded);
      } catch (error) {
        return failPending(state, `invalid graph payload: ${String(error)}`);
      }
    }
    case "chunk": {
      return ingestDecodedChunk(state, message.chunk);
    }
    case "aggregate": {
      if (!state.pending) {
        return state;
      }
      return {
        ...state,
        pending: {
          ...state.pending,
          aggregates: [...state.pending.aggregates, message.packet],
        },
      };
    }
    case "complete": {
      const completion = message.completion;
      if (!isMatchingPending(state, completion.requestId, completion.generation)) {
        return state;
      }
      if (completion.cancelled) {
        return {
          ...state,
          pending: null,
          pendingHeader: null,
          error: null,
          status: idleStatus(state.committed),
        };
      }
      if (!state.pending) {
        return state;
      }
      if (state.pendingHeader) {
        return failPending(state, "graph terminal marker arrived with a pending header");
      }
      if (!hasCoherentCompletion(state.pending, completion.chunksSent)) {
        return failPending(state, "graph terminal marker has inconsistent chunksSent");
      }

      const rawChunks = [...state.pending.chunks].sort(
        (left, right) => left.chunkIndex - right.chunkIndex,
      );

      const committed: GraphDataFrame = {
        requestId: state.pending.request.requestId,
        datasetId: completion.datasetId,
        generation: completion.generation,
        sourceRows: completion.sourceRows,
        processedRows: completion.processedRows,
        sampling: state.pending.request.sampling,
        dictionaries: state.pending.dictionaries,
        extents: state.pending.extents,
        rawChunks,
        aggregates: state.pending.aggregates,
      };

      return {
        committed,
        pending: null,
        pendingHeader: null,
        error: null,
        status: "ready",
      };
    }
    case "error": {
      if (!isMatchingPending(state, message.requestId, message.generation)) {
        return state;
      }
      return failPending(state, message.error);
    }
  }
}

function deriveSampling(item: GraphBuilderItem): GraphSampling {
  const sampling = item.sampling;
  if (!sampling || sampling.mode === "full") {
    return { mode: "full" };
  }

  const size = Math.trunc(sampling.size);
  const seed = Math.trunc(sampling.seed);
  if (!Number.isFinite(size) || !Number.isFinite(seed) || size <= 0 || seed < 0) {
    return { mode: "full" };
  }

  return { mode: "sample", size, seed };
}

function serializeFilters(filters: FilterRuleItem[]): TableWindowFilter[] {
  return filters.map(({ op, rule }) => {
    switch (rule.kind) {
      case "continuous":
        return {
          op,
          rule: { kind: rule.kind, field: rule.field.name, min: rule.min, max: rule.max },
        };
      case "categorical":
        return {
          op,
          rule: {
            kind: rule.kind,
            field: rule.field.name,
            selected: rule.selected,
            exclude: rule.exclude ?? false,
          },
        };
      case "date":
        return {
          op,
          rule: { kind: rule.kind, field: rule.field.name, start: rule.start, end: rule.end },
        };
    }
  });
}

function deriveElements(item: GraphBuilderItem): GraphElementRequest[] {
  return item.elements
    .filter((element) => element.enabled !== false)
    .map((element) => ({
      kind: element.kind,
      summaryStat:
        typeof element.options?.summaryStat === "string"
          ? String(element.options.summaryStat)
          : "none",
    }));
}

function hasEnabledElementKinds(item: GraphBuilderItem): Set<string> {
  return new Set(
    item.elements
      .filter((element) => element.enabled !== false)
      .map((element) => String(element.kind).toLowerCase()),
  );
}

function deriveGroupingColumn(item: GraphBuilderItem): string | undefined {
  return (
    item.encoding.overlay?.name
    ?? item.encoding.color?.name
    ?? item.encoding.groupX?.name
    ?? item.encoding.groupY?.name
    ?? (item.threeD ? item.encoding.groupZ?.name : undefined)
    ?? item.encoding.wrap?.name
  );
}

function deriveActiveMultiFields(item: GraphBuilderItem): GraphFieldBinding[] {
  const multiX = item.multiX ?? [];
  const multiY = item.multiY ?? [];
  const xActive = multiX.length >= 2;
  const yActive = multiY.length >= 2;

  if (!xActive && !yActive) {
    return [];
  }

  const out: GraphFieldBinding[] = [];
  if (xActive) {
    for (let index = 0; index < multiX.length; index += 1) {
      out.push({ role: `multiX${index}`, column: multiX[index].name });
    }
  }
  if (yActive) {
    for (let index = 0; index < multiY.length; index += 1) {
      out.push({ role: `multiY${index}`, column: multiY[index].name });
    }
  }
  return out;
}

export function deriveFields(item: GraphBuilderItem): GraphFieldBinding[] {
  const fields: GraphFieldBinding[] = [];
  const seen = new Set<string>();
  const enabledKinds = hasEnabledElementKinds(item);

  const addField = (role: string, column: string | undefined): void => {
    if (!column || seen.has(`${role}:${column}`)) {
      return;
    }
    seen.add(`${role}:${column}`);
    fields.push({ role, column });
  };

  addField("x", item.encoding.x?.name);
  addField("y", item.encoding.y?.name);
  const has3DElement = enabledKinds.has("surface") || enabledKinds.has("scatter3d");
  if (item.threeD && has3DElement) {
    addField("z", item.encoding.z?.name);
  }

  const canUseSize = enabledKinds.has("points") || enabledKinds.has("scatter3d");
  if (canUseSize) {
    addField("size", item.encoding.size?.name);
  }

  const hasHiddenGroups = (item.hiddenGroups?.length ?? 0) > 0;
  const canUseGroup = enabledKinds.size > 0 || hasHiddenGroups;
  if (canUseGroup) {
    addField("group", deriveGroupingColumn(item));
  }

  addField("groupX", item.encoding.groupX?.name);
    addField("groupZ", item.encoding.groupZ?.name);
  addField("groupY", item.encoding.groupY?.name);
  addField("wrap", item.encoding.wrap?.name);

  for (const filter of item.filters ?? []) {
    addField("filter", filter.rule.field.name);
  }

  for (const multiField of deriveActiveMultiFields(item)) {
    addField(multiField.role, multiField.column);
  }

  return fields;
}

function createRequestId(datasetId: string, generation: number): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${datasetId}-${generation}-${crypto.randomUUID()}`;
  }
  return `${datasetId}-${generation}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useGraphDataPipeline(
  item: GraphBuilderItem,
  dataset: DatasetMeta,
  viewport: GraphViewport,
): GraphDataPipelineResult {
  const [state, setState] = useState<GraphStreamState>(() => createInitialGraphStreamState());
  const [debouncedViewport, setDebouncedViewport] = useState<GraphViewport>(viewport);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedViewport(viewport);
    }, VIEWPORT_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [viewport.height, viewport.width]);

  const requestSkeleton = useMemo(() => {
    const sampling = deriveSampling(item);
    const fields = deriveFields(item);
    const filters = serializeFilters(item.filters ?? []);
    const elements = deriveElements(item);

    return {
      datasetId: dataset.id,
      fields,
      filters,
      elements,
      sampling,
      viewport: debouncedViewport,
    };
  }, [dataset.id, item, debouncedViewport]);

  useEffect(() => {
    const hasX = requestSkeleton.fields.some((field) => field.role === "x");
    const hasY = requestSkeleton.fields.some((field) => field.role === "y");
    if (!hasX || !hasY) {
      setState((previous) => ({
        ...previous,
        pending: null,
        pendingHeader: null,
        error: null,
        status: idleStatus(previous.committed),
      }));
      return;
    }

    let disposed = false;
    let cancel: (() => Promise<void>) | null = null;

    const load = async (): Promise<void> => {
      try {
        const [{ dataService }, { graphDataService }] = await Promise.all([
          import("../../services/dataService"),
          import("../../services/graphDataService"),
        ]);

        const generation = await dataService.getDatasetGeneration(dataset.id);
        if (disposed) {
          return;
        }

        const requestId = createRequestId(dataset.id, generation);
        const request: GraphDataRequest = {
          requestId,
          datasetId: dataset.id,
          generation,
          fields: requestSkeleton.fields,
          filters: requestSkeleton.filters,
          elements: requestSkeleton.elements,
          sampling: requestSkeleton.sampling,
          viewport: requestSkeleton.viewport,
        };

        setState((previous) => reduceGraphStream(previous, { type: "start", request }));

        const stream = graphDataService.stream(request, {
          onHeader: (header) => {
            setState((previous) => reduceGraphStream(previous, { type: "header", header }));
          },
          onPayload: (payload) => {
            setState((previous) => reduceGraphStream(previous, { type: "payload", payload }));
          },
          onAggregate: (packet) => {
            setState((previous) => reduceGraphStream(previous, { type: "aggregate", packet }));
          },
          onComplete: (completion) => {
            setState((previous) => reduceGraphStream(previous, { type: "complete", completion }));
          },
          onError: (error) => {
            setState((previous) =>
              reduceGraphStream(previous, {
                type: "error",
                requestId,
                generation,
                error,
              }));
          },
        });

        cancel = stream.cancel;
      } catch (error) {
        if (disposed) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setState((previous) => ({
          ...previous,
          pending: null,
          pendingHeader: null,
          error: message,
          status: "error",
        }));
      }
    };

    void load();

    return () => {
      disposed = true;
      if (cancel) {
        void cancel();
      }
    };
  }, [dataset.id, requestSkeleton]);

  return {
    frame: state.committed,
    status: state.status,
    error: state.error,
    pendingRequest: state.pending?.request ?? null,
  };
}
