import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OkReport } from "@jig/core";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { changed, errors, rejects, workspace } from "./helpers.ts";

const removeBarrels =(dir: string, files: string) => main(["remove-barrels", "--files", files], dir);

describe("remove-barrels on examples/webapp", () => {
  test("rewrites every import through a barrel and deletes the barrels nothing imports any more", async () => {
    const dir = await workspace("examples/webapp");
    const before = await readTree(dir);
    const report = await removeBarrels(dir, "src/**");
    assertReport(report);
    const ok = report as OkReport;
    assert.equal(ok.subject, "refactor(typescript remove-barrels): src/**");
    assert.match(ok.summary, /^Imported \d+ names from the modules that define them instead of through barrels, in 6 files:\n  src\/components\/RoleBadge\.ts\n/);
    assert.match(ok.summary, /\n\nDeleted 4 barrels nothing uses any more:\n  src\/lib\/index\.ts\n  src\/models\/index\.ts\n  src\/services\/index\.ts\n  src\/utils\/index\.ts$/);
    const after = await readTree(dir);

    assert.deepEqual(changed(before, after), [
      "src/components/RoleBadge.ts",
      "src/components/UserCard.ts",
      "src/components/order-summary.ts",
      "src/lib/index.ts",
      "src/main.ts",
      "src/models/index.ts",
      "src/services/index.ts",
      "src/services/order-service.ts",
      "src/services/userService.ts",
      "src/utils/index.ts",
    ]);
    // Deleted: imported by nothing once their importers were rewritten (utils went first, then lib).
    for (const gone of ["src/lib/index.ts", "src/models/index.ts", "src/services/index.ts", "src/utils/index.ts"]) {
      assert.equal(after[gone], undefined, gone);
    }
    // Kept: a namespace import (strings), a side-effect import (setup), and a barrel that declares code (widgets).
    assert.equal(after["src/lib/strings/index.ts"], before["src/lib/strings/index.ts"]);
    assert.equal(after["src/setup/index.ts"], before["src/setup/index.ts"]);
    assert.equal(after["src/widgets/index.ts"], before["src/widgets/index.ts"]);
    assert.deepEqual(await errors(dir, "src/main.ts"), []);

    assert.equal(
      after["src/components/UserCard.ts"],
      before["src/components/UserCard.ts"]?.replace(
        'import { formatDate, capitalize } from "@/lib";',
        'import { formatDate } from "@/lib/format";\nimport { capitalize } from "@/lib/strings/capitalize";',
      ),
    );
    assert.equal(
      after["src/components/order-summary.ts"],
      [
        'import { Order } from "@/models/order_item";',
        'import { describeOrder, discount } from "@/services/order-service";',
        'import { formatPrice } from "@/lib/format";',
        'import { percentage } from "@/lib/math";',
        'import config from "@/config";',
      ].join("\n") + before["src/components/order-summary.ts"]?.slice(before["src/components/order-summary.ts"].indexOf("\n\n")),
    );
    assert.equal(
      after["src/main.ts"],
      before["src/main.ts"]
        ?.replace('from "@/services";', 'from "@/services/userService";')
        .replace('import { distance } from "@/lib";', 'import { distance } from "@/lib/math";'),
    );
    // Aliased re-export (`formatCurrency as currency`): the local name is kept with `as`.
    assert.equal(
      after["src/services/order-service.ts"],
      before["src/services/order-service.ts"]?.replace(
        'import { currency } from "@/lib";',
        'import { formatCurrency as currency } from "@/lib/format";',
      ),
    );
    assert.equal(
      after["src/services/userService.ts"],
      before["src/services/userService.ts"]
        ?.replace('import { User, Role } from "@/models";', 'import { User, Role } from "@/models/User";')
        .replace(
          'import { capitalize, slugify } from "@/lib";',
          'import { capitalize } from "@/lib/strings/capitalize";\nimport { slugify } from "@/lib/strings/slugify";',
        ),
    );
    // Side-effect import kept; `import type` kept; inline `type` kept (and added for `export type` re-exports);
    // aliases through two barrels resolved; a barrel that declares code left as is.
    assert.equal(
      after["src/components/RoleBadge.ts"],
      [
        'import "@/setup";',
        'import type { Role } from "@/models/User";',
        'import { badge, WIDGET_PREFIX } from "@/widgets";',
        'import { slugify } from "@/lib/strings/slugify";',
        'import { formatDate as toDateString } from "@/lib/format";',
        'import { type Role as UserRole } from "@/models/User";',
        'import { capitalize as cap } from "@/lib/strings/capitalize";',
        'import { type Level } from "@/lib/logger";',
      ].join("\n") + before["src/components/RoleBadge.ts"]?.slice(before["src/components/RoleBadge.ts"].indexOf("\n\n")),
    );
  });

  test("a second run changes nothing (NO_CHANGES for the host)", async () => {
    const dir = await workspace("examples/webapp");
    await removeBarrels(dir, "src/**");
    const once = await readTree(dir);
    await removeBarrels(dir, "src/**");
    assert.deepEqual(await readTree(dir), once);
  });

  test("a barrel still imported by files outside --files is kept", async () => {
    const dir = await workspace("examples/webapp");
    const before = await readTree(dir);
    await removeBarrels(dir, "src/components/UserCard.ts");
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/components/UserCard.ts"]);
    assert.ok(after["src/components/UserCard.ts"]?.includes('import { formatDate } from "@/lib/format";'));
  });

  test("type-only, mixed, default and re-export declarations keep their meaning", async () => {
    const dir = await workspace("examples/webapp", {
      "src/geo/shapes.ts": "export interface Shape {\n  size: number;\n}\n\nexport function area(shape: Shape) {\n  return shape.size * shape.size;\n}\n",
      "src/geo/index.ts": 'export * from "./shapes";\n',
      "src/stores/index.ts": 'export { default as Store } from "@/services/store";\n',
      "src/extra/mixed.ts": [
        'import type { Level } from "@/lib";',
        'import { area, type Shape } from "@/geo";',
        'import { Store as S } from "@/stores";',
        'export { currency, type Level as Lvl } from "@/lib";',
        "",
        'export const level: Level = "info";',
        "export const store = new S<{ id: string }>();",
        "export const big = (shape: Shape) => area(shape) > 10;",
        "",
      ].join("\n"),
    });
    const before = await readTree(dir);
    await removeBarrels(dir, "src/extra/**");
    const after = await readTree(dir);
    assert.equal(
      after["src/extra/mixed.ts"],
      [
        'import type { Level } from "@/lib/logger";',
        'import { area, type Shape } from "@/geo/shapes";',
        'import S from "@/services/store";',
        'export { formatCurrency as currency } from "@/lib/format";',
        'export { type Level as Lvl } from "@/lib/logger";',
      ].join("\n") + before["src/extra/mixed.ts"]?.slice(before["src/extra/mixed.ts"].indexOf("\n\n")),
    );
    assert.deepEqual(changed(before, after), ["src/extra/mixed.ts", "src/geo/index.ts", "src/stores/index.ts"]);
  });

  test("the same name reached through two `export *` paths resolves to its one definition", async () => {
    const dir = await workspace("examples/webapp", {
      "src/dia/a.ts": "export const x = 1;\n",
      "src/dia/c.ts": 'export * from "./a";\n\nexport const c = 3;\n',
      "src/dia/index.ts": 'export * from "./a";\nexport * from "./c";\n',
      "src/use.ts": "import { x, c } from './dia';\n\nexport const y = x + c;\n",
    });
    await removeBarrels(dir, "src/use.ts");
    const after = await readTree(dir);
    assert.equal(after["src/use.ts"], "import { x } from './dia/a';\nimport { c } from './dia/c';\n\nexport const y = x + c;\n");
    assert.equal(after["src/dia/index.ts"], undefined);
  });

  test("a name two `export *` give different definitions of is REFACTOR_UNAVAILABLE", async () => {
    const dir = await workspace("examples/webapp", {
      "src/amb/a.ts": "export const x = 1;\n",
      "src/amb/b.ts": "export const x = 2;\n",
      "src/amb/index.ts": 'export * from "./a";\nexport * from "./b";\n',
      "src/use.ts": 'import { x } from "./amb";\n\nexport const y = x;\n',
    });
    const before = await readTree(dir);
    const err = await rejects(removeBarrels(dir, "src/use.ts"));
    assert.equal(err.code, "REFACTOR_UNAVAILABLE");
    assert.equal(
      err.message,
      'src/amb/index.ts exports x from more than one module through export * ("./a", "./b"). Export x by name from the one that is meant, then run again.',
    );
    assert.deepEqual(await readTree(dir), before);
  });

  test("a barrel still named elsewhere (a JavaScript importer, a mock path) is kept", async () => {
    const dir = await workspace("examples/webapp", {
      "src/legacy.js": 'import { Order } from "./models/index.js";\n',
      "src/mocks.ts": 'export const mocked = ["@/services"];\n',
    });
    const before = await readTree(dir);
    await removeBarrels(dir, "src/**");
    const after = await readTree(dir);
    assert.equal(after["src/models/index.ts"], before["src/models/index.ts"]);
    assert.equal(after["src/services/index.ts"], before["src/services/index.ts"]);
    assert.equal(after["src/lib/index.ts"], undefined);
  });

  test("relative specifiers stay relative and keep their extension style", async () => {
    const dir = await workspace("examples/webapp", {
      "src/rel.ts": 'import { slugify } from "./lib/index";\nimport { orderTotal } from "./services";\n\nexport const r = [slugify, orderTotal];\n',
    });
    await removeBarrels(dir, "src/rel.ts");
    assert.equal(
      (await readTree(dir))["src/rel.ts"],
      'import { slugify } from "./lib/strings/slugify";\nimport { orderTotal } from "./services/order-service";\n\nexport const r = [slugify, orderTotal];\n',
    );
  });

  test("globs that match no file are NO_CHANGES", async () => {
    const dir = await workspace("examples/webapp");
    assert.equal((await rejects(removeBarrels(dir, "nope/**"))).code, "NO_CHANGES");
  });
});

describe("remove-barrels on examples/monorepo", () => {
  test("barrels across a package boundary and re-exports from another package are left as is", async () => {
    const dir = await workspace("examples/monorepo");
    const before = await readTree(dir);
    await removeBarrels(dir, "**");
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["packages/app/src/lib/index.ts", "packages/app/src/main.ts", "packages/app/src/view.ts"]);
    assert.equal(after["packages/app/src/lib/index.ts"], undefined);
    assert.equal(
      after["packages/app/src/main.ts"],
      before["packages/app/src/main.ts"]?.replace('from "./lib";', 'from "./lib/todo";'),
    );
    // `shorten` is re-exported from @example/shared: it keeps going through ./ui, which stays.
    assert.equal(
      after["packages/app/src/view.ts"],
      before["packages/app/src/view.ts"]?.replace(
        'import { label, shorten } from "./ui";',
        'import { label } from "./ui/label";\nimport { shorten } from "./ui";',
      ),
    );
    assert.deepEqual(await errors(dir, "packages/app/src/main.ts"), []);
  });
});
