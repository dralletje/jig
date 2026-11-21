/** Reports are rare: their math is loaded on demand. */
export async function totalOf(values: number[]) {
  const { sum } = await import("./lib/math");
  return sum(values);
}
