import { Channel, invoke } from "@tauri-apps/api/core";
import {
  type GraphChunkHeader,
  type GraphDataCompletion,
  type GraphDataRequest,
} from "@/types/graphData";

export interface GraphDataStreamHandlers {
  onHeader: (header: GraphChunkHeader) => void;
  onPayload: (payload: ArrayBuffer) => void;
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
    let nextChunkIndex = 0;
    let pendingHeader: GraphChunkHeader | null = null;
    let closed = false;
    let failed = false;
    let pendingCompletion: GraphDataCompletion | null = null;
    let completionDispatched = false;

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

    const maybeDispatchCompletion = (): void => {
      if (completionDispatched || !pendingCompletion || closed || failed) {
        return;
      }
      if (pendingHeader) {
        return;
      }
      if (!pendingCompletion.cancelled && seenChunkIndexes.size < pendingCompletion.chunksSent) {
        return;
      }
      completionDispatched = true;
      closed = true;
      handlers.onComplete(pendingCompletion);
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

        const header = pendingHeader;
        pendingHeader = null;
        handlers.onHeader(header);
        handlers.onPayload(message);
        maybeDispatchCompletion();
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
      if (header.chunkIndex !== nextChunkIndex) {
        fail(
          `graph chunk index ${header.chunkIndex} arrived out of order (expected ${nextChunkIndex})`,
        );
        return;
      }

      seenChunkIndexes.add(header.chunkIndex);
      nextChunkIndex += 1;
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
        // Completion can resolve before the final payload callback is delivered.
        // Keep transport parsing active and dispatch completion after pairing settles.
        pendingCompletion = completion;
        maybeDispatchCompletion();
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
