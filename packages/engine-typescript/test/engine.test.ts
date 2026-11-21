import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { RefactorError } from "@jig/core";
import { makeRepo } from "@jig/test-utils";
import { TsEngine } from "../src/index.ts";
import type { Project } from "../src/index.ts";
import type ts from "typescript";

function caught(fn: () => unknown): RefactorError {
  try {
    fn();
  } catch (e) {
    return e as RefactorError;
  }
  throw new Error("expected throw");
}

/** Puts a stand-in `typescript` package into the repo's node_modules. */
async function fakeTypeScript(repo: string, version: string, main: string): Promise<void> {
  const dir = join(repo, "node_modules", "typescript");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "typescript", version, main: "main.cjs" }));
  await writeFile(join(dir, "main.cjs"), main);
}

async function load(fixture: string): Promise<TsEngine> {
  return TsEngine.load(await makeRepo(fixture));
}

function contains(engine: TsEngine, project: Project, file: string): boolean {
  return project.service.getProgram()?.getSourceFile(engine.absPath(file)) !== undefined;
}

describe("TsEngine", () => {
  test("loads bundled TS 6.0.3 when repo has none", async () => {
    const engine = await load("simple");
    assert.equal(engine.id, "typescript");
    assert.equal(engine.version, "6.0.3");
    assert.equal(engine.ts.version, "6.0.3");
  });

  test("always uses the bundled TypeScript, even with one in the repo's node_modules", async () => {
    for (const version of ["5.9.0", "7.0.0", "6.0.3"]) {
      const repo = await makeRepo("simple");
      await fakeTypeScript(repo, version, `throw new Error("must not load");`);
      const engine = await TsEngine.load(repo);
      assert.equal(engine.version, "6.0.3");
    }
  });

  test("a project holds every TS file under the tsconfig's folder, whatever include says", async () => {
    const engine = await load("simple");
    const project = engine.project("a.ts");
    assert.equal(project.folder, ".");
    assert.equal(project.tsconfig, "tsconfig.json");
    // include is ["*.ts", "*.tsx"]: scripts/tool.ts is outside it
    assert.equal(contains(engine, project, "scripts/tool.ts"), true);
    assert.equal(engine.project("scripts/tool.ts"), project);
  });

  test("the nearest tsconfig above the file decides the project", async () => {
    const engine = await load("monorepo");
    const core = engine.project("packages/core/src/util.ts");
    assert.equal(core.folder, "packages/core");
    assert.equal(core.tsconfig, "packages/core/tsconfig.json");
    assert.equal(contains(engine, core, "packages/app/src/main.ts"), false);
    assert.equal(engine.project("packages/app/src/main.ts").tsconfig, "packages/app/tsconfig.json");
  });

  test("a file with no tsconfig above it uses the root with default options", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jig-"));
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "a.ts"), "export function foo() {\n  return 1;\n}\n");
    const engine = await TsEngine.load(dir);
    const project = engine.project("src/a.ts");
    assert.equal(project.folder, ".");
    assert.equal(project.tsconfig, null);
    assert.deepEqual(project.service.getProgram()?.getCompilerOptions(), {});
    assert.equal(engine.findTopLevel("src/a.ts", "foo").kind, "function");
  });

  test("an unresolvable extends is ignored", async () => {
    const engine = await load("extends-npm");
    assert.equal(engine.findTopLevel("a.ts", "foo").kind, "function");
    assert.equal(engine.project("a.ts").service.getProgram()?.getCompilerOptions().strict, true);
  });

  test("findTopLevel finds function", async () => {
    const engine = await load("simple");
    const d = engine.findTopLevel("a.ts", "foo");
    assert.equal(d.kind, "function");
    assert.equal(d.file, "a.ts");
    const text = engine.read("a.ts") ?? "";
    assert.equal(text.slice(d.nameStart, d.nameStart + 3), "foo");
    assert.equal(text.slice(d.start, d.end), "export function foo() {\n  return helper() + 1;\n}");
  });

  test("findTopLevel ambiguous for shared", async () => {
    const engine = await load("simple");
    const err = caught(() => engine.findTopLevel("a.ts", "shared"));
    assert.ok(err instanceof RefactorError);
    assert.equal(err.code, "AMBIGUOUS_SYMBOL");
    assert.equal(
      err.message,
      "shared in a.ts matches 2 declarations (variable at a.ts:15, interface at a.ts:17). Pass --kind variable|interface to pick one.",
    );
    const d = engine.findTopLevel("a.ts", "shared", "variable");
    assert.equal(d.kind, "variable");
    assert.equal((engine.read("a.ts") ?? "").slice(d.start, d.end), "export const shared = 1;");
  });

  test("findTopLevel missing", async () => {
    const engine = await load("simple");
    assert.equal(caught(() => engine.findTopLevel("a.ts", "nope")).code, "SYMBOL_NOT_FOUND");
    assert.equal(caught(() => engine.findTopLevel("a.ts", "foo", "class")).code, "SYMBOL_NOT_FOUND");
    assert.equal(caught(() => engine.findTopLevel("missing.ts", "foo")).code, "SYMBOL_NOT_FOUND");
  });

  test("overlay write shows in changes()", async () => {
    const engine = await load("simple");
    const original = engine.read("a.ts");
    assert.notEqual(original, null);
    engine.write("a.ts", `${original}\nexport const added = 2;\n`);
    assert.deepEqual(engine.changes(), [
      { path: "a.ts", before: original, after: `${original}\nexport const added = 2;\n` },
    ]);
    assert.equal(engine.findTopLevel("a.ts", "added").kind, "variable");
    engine.write("a.ts", original);
    assert.deepEqual(engine.changes(), []);
  });

  test("overlay creation and deletion show in changes()", async () => {
    const engine = await load("simple");
    const b = engine.read("b.ts");
    engine.write("new.ts", "export {};\n");
    engine.write("b.ts", null);
    assert.equal(engine.read("b.ts"), null);
    assert.deepEqual(engine.changes(), [
      { path: "b.ts", before: b, after: null },
      { path: "new.ts", before: null, after: "export {};\n" },
    ]);
  });

  test("a created file joins its project, a deleted one leaves it", async () => {
    const engine = await load("simple");
    const project = engine.project("a.ts");
    assert.equal(contains(engine, project, "b.ts"), true);
    engine.write("sub/fresh.ts", "export const fresh = 1;\n");
    engine.write("b.ts", null);
    assert.equal(contains(engine, project, "sub/fresh.ts"), true);
    assert.equal(contains(engine, project, "b.ts"), false);
    assert.equal(engine.findTopLevel("sub/fresh.ts", "fresh").kind, "variable");
  });

  test("applyTextChanges applies spans end to start", async () => {
    const engine = await load("simple");
    const original = engine.read("a.ts") ?? "";
    const foo = engine.findTopLevel("a.ts", "foo");
    const helper = engine.findTopLevel("a.ts", "helper");
    engine.applyTextChanges([
      {
        fileName: `${engine.repoRoot}/a.ts`,
        textChanges: [
          { span: { start: foo.nameStart, length: 3 }, newText: "bar" },
          { span: { start: helper.nameStart, length: 6 }, newText: "h" },
        ],
      },
      { fileName: `${engine.repoRoot}/made.ts`, isNewFile: true, textChanges: [{ span: { start: 0, length: 0 }, newText: "export {};\n" }] },
    ]);
    assert.equal(engine.read("a.ts"), original.replace("function foo", "function bar").replace("function helper", "function h"));
    assert.equal(engine.read("made.ts"), "export {};\n");
  });
});

describe("position-free names", () => {
  const SOURCE = [
    "export function processOrder(id: string) {",
    "  sendEmail(id);",
    "  const total = sendEmail(id);",
    "  function retry() {",
    "    sendEmail(id);",
    "  }",
    "  const later = () => sendEmail(id);",
    "  return [total, retry, later, sendEmail(id)];",
    "}",
    "export class OrderService {",
    "  constructor() {}",
    "  save() { return sendEmail('x'); }",
    "  #secret = 1;",
    "}",
    "export const api = { load: () => 1, value: 2 };",
    "export default function () {}",
    "declare function sendEmail(id: string): number;",
    "sendEmail('top');",
    "",
  ].join("\n");

  async function source(): Promise<{ engine: TsEngine; nodes: ts.Node[] }> {
    const dir = await mkdtemp(join(tmpdir(), "jig-"));
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "orders.ts"), SOURCE);
    const engine = await TsEngine.load(dir);
    const { sf } = engine.sourceFile("src/orders.ts");
    const nodes: ts.Node[] = [];
    const visit = (n: ts.Node): void => {
      nodes.push(n);
      engine.ts.forEachChild(n, visit);
    };
    visit(sf);
    return { engine, nodes };
  }

  const isSendEmail = (engine: TsEngine) => (n: ts.Node) =>
    engine.ts.isCallExpression(n) && engine.ts.isIdentifier(n.expression) && n.expression.text === "sendEmail";

  test("declarationPath names declarations and what is inside them", async () => {
    const { engine, nodes } = await source();
    const t = engine.ts;
    const named = (name: string) => nodes.find((n) => t.isIdentifier(n) && n.text === name)?.parent as ts.Node;
    assert.equal(engine.declarationPath(named("processOrder")), "src/orders.ts#processOrder");
    assert.equal(engine.declarationPath(named("retry")), "src/orders.ts#processOrder.retry");
    assert.equal(engine.declarationPath(named("later")), "src/orders.ts#processOrder.later");
    assert.equal(engine.declarationPath(named("save")), "src/orders.ts#OrderService.save");
    assert.equal(engine.declarationPath(named("load")), "src/orders.ts#api.load");
    assert.equal(engine.declarationPath(named("value")), "src/orders.ts#api");
    // a plain local value is not a place of its own: what is in it belongs to the function around it
    assert.equal(engine.declarationPath(named("total")), "src/orders.ts#processOrder");
    const ctor = nodes.find((n) => t.isConstructorDeclaration(n)) as ts.Node;
    assert.equal(engine.declarationPath(ctor), "src/orders.ts#OrderService.constructor");
    const secret = nodes.find((n) => t.isPropertyDeclaration(n)) as ts.Node;
    assert.equal(engine.declarationPath(secret), "src/orders.ts#OrderService.#secret");
    const anonymous = nodes.find((n) => t.isFunctionDeclaration(n) && !n.name) as ts.Node;
    assert.equal(engine.declarationPath(anonymous), "src/orders.ts#default");
    const top = nodes.filter(isSendEmail(engine)).at(-1) as ts.Node;
    assert.equal(engine.declarationPath(top), "src/orders.ts");
  });

  test("declarationPath does not change when code moves around it", async () => {
    const { engine, nodes } = await source();
    const dir = await mkdtemp(join(tmpdir(), "jig-"));
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "orders.ts"), `// moved down\nexport const unrelated = 1;\n\n${SOURCE}`);
    const moved = await TsEngine.load(dir);
    const { sf } = moved.sourceFile("src/orders.ts");
    const movedCalls: ts.Node[] = [];
    const visit = (n: ts.Node): void => {
      if (isSendEmail(moved)(n)) movedCalls.push(n);
      moved.ts.forEachChild(n, visit);
    };
    visit(sf);
    const calls = nodes.filter(isSendEmail(engine));
    assert.deepEqual(
      movedCalls.map((c) => moved.declarationPath(c)),
      calls.map((c) => engine.declarationPath(c)),
    );
    assert.notDeepEqual(moved.location(movedCalls[0] as ts.Node), engine.location(calls[0] as ts.Node));
  });

  /** Every declaration path of the declarations named in `source`, in source order. */
  async function paths(source: string): Promise<string[]> {
    const dir = await mkdtemp(join(tmpdir(), "jig-"));
    await writeFile(join(dir, "p.ts"), source);
    const engine = await TsEngine.load(dir);
    const { sf } = engine.sourceFile("p.ts");
    const out: string[] = [];
    const visit = (n: ts.Node): void => {
      const name = (n as { name?: ts.Node }).name;
      if (name && n.parent && !engine.ts.isParameter(n) && !engine.ts.isPropertyAccessExpression(n)) out.push(engine.declarationPath(n));
      engine.ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  }

  test("getter and setter, static and instance members get different paths", async () => {
    const source = [
      "class C {",
      "  get x() { return 1; }",
      "  set x(v: number) {}",
      "  static x = 1;",
      "  static get y() { return 1; }",
      "  y = 2;",
      "}",
      "",
    ].join("\n");
    assert.deepEqual(await paths(source), [
      "p.ts#C",
      "p.ts#C.get x",
      "p.ts#C.set x",
      "p.ts#C.static x",
      "p.ts#C.static get y",
      "p.ts#C.y",
    ]);
  });

  test("same-named declarations under one parent get #2, #3 (the first keeps its plain path)", async () => {
    const source = [
      "export function outer() {",
      "  [1].map(() => { const helper = () => 1; return helper(); });",
      "  [2].map(() => { const helper = () => 2; return helper(); });",
      "}",
      "export const shared = 1;",
      "export interface shared {}",
      "",
    ].join("\n");
    assert.deepEqual(await paths(source), [
      "p.ts#outer",
      "p.ts#outer.helper",
      "p.ts#outer.helper#2",
      "p.ts#shared",
      "p.ts#shared#2",
    ]);
  });

  test("overload signatures share the path of their implementation", async () => {
    const source = [
      "export function f(a: string): string;",
      "export function f(a: number): number;",
      "export function f(a: unknown) { return a; }",
      "export function g() {}",
      "class K { m(): void; m(x?: number) {} }",
      "",
    ].join("\n");
    assert.deepEqual(await paths(source), ["p.ts#f", "p.ts#f", "p.ts#f", "p.ts#g", "p.ts#K", "p.ts#K.m", "p.ts#K.m"]);
  });

  test("names that are not identifiers are JSON-quoted, so a.b and \"a.b\" differ", async () => {
    const source = 'export const api = { "a.b": () => 1, a: { b: () => 2 }, 0: () => 3, "ok": () => 4 };\n';
    assert.deepEqual(await paths(source), [
      "p.ts#api",
      'p.ts#api."a.b"',
      "p.ts#api.a",
      "p.ts#api.a.b",
      'p.ts#api."0"',
      "p.ts#api.ok",
    ]);
  });

  test("location counts lines in the node's own source file, also after the file was edited", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jig-"));
    await writeFile(join(dir, "m.ts"), "export function a() {}\nexport function b() {}\n");
    const engine = await TsEngine.load(dir);
    const before = engine.sourceFile("m.ts").sf;
    const b = before.statements[1] as ts.Statement;
    // An earlier edit in the same file: two lines above `b`.
    engine.write("m.ts", `// one\n// two\n${engine.read("m.ts")}`);
    assert.deepEqual(engine.location(b), { path: "m.ts", line: 2, column: 1 });
    const after = engine.sourceFile("m.ts").sf.statements[1] as ts.Statement;
    assert.deepEqual(engine.location(after), { path: "m.ts", line: 4, column: 1 });
  });

  test("location is 1-based line and column of the node's start", async () => {
    const { engine, nodes } = await source();
    const call = nodes.find(isSendEmail(engine)) as ts.Node;
    assert.deepEqual(engine.location(call), { path: "src/orders.ts", line: 2, column: 3 });
  });
});

describe("example repos", () => {
  /** Every TypeScript error the bundled TypeScript reports for the project holding `file`. */
  function errors(engine: TsEngine, file: string): string[] {
    const program = engine.project(file).service.getProgram();
    assert.ok(program, `no program for ${file}`);
    return engine.ts
      .getPreEmitDiagnostics(program)
      .map((d) => `${d.file?.fileName ?? ""}: ${engine.ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
  }

  test("examples/webapp typechecks", async () => {
    const engine = await load("examples/webapp");
    assert.equal(engine.project("src/main.ts").tsconfig, "tsconfig.json");
    assert.deepEqual(errors(engine, "src/main.ts"), []);
  });

  test("examples/monorepo: both packages typecheck, each in its own project", async () => {
    const engine = await load("examples/monorepo");
    assert.equal(engine.project("packages/app/src/main.ts").folder, "packages/app");
    assert.equal(engine.project("packages/shared/src/index.ts").folder, "packages/shared");
    assert.deepEqual(errors(engine, "packages/app/src/main.ts"), []);
    assert.deepEqual(errors(engine, "packages/shared/src/index.ts"), []);
  });

  test("examples/react-app is copied", async () => {
    const engine = await load("examples/react-app");
    assert.ok(engine.read("src/App.tsx")?.includes("<Counter"));
  });
});
