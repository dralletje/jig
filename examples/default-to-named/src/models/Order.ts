export type OrderLine = { sku: string; cents: number };

export default class Order {
  constructor(readonly lines: OrderLine[]) {}

  total(): number {
    return this.lines.reduce((sum, line) => sum + line.cents, 0);
  }
}
