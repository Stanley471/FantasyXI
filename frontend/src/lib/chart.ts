/**
 * Framework-free chart geometry used by the analytics charts.
 *
 * Kept separate from the React components so scales, ticks and paths can be
 * unit tested without a DOM.
 */

/** Categorical series colours, validated for colour-vision deficiency on the app's dark surface */
export const CHART_COLORS = {
  primary: "#3987e5",
  benchmark: "#d95926",
  tertiary: "#199e70",
  quaternary: "#c98500",
} as const;

export interface LinearScale {
  (value: number): number;
  domain: [number, number];
  range: [number, number];
}

export function linearScale(domain: [number, number], range: [number, number]): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const scale = ((value: number) => r0 + ((value - d0) / span) * (r1 - r0)) as LinearScale;
  scale.domain = domain;
  scale.range = range;
  return scale;
}

/** Rounds a raw step up to 1, 2, 2.5 or 5 times a power of ten */
function niceStep(rawStep: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

/**
 * Evenly spaced, human-friendly tick values covering [min, max].
 * The domain always includes 0 so columns grow from a real baseline.
 */
export function niceTicks(min: number, max: number, targetCount = 5): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (lo === hi) return [0, 1];

  const step = niceStep((hi - lo) / Math.max(1, targetCount - 1));
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= end + step / 2; value += step) {
    // Avoid floating point artefacts such as 0.30000000000000004
    ticks.push(Math.round(value * 1e6) / 1e6);
  }
  return ticks;
}

/**
 * SVG path for a line series. Null values break the line into segments
 * rather than being drawn as zero.
 */
export function buildLinePath(points: Array<{ x: number; y: number | null }>): string {
  let path = "";
  let penDown = false;
  for (const { x, y } of points) {
    if (y === null || !Number.isFinite(y)) {
      penDown = false;
      continue;
    }
    path += `${penDown ? "L" : "M"}${round2(x)},${round2(y)}`;
    penDown = true;
  }
  return path;
}

/**
 * SVG path for a column growing from `baseline` to `top`: the data end has a
 * rounded corner radius, the baseline end stays square. Works for negative
 * values (columns growing downwards).
 */
export function buildColumnPath(
  x: number,
  width: number,
  baseline: number,
  top: number,
  radius = 4
): string {
  const height = Math.abs(baseline - top);
  if (height === 0 || width <= 0) return "";
  const r = Math.min(radius, width / 2, height);
  const dir = top < baseline ? 1 : -1; // 1 = upwards
  const x0 = round2(x);
  const x1 = round2(x + width);
  const b = round2(baseline);
  const t = round2(top);
  const tr = round2(top + dir * r);

  return [
    `M${x0},${b}`,
    `L${x0},${tr}`,
    `Q${x0},${t} ${round2(x + r)},${t}`,
    `L${round2(x + width - r)},${t}`,
    `Q${x1},${t} ${x1},${tr}`,
    `L${x1},${b}`,
    "Z",
  ].join(" ");
}

/**
 * Shows every nth category label so labels of `labelWidth` pixels never
 * overlap in `availableWidth`. Always returns at least 1.
 */
export function labelInterval(count: number, availableWidth: number, labelWidth = 36): number {
  if (count <= 0 || availableWidth <= 0) return 1;
  return Math.max(1, Math.ceil((count * labelWidth) / availableWidth));
}

/** Index of the band containing pixel `x` for `count` equal bands starting at `start` */
export function bandIndexAt(x: number, start: number, bandWidth: number, count: number): number {
  if (count === 0 || bandWidth <= 0) return -1;
  return Math.min(count - 1, Math.max(0, Math.floor((x - start) / bandWidth)));
}

export function formatPoints(value: number | null): string {
  if (value === null) return "—";
  return Number.isInteger(value) ? value.toLocaleString("en-GB") : value.toLocaleString("en-GB", { maximumFractionDigits: 1 });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
