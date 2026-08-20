import { Channel, invoke } from "@tauri-apps/api/core";
import {
  decodeGraphPayload,
  GraphPayloadError,
  type DecodedGraphChunk,
  type GraphChunkHeader,
  type GraphDataCompletion,
  type GraphDataRequest,
} from "@/types/graphData";

export interface GraphDataStreamHandlers {
  onChunk: (chunk: DecodedGraphChunk) => void;
  onComplete: (completion: GraphDataCompletion) => void;
  onError: (message: string) => void;
}

export interface GraphDataStreamController {
  cancel: () => Promise<void>;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isGraphChunkHeader(value: unknown): value is GraphChunkHeader {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.requestId === "string"
    && typeof candidate.generation === "number"
    && Number.isInteger(candidate.chunkIndex)
    && typeof candidate.finalChunk === "boolean"
  );
}

function coerceHeader(value: unknown): GraphChunkHeader | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isGraphChunkHeader(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isGraphChunkHeader(value) ? value : null;
}

export const graphDataService = {
  stream(request: GraphDataRequest, handlers: GraphDataStreamHandlers): GraphDataStreamController {
    const channel = new Channel<unknown>();
    const seenChunkIndexes = new Set<number>();
    let pendingHeader: GraphChunkHeader | null = null;
    let closed = false;
    let failed = false;

    const stopRemoteStream = async (): Promise<void> => {
      try {
        await invoke<void>("cancel_graph_data", { requestId: request.requestId });
      } catch {
        // ignore cancel errors in cleanup paths
      }
    };

    const fail = (message: string): void => {
      if (failed) {
        return;
      }
      failed = true;
      closed = true;
      handlers.onError(message);
      void stopRemoteStream();
    };

    channel.onmessage = (message: unknown) => {
      if (closed || failed) {
        return;
      }

      if (message instanceof ArrayBuffer) {
        if (!pendingHeader) {
          fail("graph payload arrived before header");
          return;
        }
        if (seenChunkIndexes.has(pendingHeader.chunkIndex)) {
          fail(`duplicate graph chunk index ${pendingHeader.chunkIndex}`);
          return;
        }

        const header = pendingHeader;
        pendingHeader = null;

        try {
          const decoded = decodeGraphPayload(header, message);
          seenChunkIndexes.add(header.chunkIndex);
          handlers.onChunk(decoded);
        } catch (error) {
          const detail =
            error instanceof GraphPayloadError || error instanceof Error
              ? error.message
              : String(error);
          fail(`invalid graph payload: ${detail}`);
        }
        return;
      }

      const header = coerceHeader(message);
      if (!header) {
        fail("graph stream emitted an unknown chunk message");
        return;
      }
      if (pendingHeader) {
        fail("graph header arrived before payload for the previous chunk");
        return;
      }
      if (seenChunkIndexes.has(header.chunkIndex)) {
        fail(`duplicate graph chunk index ${header.chunkIndex}`);
        return;
      }

      pendingHeader = header;
    };

    void invoke<GraphDataCompletion>("stream_graph_data", {
      request,
      onChunk: channel,
    })
      .then((completion) => {
        if (closed || failed) {
          return;
        }
        closed = true;
        if (pendingHeader) {
          fail("graph stream completed before receiving payload for the last header");
          return;
        }
        handlers.onComplete(completion);
      })
      .catch((error) => {
        if (closed || failed) {
          return;
        }
        fail(describeError(error));
      });

    return {
      cancel: async () => {
        if (closed) {
          return;
        }
        closed = true;
        await stopRemoteStream();
      },
    };
  },
};
