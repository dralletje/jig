// An image entrypoint for the runEntrypoint tests: `main` reports the arguments it got, `help` answers
// with a one-action help, or throws when HELP_THROWS is set.
import { imageHelp, okReport, runEntrypoint } from "../../src/index.ts";

await runEntrypoint(
  async (argv) => okReport("sweep", "help-entry", "probe", argv.join(" "), { summary: "Ran main." }),
  () => {
    if (process.env.HELP_THROWS) throw new Error("no help today");
    return imageHelp("Probes the entrypoint.", [
      {
        name: "probe",
        kind: "sweep",
        summary: "Does nothing.",
        flags: [{ name: "--files", type: "globs", required: true, description: "The files." }],
      },
    ]);
  },
);
