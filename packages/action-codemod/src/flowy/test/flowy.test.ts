import { join } from "node:path";
import { actionToml } from "@jig/test-utils";
import { FLOW, fakePackage, runWith } from "../../../test/fake-package.ts";

const pkg = await fakePackage({ flowy: "rewrite" }, { flowy: FLOW });
await actionToml(join(import.meta.dirname, "flowy.toml"), "flowy", runWith(pkg), { fixture: "fs" });
