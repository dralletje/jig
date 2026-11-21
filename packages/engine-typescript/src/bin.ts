import { actionHelp, imageHelp, runEntrypoint } from "@jig/core";
import { ACTIONS, main } from "./main.ts";

await runEntrypoint(main, () =>
  imageHelp("Refactors TypeScript and JavaScript with the TypeScript language service.", ACTIONS.map(actionHelp)),
);
