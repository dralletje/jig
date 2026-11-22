import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OkReport } from "@jig/core";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { convertStem } from "../src/rename-files.ts";
import { changed, errors as allErrors, rejects, workspace } from "./helpers.ts";

const EXAMPLE = "examples/rename-files";
const rename = (dir: string, nameCase: string, files = "src/**") =>
  main(["rename-files", "--files", files, "--case", nameCase], dir);

// The example holds Helpers.ts next to helpers.ts on purpose; TypeScript complains about that pair.
const errors = async (dir: string, file: string) =>
  (await allErrors(dir, file)).filter((e) => !e.includes("only in casing"));
/** The `from → to` lines the summary lists under its first line. */
function moves(report: OkReport): string[] {
  const out: string[] = [];
  for (const line of report.summary.split("\n").slice(1)) {
    if (!line.startsWith("  ")) break;
    out.push(line.slice(2));
  }
  return out;
}

/** The files the summary lists as not handled, with their reasons. */
function notHandled(report: OkReport): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of report.summary.matchAll(/^ {2}(\S+):1: (.*)$/gm)) out[m[1] as string] = m[2] as string;
  return out;
}

const missFiles = (report: OkReport) => Object.keys(notHandled(report));

describe("convertStem", () => {
  test("words are split at separators and case changes", () => {
    assert.equal(convertStem("orderItem", "kebab"), "order-item");
    assert.equal(convertStem("OrderItem", "snake"), "order_item");
    assert.equal(convertStem("order_item", "pascal"), "OrderItem");
    assert.equal(convertStem("order-item", "camel"), "orderItem");
    assert.equal(convertStem("HTTPServer", "kebab"), "http-server");
    assert.equal(convertStem("v2Api", "kebab"), "v2-api");
  });
});

describe("rename-files on examples/rename-files", () => {
  test("kebab: renames, rewrites importers, lists what it left alone", async () => {
    const dir = await workspace(EXAMPLE);
    const before = await readTree(dir);
    const report = (await rename(dir, "kebab")) as OkReport;
    assertReport(report);
    assert.equal(report.kind, "sweep");
    assert.equal(report.subject, "sweep(rename-files): src/** to kebab case");
    assert.deepEqual(moves(report), [
      "src/Footer.ts → src/footer.ts",
      "src/UserCard.ts → src/user-card.ts",
      "src/orderService.test.ts → src/order-service.test.ts",
      "src/orderService.ts → src/order-service.ts",
      "src/order_item.ts → src/order-item.ts",
      "src/ui/ButtonGroup.ts → src/ui/button-group.ts",
    ]);
    assert.match(
      report.summary,
      /^Renamed 6 files to kebab case, updating the imports of \d+ other files?:\n {2}src\/Footer\.ts → src\/footer\.ts\n/,
    );
    assert.deepEqual(missFiles(report), [
      "src/Helpers.ts",
      "src/Settings-Page.ts",
      "src/Settings_Page.ts",
      "src/date_utils.ts",
    ]);
    const reasons = notHandled(report);
    assert.match(reasons["src/date_utils.ts"] ?? "", /src\/date-utils\.ts already exists/);
    assert.match(reasons["src/Helpers.ts"] ?? "", /^src\/helpers\.ts already exists$/);
    // The reason does not repeat the file path that is already in front of it.
    assert.ok(Object.entries(reasons).every(([file, reason]) => !reason.includes(file)));
    assert.match(reasons["src/Settings_Page.ts"] ?? "", /differ only by case from the existing src\/Settings-Page\.ts/);
    assert.match(
      report.summary,
      /\n\nNot handled \(4\):\n {2}src\/Helpers\.ts:1: src\/helpers\.ts already exists\n {4}Rename or remove one of src\/Helpers\.ts and src\/helpers\.ts by hand, then run again\.\n/,
    );

    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), [
      "src/Footer.ts",
      "src/UserCard.ts",
      "src/footer.ts",
      "src/index.ts",
      "src/main.ts",
      "src/order-item.ts",
      "src/order-service.test.ts",
      "src/order-service.ts",
      "src/orderService.test.ts",
      "src/orderService.ts",
      "src/order_item.ts",
      "src/ui/ButtonGroup.ts",
      "src/ui/button-group.ts",
      "src/user-card.ts",
    ]);
    assert.ok(after["src/index.ts"]?.includes('from "./user-card"'));
    assert.ok(after["src/index.ts"]?.includes('from "./order-item"'));
    assert.ok(after["src/order-service.ts"]?.includes('from "./order-item"'));
    assert.ok(after["src/order-service.test.ts"]?.includes('from "./order-service"'));
    assert.ok(after["src/ui/button-group.ts"]?.includes('from "../user-card"'));
    assert.ok(after["src/main.ts"]?.includes('from "./ui/button-group"'));
    assert.ok(after["src/main.ts"]?.includes('from "./footer"'));
    assert.deepEqual(await errors(dir, "src/main.ts"), []);
  });

  test("a case-only rename (Footer.ts → footer.ts) is made, with its importers", async () => {
    const dir = await workspace(EXAMPLE);
    const report = (await rename(dir, "kebab", "src/Footer.ts")) as OkReport;
    assertReport(report);
    assert.doesNotMatch(report.summary, /Not handled/);
    assert.deepEqual(moves(report), ["src/Footer.ts → src/footer.ts"]);
    const after = await readTree(dir);
    assert.equal(after["src/Footer.ts"], undefined);
    assert.ok(after["src/footer.ts"]);
    assert.ok(after["src/main.ts"]?.includes('from "./footer"'));
    assert.deepEqual(await errors(dir, "src/main.ts"), []);
  });

  test("a second run finds nothing to rename", async () => {
    const dir = await workspace(EXAMPLE);
    await rename(dir, "kebab");
    const err = await rejects(rename(dir, "kebab"));
    assert.equal(err.code, "NO_CHANGES");
    assert.match(err.message, /skipped:/);
  });

  test("camel", async () => {
    const dir = await workspace(EXAMPLE);
    const report = (await rename(dir, "camel")) as OkReport;
    assertReport(report);
    assert.ok(moves(report).includes("src/order_item.ts → src/orderItem.ts"));
    assert.ok(moves(report).includes("src/ui/ButtonGroup.ts → src/ui/buttonGroup.ts"));
    // UserCard → userCard only changes case: renamed all the same.
    assert.ok(moves(report).includes("src/UserCard.ts → src/userCard.ts"));
    assert.ok((await readTree(dir))["src/userCard.ts"]);
    const after = await readTree(dir);
    assert.ok(after["src/orderItem.ts"]);
    assert.ok(after["src/orderService.ts"]?.includes('from "./orderItem"'));
    assert.deepEqual(await errors(dir, "src/main.ts"), []);
    assert.equal((await rejects(rename(dir, "camel"))).code, "NO_CHANGES");
  });

  test("pascal: index files are left alone and listed", async () => {
    const dir = await workspace(EXAMPLE);
    const report = (await rename(dir, "pascal")) as OkReport;
    assertReport(report);
    assert.ok(moves(report).includes("src/order_item.ts → src/OrderItem.ts"));
    assert.ok(moves(report).includes("src/main.ts → src/Main.ts"));
    assert.equal(notHandled(report)["src/index.ts"], "index files keep their name");
    // Both date files would become DateUtils.ts.
    assert.ok(missFiles(report).includes("src/date-utils.ts"));
    assert.ok(missFiles(report).includes("src/date_utils.ts"));
    assert.ok((await readTree(dir))["src/index.ts"]?.includes('from "./OrderItem"'));
    assert.deepEqual(await errors(dir, "src/Main.ts"), []);
    assert.equal((await rejects(rename(dir, "pascal"))).code, "NO_CHANGES");
  });

  test("snake", async () => {
    const dir = await workspace(EXAMPLE);
    const report = (await rename(dir, "snake")) as OkReport;
    assertReport(report);
    assert.ok(moves(report).includes("src/UserCard.ts → src/user_card.ts"));
    assert.ok(moves(report).includes("src/orderService.test.ts → src/order_service.test.ts"));
    assert.ok(missFiles(report).includes("src/date-utils.ts"));
    assert.ok((await readTree(dir))["src/main.ts"]?.includes('from "./order_service"'));
    assert.deepEqual(await errors(dir, "src/main.ts"), []);
    assert.equal((await rejects(rename(dir, "snake"))).code, "NO_CHANGES");
  });

  test("the summary stays the same when the importers change around the renames", async () => {
    const a = await workspace(EXAMPLE);
    const main0 = (await readTree(a))["src/main.ts"] ?? "";
    const b = await workspace(EXAMPLE, { "src/main.ts": `// moved\n\n\n${main0}` });
    const ra = (await rename(a, "kebab")) as OkReport;
    const rb = (await rename(b, "kebab")) as OkReport;
    assert.equal(ra.summary, rb.summary);
  });

  test("only the files matching --files are renamed", async () => {
    const dir = await workspace(EXAMPLE);
    const report = (await rename(dir, "kebab", "src/ui/**")) as OkReport;
    assertReport(report);
    assert.deepEqual(moves(report), ["src/ui/ButtonGroup.ts → src/ui/button-group.ts"]);
    assert.doesNotMatch(report.summary, /Not handled/);
  });
});

describe("rename-files arguments", () => {
  test("refuses an unknown case and a missing one", async () => {
    const dir = await workspace(EXAMPLE);
    const err = await rejects(rename(dir, "title"));
    assert.equal(err.code, "INVALID_ARGS");
    assert.match(err.message, /--case kebab\|camel\|pascal\|snake/);
    assert.equal((await rejects(main(["rename-files", "--files", "src/**"], dir))).code, "INVALID_ARGS");
  });
});
