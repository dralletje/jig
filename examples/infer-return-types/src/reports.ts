import { makeLine, makeOrder } from "./models.ts";

export function firstLine(skus: string[]) {
  return makeOrder("report", skus.map((sku) => makeLine(sku, 1))).lines[0];
}

export function reportTitle(name: string): string {
  return `Report ${name}`;
}

export function pageSize() {
  return 20;
}
