import { join } from "node:path";
import { actionToml } from "@jig/test-utils";
import { errors } from "../../../test/helpers.ts";
import { main } from "../../main.ts";

await actionToml(join(import.meta.dirname, "imports-to-subpath.toml"), "imports-to-subpath", main, {
  fixture: "examples/import-styles",
  typeErrors: errors,
});
