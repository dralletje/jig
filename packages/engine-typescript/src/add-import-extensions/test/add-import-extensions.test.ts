import { join } from "node:path";
import { actionToml } from "@jig/test-utils";
import { errors } from "../../../test/helpers.ts";
import { main } from "../../main.ts";

await actionToml(join(import.meta.dirname, "add-import-extensions.toml"), "add-import-extensions", main, {
  fixture: "examples/webapp",
  typeErrors: errors,
});
