import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { RefactorError, imageHelp, listFiles, listLines, matchesAnyGlob, okReport, plural } from "@jig/core";
import type { ImageHelp, Report } from "@jig/core";
import jscodeshift from "jscodeshift";
import { TRANSFORMS } from "./catalog.ts";
import type { TransformInfo } from "./catalog.ts";

/** The published codemod package an image carries: where it is, its version, and its transforms. */
export type CodemodPackage = {
  name: string;
  version: string;
  /** Folder of the package; transform `<t>` is `<dir>/transforms/<t>.js`. */
  dir: string;
  transforms: Record<string, TransformInfo>;
};

const PARSERS = ["tsx", "ts", "babel", "flow"] as const;
type Parser = (typeof PARSERS)[number];
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** Declaration files hold no code a transform could change. */
const DECLARATION_FILE = /\.d\.[cm]?ts$/;

/** The package named by `CODEMOD_PACKAGE`, resolved from this image's node_modules. */
export function installedPackage(env: NodeJS.ProcessEnv = process.env): CodemodPackage {
  const name = env.CODEMOD_PACKAGE ?? "";
  const transforms = Object.hasOwn(TRANSFORMS, name) ? TRANSFORMS[name] : undefined;
  if (!transforms) {
    throw new Error(`CODEMOD_PACKAGE ${JSON.stringify(name)} is not a known codemod package (${Object.keys(TRANSFORMS).join(", ")})`);
  }
  const manifest = createRequire(import.meta.url).resolve(`${name}/package.json`);
  const version = (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
  return { name, version, dir: dirname(manifest), transforms };
}

type Flags = { transform: string; globs: string[]; parser: Parser | undefined };

function parseFlags(args: string[]): Flags {
  let values: { transform?: string; files?: string; parser?: string };
  try {
    values = parseArgs({ args, options: { transform: { type: "string" }, files: { type: "string" }, parser: { type: "string" } } }).values;
  } catch (e) {
    throw new RefactorError("INVALID_ARGS", `${(e as Error).message}. codemod takes --transform <name> --files <glob,glob> [--parser tsx|ts|babel|flow].`);
  }
  if (!values.transform) throw new RefactorError("INVALID_ARGS", "Missing --transform. Pass --transform <name> --files <glob,glob>.");
  const globs = (values.files ?? "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
  if (globs.length === 0) throw new RefactorError("INVALID_ARGS", "Missing --files. Pass --files <glob,glob>.");
  const parser = values.parser;
  if (parser !== undefined && !(PARSERS as readonly string[]).includes(parser)) {
    throw new RefactorError("INVALID_ARGS", `Unknown --parser ${JSON.stringify(parser)}. Use one of: ${PARSERS.join(", ")}.`);
  }
  return { transform: values.transform, globs, parser: parser as Parser | undefined };
}

type Transform = ((file: { path: string; source: string }, api: unknown, options: object) => unknown) & { parser?: string };

async function loadTransform(pkg: CodemodPackage, name: string): Promise<Transform> {
  const mod = (await import(pathToFileURL(join(pkg.dir, "transforms", `${name}.js`)).href)) as { default: Transform };
  return mod.default;
}

function parserFor(file: string, flag: Parser | undefined, transform: Transform): Parser {
  if (flag) return flag;
  if (file.endsWith(".tsx")) return "tsx";
  if (/\.[cm]?ts$/.test(file)) return "ts";
  return transform.parser === "tsx" || transform.parser === "ts" || transform.parser === "flow" ? transform.parser : "babel";
}

/** The `(line:col)` a parser error carries: split off the message, so the line goes in front as `path:line:`. */
function splitPosition(message: string): { text: string; line: number } {
  const match = /\s*\((\d+):(\d+)\)/.exec(message);
  if (!match) return { text: message, line: 1 };
  return { text: (message.slice(0, match.index) + message.slice(match.index + match[0].length)).trim(), line: Number(match[1]) };
}

function firstLine(text: string): string {
  return text.split("\n")[0]!.trim() || "unknown error";
}

/**
 * The codemod image's help: its one action, `codemod`, whose kinds are those of the carried package's
 * transforms; each `--transform` choice carries its transform's kind, the kind of the commit it makes.
 * `pkg` is the package the image carries (injected by tests).
 */
export function help(pkg?: CodemodPackage): ImageHelp {
  const carried = pkg ?? installedPackage();
  const names = Object.keys(carried.transforms).sort();
  const used = Object.values(carried.transforms).map((transform) => transform.kind);
  const kinds = (["refactor", "sweep", "rewrite"] as const).filter((kind) => used.includes(kind));
  return imageHelp(`Runs a transform of ${carried.name} ${carried.version} with jscodeshift.`, [
    {
      name: "codemod",
      kinds,
      summary: `Runs one transform of ${carried.name} ${carried.version} over the matching JavaScript and TypeScript files.`,
      flags: [
        {
          name: "--transform",
          type: "choice",
          choices: names.map((name) => ({
            name,
            description: carried.transforms[name]!.description,
            kind: carried.transforms[name]!.kind,
          })),
          required: true,
          description: "Which transform to run.",
        },
        {
          name: "--files",
          type: "globs",
          required: true,
          description: "The files to run it on. Only JavaScript and TypeScript files are passed to it, declaration files not.",
        },
        {
          name: "--parser",
          type: "choice",
          choices: [
            { name: "tsx", description: "TypeScript with JSX." },
            { name: "ts", description: "TypeScript without JSX." },
            { name: "babel", description: "JavaScript with JSX, through Babel." },
            { name: "flow", description: "JavaScript with Flow types." },
          ],
          required: false,
          description: "The parser for every file. Without it: tsx for .tsx, ts for .ts, .mts and .cts, else the transform's own or babel.",
        },
      ],
    },
  ]);
}

/**
 * The codemod image's entrypoint: `codemod --transform <name> --files <glob,glob> [--parser tsx|ts|babel|flow]`
 * runs one transform of the pinned package, with jscodeshift's API, over the matching JavaScript and
 * TypeScript files under `root`. `pkg` is the package the image carries (injected by tests).
 */
export async function main(argv: string[], root: string, pkg?: CodemodPackage): Promise<Report> {
  const [id, ...args] = argv;
  if (id !== "codemod") {
    throw new RefactorError("UNKNOWN_ACTION", `Unknown action ${JSON.stringify(id ?? "")}. This image has: codemod.`);
  }
  const { transform: name, globs, parser: flag } = parseFlags(args);
  const carried = pkg ?? installedPackage();
  const kind = Object.hasOwn(carried.transforms, name) ? carried.transforms[name]!.kind : undefined;
  if (kind === undefined) {
    throw new RefactorError(
      "INVALID_ARGS",
      `Unknown transform ${JSON.stringify(name)}. ${carried.name}@${carried.version} has: ${Object.keys(carried.transforms).sort().join(", ")}.`,
    );
  }
  const transform = await loadTransform(carried, name);
  const files: string[] = [];
  /** Each file the transform threw on: `path:line: reason`, then what to do, indented under it. */
  const notHandled: string[] = [];
  for (const file of await listFiles(root)) {
    if (!matchesAnyGlob(file, globs) || !SOURCE_FILE.test(file) || DECLARATION_FILE.test(file)) continue;
    const abs = join(root, file);
    const source = await readFile(abs, "utf8");
    const j = jscodeshift.withParser(parserFor(file, flag, transform));
    let out: unknown;
    try {
      out = await transform({ path: abs, source }, { jscodeshift: j, j, stats: () => {}, report: () => {} }, {});
    } catch (e) {
      const why = splitPosition(firstLine(e instanceof Error ? e.message : String(e)));
      notHandled.push(
        `${file}:${why.line}: ${name} failed: ${why.text}\n    Apply ${name} to ${file} by hand, or run again with --parser set to the dialect it uses.`,
      );
      continue;
    }
    if (typeof out === "string" && out !== source) {
      await writeFile(abs, out);
      files.push(file);
    }
  }
  const ran =
    files.length === 0
      ? `Ran ${name} from ${carried.name} ${carried.version}; it changed no files.`
      : `Ran ${name} from ${carried.name} ${carried.version} on ${plural(files.length, "file")}:\n${listLines(files)}`;
  return okReport(kind, `${carried.name}@${carried.version}/${name}`, globs.join(", "), {
    summary: notHandled.length === 0 ? ran : `${ran}\n\nNot handled (${notHandled.length}):\n${notHandled.map((n) => `  ${n}`).join("\n")}`,
  });
}
