/** @import { useB } from "./feature/a.ts" */

/**
 * @param {import("./feature/sub/b.ts").B} value
 * @param {typeof useB} use
 */
export function apply(value, use) {
  return use(value);
}
