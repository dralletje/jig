import { join } from "node:path";
import { actionToml } from "@jig/test-utils";
import { FLOW, THROWS, fakePackage, runWith } from "../../test/fake-package.ts";

// The cases of main.ts, the runner that makes every published transform an action, each against a
// stand-in transform of a fake published package:
// - rename turns the identifier foo into bar (the runner itself: files, parsers, refusals);
// - boom throws on every file;
// - flowy declares the flow parser.
const rename = await fakePackage({ rename: "rewrite" });
await actionToml(join(import.meta.dirname, "rename.toml"), "rename", runWith(rename), { fixture: "fs" });
const boom = await fakePackage({ boom: "rewrite" }, { boom: THROWS });
await actionToml(join(import.meta.dirname, "boom.toml"), "boom", runWith(boom), { fixture: "fs" });
const flowy = await fakePackage({ flowy: "rewrite" }, { flowy: FLOW });
await actionToml(join(import.meta.dirname, "flowy.toml"), "flowy", runWith(flowy), { fixture: "fs" });
