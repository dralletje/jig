import { keep } from "./a";

export function outer(n: number) {
  function double(x: number) {
    return x * 2 + keep;
  }
  const LIMIT = 10;
  const clamp = (x: number) => Math.min(x, LIMIT);
  function scaled() {
    return n * 3;
  }
  const started = Date.now();
  const here = () => import.meta;
  return clamp(double(n)) + scaled() + started + (here() ? 0 : 1);
}
