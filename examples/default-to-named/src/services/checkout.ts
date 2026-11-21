import config, { type Config } from "../config";
import fmt from "../lib/format";
import Order from "../models/Order";
import sendReceipt from "./mailer";
import Store from "./store";

const store = new Store();

export async function checkout(order: Order, email: string): Promise<string> {
  const settings: Config = config;
  store.put(email, order.total());
  const ok = await sendReceipt(email, `Total: ${fmt(order.total())} ${settings.currency}`);
  return ok ? "sent" : "failed";
}
