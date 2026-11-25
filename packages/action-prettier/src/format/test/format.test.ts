import { join } from "node:path";
import { actionToml } from "@jig/test-utils";
import { main } from "../../main.ts";

// The cases pass the globs as `globs`: `files` is the key for extra files, not a flag.
await actionToml(
  join(import.meta.dirname, "format.toml"),
  "format",
  (argv, dir) => main(argv.map((arg) => (arg === "--globs" ? "--files" : arg)), dir),
  { fixture: "fs" },
);
