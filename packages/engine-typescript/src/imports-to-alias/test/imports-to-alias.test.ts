import { join } from "node:path";
import { actionToml } from "@jig/test-utils";
import { errors } from "../../../test/helpers.ts";
import { main } from "../../main.ts";

await actionToml(join(import.meta.dirname, "imports-to-alias.toml"), "imports-to-alias", main, {
  fixture: "examples/import-styles",
  typeErrors: errors,
});
