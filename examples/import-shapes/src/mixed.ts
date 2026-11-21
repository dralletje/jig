import "./side";
import describe, { Circle, Shape, Unit, area } from "./geometry";

export const unit: Unit = "m";
export const shape: Shape = new Circle(2);

export const text = describe(shape) + area(new Circle(1));
