import type { GraphTableData } from "../components/graphBuilder/loadGraphTableData.ts";

interface CacheEntry {
  datasetId: string;
  generation: number;
  data: GraphTableData;
}

export class GraphTableDataCache {
  private _epoch = 1;
  private _entry: CacheEntry | undefined = undefined;

  captureEpoch(): number {
    return this._epoch;
  }

  get(datasetId: string, generation: number): GraphTableData | undefined {
    const e = this._entry;
    if (!e) return undefined;
    if (e.datasetId !== datasetId) return undefined;
    if (e.generation !== generation) {
      // evict stale same-dataset entry, do not advance epoch
      this._entry = undefined;
      return undefined;
    }
    return e.data;
  }

  putIfCurrent(epoch: number, datasetId: string, generation: number, data: GraphTableData): boolean {
    if (epoch !== this._epoch) return false;
    this._entry = { datasetId, generation, data };
    return true;
  }

  invalidateDataset(datasetId: string): void {
    this._epoch++;
    if (this._entry && this._entry.datasetId === datasetId) this._entry = undefined;
  }

  clear(): void {
    this._epoch++;
    this._entry = undefined;
  }
}

export const graphTableDataCache = new GraphTableDataCache();
