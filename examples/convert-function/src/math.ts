export function add(a: number, b: number): number {
  return a + b;
}

export const double = (n: number): number => n * 2;

export const first = <T>(items: T[]): T | undefined => items[0];
