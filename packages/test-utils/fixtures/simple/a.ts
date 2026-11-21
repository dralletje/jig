export function foo() {
  return helper() + 1;
}

export function helper() {
  return 41;
}

export const keep = 1;

export interface Shape {}

export type Shape2 = Shape;

export const shared = 1;

export interface shared {}
