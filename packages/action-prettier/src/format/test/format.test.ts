import { join } from "node:path";
import { actionToml } from "@jig/test-utils";
import { main } from "../../main.ts";

await actionToml(join(import.meta.dirname, "format.toml"), "format", main, { fixture: "fs" });
