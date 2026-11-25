import { join } from "node:path";
import { actionToml } from "@jig/test-utils";
import { errors } from "../../../test/helpers.ts";
import { main } from "../../main.ts";

await actionToml(join(import.meta.dirname, "replace-same-behavior.toml"), "replace-same-behavior", main, {
  fixture: "examples/replace-same-behavior",
  typeErrors: errors,
});
