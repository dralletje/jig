function square(x: number) {
  return x * x;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function distance(x1: number, y1: number, x2: number, y2: number) {
  return Math.sqrt(square(x2 - x1) + square(y2 - y1));
}

export function percentage(part: number, total: number) {
  if (total === 0) return 0;
  return Math.round((part / total) * 100);
}

export const sum = (values: number[]) => values.reduce((acc, value) => acc + value, 0);
