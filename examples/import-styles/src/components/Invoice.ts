import { formatDay } from "../lib/date.ts";
import type { Day } from "@/lib/date.ts";
import { cents } from "#/lib/money.ts";

export function invoiceLine(day: Day, amount: number): string {
  return `${formatDay(day)}: ${cents(amount)}`;
}

export const loadLib = () => import("../lib/index.ts");
