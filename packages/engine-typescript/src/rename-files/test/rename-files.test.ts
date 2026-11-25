import { join } from "node:path";
import { actionToml } from "@jig/test-utils";
import { errors } from "../../../test/helpers.ts";
import { main } from "../../main.ts";

// The example holds Helpers.ts next to helpers.ts on purpose; TypeScript complains about that pair.
const typeErrors = async (dir: string, file: string) =>
  (await errors(dir, file)).filter((e) => !e.includes("only in casing"));

await actionToml(join(import.meta.dirname, "rename-files.toml"), "rename-files", main, {
  fixture: "examples/rename-files",
  typeErrors,
});