// A side-effecting argument is evaluated once: hoisted into a const.
declare function next(): number;
declare function a(): number;
declare function b(): number;

function twice(n: number): number {
  return n + n;
}

function bump(n: number): number {
  return n + 1;
}

export function ids(): number {
  return twice(next());
}

export function mixed(): number {
  return a() + bump(b());
}
