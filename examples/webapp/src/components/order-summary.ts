import { Order } from "@/models";
import { describeOrder, discount } from "@/services";
import { formatPrice, percentage } from "@/lib";
import config from "@/config";

export function renderOrderSummary(order: Order, percent: number) {
  const off = discount(order, percent);
  return `${describeOrder(order, config.locale)}, ${formatPrice(off)} off (${percentage(percent, 100)}%)`;
}
