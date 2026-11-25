import { join } from "node:path";
import { actionToml } from "@jig/test-utils";
import { errors } from "../../../test/helpers.ts";
import { main } from "../../main.ts";

await actionToml(join(import.meta.dirname, "namespace-to-named.toml"), "namespace-to-named", main, {
  fixture: "examples/import-shapes",
  typeErrors: errors,
});
