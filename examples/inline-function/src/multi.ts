// Multi-statement functions: unpacked as a whole statement, a const initializer or a return.
function summarize(items: number[], label: string): string {
  const total = items.reduce((a, b) => a + b, 0);
  const average = total / items.length;
  return `${label}: ${average}`;
}

function logSize(items: number[]): void {
  const size = items.length;
  sizes.push(size);
}

const sizes: number[] = [];

export function report(items: number[]): string {
  const first = summarize(items, "average");
  logSize(items);
  return summarize(items, first);
}
