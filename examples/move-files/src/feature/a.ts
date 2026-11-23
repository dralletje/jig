import { shared } from "../shared";
import { b } from "./sub/b";
import type { B } from "./sub/b.ts";
import "./styles.css";

export const a = shared + b.b;

export function useB(x: B): number {
  return x.b;
}
