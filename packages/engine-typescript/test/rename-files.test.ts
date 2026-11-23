import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { changed, errors as allErrors, rejects, workspace } from "./helpers.ts";

const EXAMPLE = "examples/rename-files";
const rename = (dir: string, nameCase: string, files = "src/**") =>
  main(["rename-files", "--files", files, "--case", nameCase], dir);

// The example holds Helpers.ts next to helpers.ts on purpose; TypeScript complains about that pair.
const errors = async (dir: string, file: string) =>
  (await allErrors(dir, file)).filter((e) => !e.includes("only in casing"));

describe("rename-files", () => {
  test("kebab splits acronyms and keeps digits with the word before them", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/HTTPServer.ts": "export const server = 1;\n",
      "src/v2Api.ts": 'import { server } from "./HTTPServer";\n\nexport const api = server;\n',
    });
    await rename(dir, "kebab", "src/HTTPServer.ts,src/v2Api.ts");
    const after = await readTree(dir);
    assert.equal(after["src/HTTPServer.ts"], undefined);
    assert.equal(after["src/v2Api.ts"], undefined);
    assert.equal(after["src/http-server.ts"], "export const server = 1;\n");
    assert.equal(after["src/v2-api.ts"], 'import { server } from "./http-server";\n\nexport const api = server;\n');
  });
});

describe("rename-files on examples/rename-files", () => {
  test("kebab: renames, rewrites importers, leaves names that are taken or clash alone", async () => {
    const dir = await workspace(EXAMPLE);
    const before = await readTree(dir);
    assertReport(await rename(dir, "kebab"));
    const after = await readTree(dir);
    // Helpers.ts (helpers.ts exists), date_utils.ts (date-utils.ts exists) and the two
    // Settings pages (differ only by case) are not in the list: left as they were.
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
    await rename(dir, "kebab", "src/Footer.ts");
    const after = await readTree(dir);
    assert.equal(after["src/Footer.ts"], undefined);
    assert.ok(after["src/footer.ts"]);
    assert.ok(after["src/main.ts"]?.includes('from "./footer"'));
    assert.deepEqual(await errors(dir, "src/main.ts"), []);
  });

  test("a second run finds nothing to rename", async () => {
    const dir = await workspace(EXAMPLE);
    await rename(dir, "kebab");
    const once = await readTree(dir);
    assert.equal((await rejects(rename(dir, "kebab"))).code, "NO_CHANGES");
    assert.deepEqual(await readTree(dir), once);
  });

  test("camel", async () => {
    const dir = await workspace(EXAMPLE);
    await rename(dir, "camel");
    const after = await readTree(dir);
    assert.ok(after["src/orderItem.ts"]);
    assert.ok(after["src/ui/buttonGroup.ts"]);
    // UserCard → userCard only changes case: renamed all the same.
    assert.ok(after["src/userCard.ts"]);
    assert.equal(after["src/UserCard.ts"], undefined);
    assert.ok(after["src/orderService.ts"]?.includes('from "./orderItem"'));
    assert.deepEqual(await errors(dir, "src/main.ts"), []);
    assert.equal((await rejects(rename(dir, "camel"))).code, "NO_CHANGES");
  });

  test("pascal: index files keep their name; two files that would get one name are both left", async () => {
    const dir = await workspace(EXAMPLE);
    const before = await readTree(dir);
    await rename(dir, "pascal");
    const after = await readTree(dir);
    assert.ok(after["src/OrderItem.ts"]);
    assert.ok(after["src/Main.ts"]);
    assert.ok(after["src/index.ts"]?.includes('from "./OrderItem"'));
    // Both date files would become DateUtils.ts.
    assert.equal(after["src/date-utils.ts"], before["src/date-utils.ts"]);
    assert.equal(after["src/date_utils.ts"], before["src/date_utils.ts"]);
    assert.equal(after["src/DateUtils.ts"], undefined);
    assert.deepEqual(await errors(dir, "src/Main.ts"), []);
    assert.equal((await rejects(rename(dir, "pascal"))).code, "NO_CHANGES");
  });

  test("snake", async () => {
    const dir = await workspace(EXAMPLE);
    const before = await readTree(dir);
    await rename(dir, "snake");
    const after = await readTree(dir);
    assert.ok(after["src/user_card.ts"]);
    assert.ok(after["src/order_service.test.ts"]);
    assert.equal(after["src/date-utils.ts"], before["src/date-utils.ts"]);
    assert.ok(after["src/main.ts"]?.includes('from "./order_service"'));
    assert.deepEqual(await errors(dir, "src/main.ts"), []);
    assert.equal((await rejects(rename(dir, "snake"))).code, "NO_CHANGES");
  });

  test("only the files matching --files are renamed", async () => {
    const dir = await workspace(EXAMPLE);
    const before = await readTree(dir);
    await rename(dir, "kebab", "src/ui/**");
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/main.ts", "src/ui/ButtonGroup.ts", "src/ui/button-group.ts"]);
  });
});

describe("rename-files and declaration files", () => {
  const EXTRA = {
    "src/widgets/myWidget.js": "export const w = 1;\n",
    "src/widgets/myWidget.d.ts": "export declare const w: number;\n",
    "src/widgets/use.ts": 'import { w } from "./myWidget.js";\n\nexport const x = w;\n',
    "src/widgets/themeColors.css": ".a { color: red; }\n",
    "src/widgets/themeColors.d.css.ts": "declare const styles: { a: string };\nexport default styles;\n",
  };

  test("the file a declaration file declares is renamed with it, once", async () => {
    const dir = await workspace(EXAMPLE, EXTRA);
    await rename(dir, "kebab", "src/widgets/**");
    const files = await readTree(dir);
    assert.equal(files["src/widgets/myWidget.js"], undefined);
    assert.equal(files["src/widgets/myWidget.d.ts"], undefined);
    assert.equal(files["src/widgets/themeColors.css"], undefined);
    assert.equal(files["src/widgets/themeColors.d.css.ts"], undefined);
    assert.equal(files["src/widgets/my-widget.js"], "export const w = 1;\n");
    assert.equal(files["src/widgets/my-widget.d.ts"], "export declare const w: number;\n");
    assert.equal(files["src/widgets/theme-colors.css"], ".a { color: red; }\n");
    assert.equal(files["src/widgets/theme-colors.d.css.ts"], "declare const styles: { a: string };\nexport default styles;\n");
    assert.match(files["src/widgets/use.ts"] ?? "", /from "\.\/my-widget\.js"/);
  });

  test("refuses when the new name of the declared file is taken", async () => {
    const dir = await workspace(EXAMPLE, { ...EXTRA, "src/widgets/my-widget.js": "export const other = 2;\n" });
    const before = await readTree(dir);
    const err = await rejects(rename(dir, "kebab", "src/widgets/**"));
    assert.equal(err.code, "INVALID_ARGS");
    assert.deepEqual(await readTree(dir), before);
  });
});

describe("rename-files arguments", () => {
  test("refuses an unknown case and a missing one", async () => {
    const dir = await workspace(EXAMPLE);
    assert.equal((await rejects(rename(dir, "title"))).code, "INVALID_ARGS");
    assert.equal((await rejects(main(["rename-files", "--files", "src/**"], dir))).code, "INVALID_ARGS");
  });
});
