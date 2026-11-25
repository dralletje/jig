import { join } from "node:path";
import { actionToml } from "@jig/test-utils";
import { errors } from "../../../test/helpers.ts";
import { main } from "../../main.ts";

await actionToml(join(import.meta.dirname, "import-type.toml"), "import-type", main, {
  fixture: "examples/import-shapes",
  typeErrors: errors,
});
