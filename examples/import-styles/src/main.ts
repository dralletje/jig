import { invoiceLine } from "./components/Invoice.ts";
import { formatDay } from "@/lib/index.ts";

console.log(invoiceLine({ year: 2026, month: 1, day: 2 }, 1250));
console.log(formatDay({ year: 2026, month: 1, day: 3 }));
