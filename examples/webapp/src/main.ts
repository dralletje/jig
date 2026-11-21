import config from "@/config";
import { createUser, isAdmin } from "@/services";
import { renderUserCard } from "@/components/UserCard";
import { renderOrderSummary } from "@/components/order-summary";
import * as strings from "@/lib/strings";
import { distance } from "@/lib";

const admin = createUser("ada lovelace", "ada@example.com", "admin");
console.log(`${config.appName}: ${renderUserCard(admin, false)}`);
console.log(isAdmin(admin) ? "admin" : "not admin", strings.isSlug(admin.id));

const order = {
  id: "o-1",
  userId: admin.id,
  items: [
    { sku: "book", quantity: 2, unitPrice: 12.5 },
    { sku: "pen", quantity: 10, unitPrice: 1.2 },
  ],
};
console.log(renderOrderSummary(order, 15));
console.log(distance(0, 0, 3, 4));
