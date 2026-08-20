import { Channel, invoke } from "@tauri-apps/api/core";
import {
  type GraphChunkHeader,
  type GraphDataCompletion,
  type GraphDataRequest,
} from "@/types/graphData";
import {
  createGraphStreamTransport,
  type GraphStreamTransportHandlers,
} from "./graphDataTransport";

export interface GraphDataStreamHandlers {
  onHeader: (header: GraphChunkHeader) => void;
  onPayload: (payload: ArrayBuffer) => void;
  onComplete: (completion: GraphDataCompletion) => void;
  onError: (message: string) => void;
}

export interface GraphDataStreamController {
  cancel: () => Promise<void>;
}

export const graphDataService = {
  stream(request: GraphDataRequest, handlers: GraphDataStreamHandlers): GraphDataStreamController {
    const channel = new Channel<unknown>();
    let closed = false;

    const stopRemoteStream = async (): Promise<void> => {
      try {
        await invoke<void>("cancel_graph_data", { requestId: request.requestId });
      } catch {
        // ignore cancel errors in cleanup paths
      }
    };

    const transportHandlers: GraphStreamTransportHandlers = {
      onHeader: (header) => {
        if (closed) {
          return;
        }
        handlers.onHeader(header);
      },
      onPayload: (payload) => {
        if (closed) {
          return;
        }
        handlers.onPayload(payload);
      },
      onComplete: (completion) => {
        if (closed) {
          return;
        }
        closed = true;
        handlers.onComplete(completion);
      },
      onError: (message) => {
        if (closed) {
          return;
        }
        closed = true;
        handlers.onError(message);
        void stopRemoteStream();
      },
    };

    const transport = createGraphStreamTransport(request, transportHandlers);

    channel.onmessage = (message: unknown) => {
      if (closed) {
        return;
      }
      transport.onChannelMessage(message);
    };

    void invoke<GraphDataCompletion>("stream_graph_data", {
      request,
      onChunk: channel,
    })
      .then((completion) => {
        transport.onInvokeResolved(completion);
      })
      .catch((error) => {
        transport.onInvokeRejected(error);
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
