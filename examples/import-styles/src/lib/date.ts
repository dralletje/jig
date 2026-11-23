export type Day = { year: number; month: number; day: number };

export function formatDay(d: Day): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}
