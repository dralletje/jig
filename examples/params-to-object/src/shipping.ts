export type Zone = "domestic" | "europe" | "world";

/** What a parcel costs to send: a base rate per kilometre, plus a surcharge when it is urgent. */
export function shippingCost(weightKg: number, distanceKm: number, express: boolean): number {
  const base = weightKg * 0.4 + distanceKm * 0.05;
  return express ? base * 1.5 : base;
}

/** A label line for a parcel: the prefix and suffix are optional. */
export function parcelLabel(name: string, prefix = "#", suffix?: string): string {
  return `${prefix}${name}${suffix ?? ""}`;
}

export function describeZone(zone: Zone): string {
  return zone === "domestic" ? "inside the country" : zone === "europe" ? "inside Europe" : "overseas";
}

export function totalWeight(...weights: number[]): number {
  return weights.reduce((sum, w) => sum + w, 0);
}

export function parseWeight(text: string): number;
export function parseWeight(text: string, unit: "kg" | "g"): number;
export function parseWeight(text: string, unit: "kg" | "g" = "kg"): number {
  const value = Number.parseFloat(text);
  return unit === "g" ? value / 1000 : value;
}

export function notify(address: string, message: string): string {
  return `to ${address}: ${message}`;
}
