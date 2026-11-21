import { makeLine, makeOrder } from "./models.ts";
import type { Order } from "./models.ts";

export function countLines(order: Order) {
  return order.lines.length;
}

export function totalQuantity(order: Order) {
  return order.lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function describe(order: Order) {
  return { id: order.id, lines: order.lines.length, empty: order.lines.length === 0 };
}

export const skus = (order: Order) => order.lines.map((line) => line.sku);

export function emptyOrder(id: string) {
  return makeOrder(id, []);
}

export function singleLine(sku: string) {
  return makeLine(sku, 1);
}

export function summarize(order: Order) {
  return `${order.id}: ${countLines(order)} lines`;
}

export class OrderService {
  private orders = new Map<string, Order>();

  add(order: Order) {
    this.orders.set(order.id, order);
    return this.orders.size;
  }

  find(id: string) {
    return this.orders.get(id);
  }

  ids() {
    return [...this.orders.keys()];
  }

  private count() {
    return this.orders.size;
  }
}

function normalize(sku: string) {
  return sku.trim().toLowerCase();
}

const double = (n: number) => n * 2;

export function internalUse(order: Order) {
  return double(order.lines.map((line) => normalize(line.sku)).length);
}
