// Exported, and used as a value: only single calls can be unpacked.
export function format(n: number): string {
  return `#${n}`;
}

function pad(n: number): string {
  return String(n).padStart(3, "0");
}

export const label = (n: number) => format(n) + pad(n);

export const handlers = [pad];
