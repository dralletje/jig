export type Order = { id: string; total: number };

export function process(order: Order): number {
  console.log("processing", order.id);
  const tax = order.total * 0.2;

  console.debug("tax", tax); // temporary

  // keep the rounding rule in one place
  const rounded = Math.round(tax * 100) / 100;
  console.warn("rounded", rounded);
  return order.total + rounded;
}

export function summarize(orders: Order[]): number {
  return orders.reduce((sum, order) => {
    console.log("adding", order.id);
    return sum + order.total;
  }, 0);
}

export const trace = (message: string) => console.log(message);

export function describe(order: Order): string {
  const logged = console.log("describing", order.id);
  void logged;
  return `order ${order.id}`;
}
