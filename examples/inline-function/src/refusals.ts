// Functions that are never unpacked.
function fact(n: number): number {
  return n <= 1 ? 1 : n * fact(n - 1);
}

function whoAmI() {
  return this;
}

function count() {
  return arguments.length;
}

function sign(n: number): number {
  if (n < 0) {
    return -1;
  }
  return 1;
}

async function load(id: string) {
  return id;
}

function* gen() {
  yield 1;
}

export function run() {
  const f = fact(5);
  const w = whoAmI();
  const c = count();
  const s = sign(-3);
  const l = load("a");
  const g = gen();
  return [f, w, c, s, l, g];
}
