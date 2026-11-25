import { join } from "node:path";
import { actionToml } from "@jig/test-utils";
import { errors } from "../../../test/helpers.ts";
import { main } from "../../main.ts";

await actionToml(join(import.meta.dirname, "params-to-object.toml"), "params-to-object", main, {
  fixture: "examples/params-to-object",
  typeErrors: errors,
});
