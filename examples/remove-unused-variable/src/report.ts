export const VERSION = 1;

export function summarize(values: number[]): string {
  const label = "total";
  const unusedLimit = 10;

  const sum = values.reduce((a, b) => a + b, 0);
  return `${label}: ${sum}`;
}
