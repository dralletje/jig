import { join } from "node:path";
import { actionToml } from "@jig/test-utils";
import { fakePackage, runWith } from "../../../test/fake-package.ts";

// `rename` is a stand-in transform that renames the identifier foo to bar: the cases are about the
// runner every transform shares.
const pkg = await fakePackage({ rename: "rewrite" });
await actionToml(join(import.meta.dirname, "rename.toml"), "rename", runWith(pkg), { fixture: "fs" });
