export function greet(name: string): string {
  return "Hi " + name + "!";
}

export function describe(name: string, count: number): string {
  return "User " + (name + " has ") + count + " items";
}

export function twice(a: string, b: string): string[] {
  return ["x" + a, "y" + b];
}

export function total(a: number, b: number): number {
  return a + b;
}
