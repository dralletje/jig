import { join } from "node:path";
import { actionToml } from "@jig/test-utils";
import { errors } from "../../../test/helpers.ts";
import { main } from "../../main.ts";

await actionToml(join(import.meta.dirname, "remove-unused-variable.toml"), "remove-unused-variable", main, {
  fixture: "examples/remove-unused-variable",
  typeErrors: errors,
});
