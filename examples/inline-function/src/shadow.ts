// A free variable of the function that is shadowed at a call site.
const rate = 0.2;

function withTax(price: number): number {
  return price * (1 + rate);
}

export function net(price: number): number {
  return withTax(price);
}

export function shadowed(price: number, rate: number): number {
  return withTax(price) + rate;
}
