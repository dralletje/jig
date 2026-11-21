import { runEntrypoint } from "@jig/core";
import { help, main } from "./main.ts";

await runEntrypoint(main, help);
