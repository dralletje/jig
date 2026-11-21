import { foo, keep } from "./a";

export { foo as renamedFoo } from "./a";

const o = { foo };

export const total = foo() + keep;

export default o;
