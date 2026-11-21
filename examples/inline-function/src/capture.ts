// An argument that a variable inside the body would capture.
const addAll = (xs: number[], x: number) => xs.map((i) => i + x);

export function shift(items: number[], i: number): number[] {
  return addAll(items, i);
}
