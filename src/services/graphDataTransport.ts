import type {
  GraphAggregatePacket,
  GraphChunkHeader,
  GraphDataCompletion,
  GraphDataRequest,
} from "../types/graphData.ts";
import { isGraphAggregatePacket as isStrictGraphAggregatePacket } from "../types/graphData.ts";

export interface GraphStreamTransportHandlers {
  onHeader: (header: GraphChunkHeader) => void;
  onPayload: (payload: ArrayBuffer) => void;
  onAggregate: (packet: GraphAggregatePacket) => void;
  onComplete: (completion: GraphDataCompletion) => void;
  onError: (message: string) => void;
}

export interface GraphStreamTransport {
  onChannelMessage: (message: unknown) => void;
  onInvokeResolved: (completion: GraphDataCompletion) => void;
  onInvokeRejected: (error: unknown) => void;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseStructuredMessage(message: unknown): Record<string, unknown> | null {
  if (typeof message === "string") {
    try {
      const parsed = JSON.parse(message) as unknown;
      return toRecord(parsed);
    } catch {
      return null;
    }
  }
  return toRecord(message);
}

function isMessageType(record: Record<string, unknown>, expected: string): boolean {
  const value = record.messageType;
  return value === undefined || value === expected;
}

function isGraphChunkHeader(value: unknown): value is GraphChunkHeader {
  const record = toRecord(value);
  if (!record || !isMessageType(record, "header")) {
    return false;
  }
  return (
    typeof record.requestId === "string"
    && typeof record.generation === "number"
    && Number.isInteger(record.chunkIndex)
    && typeof record.finalChunk === "boolean"
  );
}

function isGraphDataCompletion(value: unknown): value is GraphDataCompletion {
  const record = toRecord(value);
  if (!record || !isMessageType(record, "complete")) {
    return false;
  }
  return (
    typeof record.requestId === "string"
    && typeof record.datasetId === "string"
    && typeof record.generation === "number"
    && Number.isInteger(record.chunksSent)
    && typeof record.cancelled === "boolean"
  );
}

function isGraphAggregatePacket(value: unknown): value is GraphAggregatePacket {
  const record = toRecord(value);
  if (!record || !isMessageType(record, "aggregate")) {
    return false;
  }
  return isStrictGraphAggregatePacket(record);
}

function completionEquals(left: GraphDataCompletion, right: GraphDataCompletion): boolean {
  return (
    left.requestId === right.requestId
    && left.datasetId === right.datasetId
    && left.generation === right.generation
    && left.sourceRows === right.sourceRows
    && left.processedRows === right.processedRows
    && left.chunksSent === right.chunksSent
    && left.cancelled === right.cancelled
  );
}

export function createGraphStreamTransport(
  request: GraphDataRequest,
  handlers: GraphStreamTransportHandlers,
): GraphStreamTransport {
  const seenChunkIndexes = new Set<number>();
  let nextChunkIndex = 0;
  let pendingHeader: GraphChunkHeader | null = null;
  let invokeCompletion: GraphDataCompletion | null = null;
  let closed = false;
  let failed = false;

  const isExpectedRequest = (requestId: string, generation: number): boolean =>
    requestId === request.requestId && generation === request.generation;

  const fail = (message: string): void => {
    if (closed || failed) {
      return;
    }
    failed = true;
    handlers.onError(message);
  };

  return {
    onChannelMessage: (message: unknown): void => {
      if (closed || failed) {
        return;
      }

      if (message instanceof ArrayBuffer) {
        if (!pendingHeader) {
          fail("graph payload arrived before header");
          return;
        }

        const header = pendingHeader;
        pendingHeader = null;
        handlers.onHeader(header);
        handlers.onPayload(message);
        return;
      }

      const structured = parseStructuredMessage(message);
      if (!structured) {
        fail("graph stream emitted an unknown chunk message");
        return;
      }

      if (isGraphChunkHeader(structured)) {
        if (!isExpectedRequest(structured.requestId, structured.generation)) {
          fail("graph header does not match active request");
          return;
        }
        if (pendingHeader) {
          fail("graph header arrived before payload for the previous chunk");
          return;
        }
        if (seenChunkIndexes.has(structured.chunkIndex)) {
          fail(`duplicate graph chunk index ${structured.chunkIndex}`);
          return;
        }
        if (structured.chunkIndex !== nextChunkIndex) {
          fail(
            `graph chunk index ${structured.chunkIndex} arrived out of order (expected ${nextChunkIndex})`,
          );
          return;
        }

        seenChunkIndexes.add(structured.chunkIndex);
        nextChunkIndex += 1;
        pendingHeader = structured;
        return;
      }

      if (isGraphDataCompletion(structured)) {
        if (!isExpectedRequest(structured.requestId, structured.generation)) {
          fail("graph terminal marker does not match active request");
          return;
        }
        if (pendingHeader) {
          fail("graph terminal marker arrived with a pending header");
          return;
        }
        if (!structured.cancelled && structured.chunksSent !== seenChunkIndexes.size) {
          fail("graph terminal marker has inconsistent chunksSent");
          return;
        }
        if (invokeCompletion && !completionEquals(invokeCompletion, structured)) {
          fail("graph terminal marker does not match invoke completion");
          return;
        }

        closed = true;
        handlers.onComplete(structured);
        return;
      }

      if (isGraphAggregatePacket(structured)) {
        if (!pendingHeader) {
          handlers.onAggregate(structured);
          return;
        }
        fail("graph aggregate packet arrived before payload for the previous chunk");
        return;
      }

      fail("graph stream emitted an unknown chunk message");
    },

    onInvokeResolved: (completion: GraphDataCompletion): void => {
      if (closed || failed) {
        return;
      }
      invokeCompletion = completion;
    },

    onInvokeRejected: (error: unknown): void => {
      fail(describeError(error));
    },
  };
}
