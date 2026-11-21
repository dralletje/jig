export type Unit = "cm" | "m";

export interface Shape {
  name: string;
  unit: Unit;
}

export class Circle implements Shape {
  name = "circle";
  unit: Unit = "cm";
  constructor(readonly radius: number) {}
}

export function area(circle: Circle): number {
  return 3 * circle.radius * circle.radius;
}

export default function describe(shape: Shape): string {
  return `${shape.name} in ${shape.unit}`;
}
