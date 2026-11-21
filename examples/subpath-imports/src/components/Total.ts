import { sum } from "@/lib/index.ts";
import { percent } from "@/lib/format.ts";
import type { items } from "@/services/store.ts";
import { appName } from "#config";
import { helper } from "../lib/relative.ts";

export type Items = typeof items;

export function total(values: number[]): string {
  return `${appName}: ${percent(sum(values))} ${helper()}`;
}

export const lazy = () => import("@/lib/math.ts");
