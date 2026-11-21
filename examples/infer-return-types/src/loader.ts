export function parseOrder(text: string) {
  return JSON.parse(text);
}

export function parseCount(text: string): number {
  return Number(text);
}
