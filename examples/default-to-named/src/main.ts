import { Order, formatPrice } from "./index";
import { checkout } from "./services/checkout";

const order = new Order([{ sku: "a-1", cents: 1250 }]);
console.log(formatPrice(order.total()));
await checkout(order, "ada@example.com");
