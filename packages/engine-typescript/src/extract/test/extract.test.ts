import { join } from "node:path";
import { actionToml } from "@jig/test-utils";
import { errors } from "../../../test/helpers.ts";
import { main } from "../../main.ts";

await actionToml(join(import.meta.dirname, "extract.toml"), "extract", main, {
  fixture: "simple",
  typeErrors: errors,
});
