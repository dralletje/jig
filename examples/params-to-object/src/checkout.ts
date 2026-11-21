import { parcelLabel, shippingCost } from "./shipping";

export function checkout(weightKg: number, distanceKm: number): string {
  const standard = shippingCost(weightKg, distanceKm, false);
  const fast = shippingCost(weightKg, distanceKm, true);
  return `${parcelLabel("order")}: ${standard.toFixed(2)} or ${fast.toFixed(2)} (fast)`;
}
