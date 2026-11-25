import { join } from "node:path";
import { actionToml } from "@jig/test-utils";
import { errors } from "../../../test/helpers.ts";
import { main } from "../../main.ts";

await actionToml(join(import.meta.dirname, "default-to-named.toml"), "default-to-named", main, {
  fixture: "examples/default-to-named",
  typeErrors: errors,
});
