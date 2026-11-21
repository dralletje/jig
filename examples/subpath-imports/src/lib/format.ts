import { clamp } from "@/lib/math.ts";

export function percent(value: number): string {
  return `${clamp(value, 0, 100)}%`;
}
