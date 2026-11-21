import { Shape, Unit } from "./geometry";

export const unit: Unit = "cm";

export function label(shape: Shape): string {
  return shape.name;
}
