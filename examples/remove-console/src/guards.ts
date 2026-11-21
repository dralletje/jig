let calls = 0;

function next(): number {
  calls += 1;
  return calls;
}

export function pureGuard(verbose: boolean, id: string): string {
  if (verbose) console.log("pure guard", id);
  return id;
}

export function guardWithElse(verbose: boolean, id: string): string {
  if (verbose) console.log("with else", id);
  else id = id.trim();
  return id;
}

export function sideEffectGuard(id: string): string {
  if (next() > 1) console.log("side effect guard", id);
  return id;
}

export function loop(ids: string[]): void {
  for (const id of ids) console.log("loop", id);
  while (next() < 3) console.log("waiting");
}
