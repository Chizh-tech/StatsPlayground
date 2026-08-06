export const FIT_BAND_ID_PREFIX = "__fit_band_";

type Point = [number, number];

interface RenderParams {
  dataIndex?: number;
  seriesId?: string;
}

interface RenderApi {
  coord(point: Point): Point;
}

export function buildBandSeries(
  lower: Point[],
  upper: Point[],
  color: string,
  opacity: number,
  idPrefix: string,
): any[] {
  if (lower.length === 0 || lower.length !== upper.length) return [];

  return [{
    id: `${FIT_BAND_ID_PREFIX}${idPrefix}`,
    type: "custom",
    coordinateSystem: "cartesian2d",
    clip: true,
    data: [...lower, ...upper],
    renderItem(params: RenderParams, api: RenderApi) {
      if ((params.dataIndex ?? 0) !== 0) return null;
      const transposed = params.seriesId?.endsWith("__t") ?? false;
      const toPixel = ([x, y]: Point): Point =>
        api.coord(transposed ? [y, x] : [x, y]);
      const points = lower.map(toPixel);
      for (let i = upper.length - 1; i >= 0; i--) {
        points.push(toPixel(upper[i]));
      }
      return {
        type: "polygon",
        shape: { points },
        style: { fill: color, opacity },
      };
    },
    animation: false,
    silent: true,
    z: 2,
    legendHoverLink: false,
  }];
}