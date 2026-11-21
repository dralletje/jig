// Single-expression functions: inlined anywhere, parameters substituted.
const square = (n: number) => n * n;

const area = (width: number, height: number) => {
  return width * height;
};

const plus = (a: number, b: number) => a + b;

export function describe(side: number, w: number, h: number): string {
  const s = square(side);
  const a = area(w, h);
  return `${s + square(w)}:${a}`;
}

export const scaled = (v: number) => 1 + square(v) * 2;

export const doubled = (w: number) => plus(w, 1) * 2;
