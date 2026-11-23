/// <reference path="./feature/sub/b.ts" />
import { a } from "./feature/a.ts";
import { a as viaAlias } from "@/feature/a";
import { a as viaSubpath } from "#/feature/a.ts";
import { a as viaIndex } from "./feature";
import { shared } from "./shared";

declare function require(id: string): unknown;

export const all = [a, viaAlias, viaSubpath, viaIndex, shared];

export const lazy = () => import("./feature/sub/b");

export const legacy = () => require("./feature/sub/b.ts");
