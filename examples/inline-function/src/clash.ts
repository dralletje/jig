// A body local and a parameter that clash with names at the call site are renamed.
function normalize(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  return values.map((v) => v / total);
}

export function shares(values: number[], total: number): number[] {
  const parts = normalize(values);
  return parts.map((p) => p * total);
}
