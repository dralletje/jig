import { orderItem } from "./order_item";

export function orderTotal(price: number): number {
  return price * orderItem.quantity;
}
