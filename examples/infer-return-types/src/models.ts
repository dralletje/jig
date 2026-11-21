export interface Line {
  sku: string;
  quantity: number;
}

export interface Order {
  id: string;
  lines: Line[];
}

export function makeLine(sku: string, quantity: number): Line {
  return { sku, quantity };
}

export function makeOrder(id: string, lines: Line[]): Order {
  return { id, lines };
}
