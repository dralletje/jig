import { total } from '@/components/Total.ts';
import { add } from "@/services/store.ts";

add("x");
console.log(total([1, 2, 3]));
