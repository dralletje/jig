import { join } from "node:path";
import { actionToml } from "@jig/test-utils";
import { THROWS, fakePackage, runWith } from "../../../test/fake-package.ts";

const pkg = await fakePackage({ boom: "rewrite" }, { boom: THROWS });
await actionToml(join(import.meta.dirname, "boom.toml"), "boom", runWith(pkg), { fixture: "fs" });
