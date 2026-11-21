import * as math from "./math";

export const sum = math.add(1, 2);
export const product = math.mul(3, 4);
export const again = math.add(sum, product);
export const pi: typeof math.PI = math.PI;
export const pair: math.Pair = { left: sum, right: product };
