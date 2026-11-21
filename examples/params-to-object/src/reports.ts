import { parcelLabel, shippingCost, totalWeight } from "./shipping";

export function weeklyReport(weights: number[]): string[] {
  const lines = weights.map((w) => `${parcelLabel("w", "[", "]")} ${shippingCost(w, 120, false)}`);
  lines.push(`total ${totalWeight(...weights)}`);
  return lines;
}
