import { add, double, first } from "./math.ts";

export const total = double(add(1, 2));
export const head = first([total, 7]);
