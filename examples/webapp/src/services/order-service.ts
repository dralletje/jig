import { Order, OrderItem } from "@/models/order_item";
import * as math from "@/lib/math";
import { currency } from "@/lib";
import config from "@/config";

function lineTotal(item: OrderItem) {
  return item.quantity * item.unitPrice;
}

export function orderTotal(order: Order) {
  return math.sum(order.items.map(lineTotal));
}

export function describeOrder(order: Order, locale: string) {
  const total = orderTotal(order);
  console.log("describing order", order.id);
  return `${order.items.length} items, ${currency(total, config.currency, locale)}`;
}

export function discount(order: Order, percent: number) {
  return orderTotal(order) * (math.clamp(percent, 0, 100) / 100);
}
