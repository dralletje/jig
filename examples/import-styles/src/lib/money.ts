export function cents(amount: number): string {
  return `${(amount / 100).toFixed(2)}`;
}
