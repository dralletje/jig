# More actions: sweeps, signature refactors, inlining, codemods

Status: approved in conversation (the user asked for each of these and said "Go for it! Build example
repos to test them!"). Image contract, CLI and binary behaviour stay as they are, except the new
`kind` below. See `AGENTS.md` (no Bun; symlinks deferred).

## Kinds: telling refactors, sweeps and rewrites apart

The user wants to trace which commits are targeted refactors, which are generic many-file sweeps, and
which change behaviour. Every action (and every published-codemod transform) has a kind, decided by
what it does, not where it comes from:

| Kind | Meaning | Examples |
|---|---|---|
| `refactor` | targeted, behaviour-preserving, the kind you do as part of other work | rename, extract, lift-out, move-file, remove-barrels, params-to-object, inline-function |
| `sweep` | generic many-file mechanical convention change, behaviour-preserving | format, organize-imports, add-import-extensions, subpath-imports, default-to-named, infer-return-types, namespace-to-named, import-type, rename-files |
| `rewrite` | changes behaviour, but in a simple, repetitive way | remove-console, most published migration codemods |

- The image's ok report gains `"kind": "refactor" | "sweep" | "rewrite"`. A missing `kind` means
  `refactor` (older images); any other value is `IMAGE_FAILED`.
- The image's subject starts with the kind: `refactor(typescript-rename): …`, `sweep(format): …`,
  `rewrite(typescript-remove-console): …`. Existing actions change their prefix accordingly (format and
  organize-imports become `sweep(…)`).
- The binary adds a trailer `Refactor-Kind: <kind>` between `Refactor-Command` and `Co-Authored-By`,
  and `kind` to its success JSON. `git log --grep '^Refactor-Kind: rewrite'` lists them.
- "codemod" is only a word for where a transform comes from (a published codemod package); it is
  never a kind.

## Example repos

`examples/` holds small realistic repos used by the tests and usable as CLI demos:
- `examples/webapp`: a single-package app with `@/*` path aliases, barrels (`index.ts` with
  `export *` and named re-exports, nested barrels), default exports, namespace imports, functions with
  positional parameters, small helpers worth inlining, functions without return types,
  type-only imports written as value imports, `console.log` calls, and file names in mixed cases.
- `examples/monorepo`: two packages, one importing the other through a barrel, for the cases where a
  rewrite must stay within a package.
- `examples/react-app`: a few React components for the published-codemod example.
Each action task adds what its tests need to these repos (never weakening other tests). Tests copy an
example into a temp git repo (`makeRepo` learns to take `examples/<name>`).

## New typescript-image actions

All run in the typescript image on the project rule already in place (nearest tsconfig's folder, its
compilerOptions, unresolvable `extends` ignored). Sweeps take `--files <glob,glob>` matched against the
workspace files (as organize-imports does). Each refuses with `REFACTOR_UNAVAILABLE` and a reason
rather than produce a wrong result, and returns `NO_CHANGES`-producing no-ops silently (the host
reports `NO_CHANGES`).

1. `typescript-remove-barrels` (refactor, `--files`): every import that goes through a barrel
   (`index.ts`/`index.tsx` that only re-exports) is rewritten to import each name from the module
   that defines it (following `export *`, named re-exports and nested barrels; aliases preserved with
   `as`). Barrels that end up imported by nothing are deleted. A barrel that also declares code is
   not a barrel. Re-exports that cross a package boundary (the target outside the project folder) are
   left as is.
2. `typescript-add-import-extensions` (sweep, `--files`): relative imports and re-exports get the
   real file's extension (`./a` → `./a.ts`, `./dir` → `./dir/index.ts`). Also sets
   `allowImportingTsExtensions` in the project's tsconfig when it is not set (and `noEmit` or
   `emitDeclarationOnly` is, else refuses: TypeScript forbids it otherwise).
3. `typescript-subpath-imports` (sweep, `--files`, `--alias @/` default): imports through a tsconfig
   `paths` alias (`@/x` with `"@/*": ["./src/*"]`) become Node subpath imports (`#/x`), and the
   package.json next to the tsconfig gets `"imports": { "#/*": "./src/*" }` (merged with existing
   `imports`). Specifiers keep or gain the file extension consistently with what is already there.
   The `paths` entry is left in place (removing it is a later choice).
4. `typescript-default-to-named` (sweep, `--files`): `export default` of a named function, class or
   const becomes a named export of the same name, and every importer switches to a named import
   (keeping its local name with `as` when it differs). Anonymous default exports get refused per
   file. Files matching `--keep <glob,glob>` (default: none) are skipped — for route modules a
   framework needs as default exports.
5. `typescript-params-to-object` (refactor, `--file --symbol`): a function's positional parameters
   become one destructured object parameter, and every call site passes an object. Uses TypeScript's
   "Convert parameters to destructured object" refactor. Refuses for functions passed as values
   (callbacks), overloads, rest parameters, or call sites it cannot rewrite.
6. `typescript-inline-function` (refactor): "unpack" a function: a call is replaced by the
   function's code. All or nothing — there is no partial result. Two modes (decided by the user):
   - **One call** — `--file <path> --symbol <name> --at <path>:<line>[:<column>]`: the call to
     `<name>` at that position (1-based; `<column>` needed only when the line has more than one call
     of it) is unpacked. If that call cannot be unpacked safely, the action fails with
     `REFACTOR_UNAVAILABLE` and the reason. The declaration stays (other calls may use it).
   - **Definition** — `--file <path> --symbol <name>`: every use of the function is unpacked and the
     declaration is removed. Fails with `REFACTOR_UNAVAILABLE` (listing every blocking use and why)
     if the function is exported, is used other than as a direct call (passed as a value, referenced
     in a type, re-exported), or any of its calls cannot be unpacked safely.
   A call can be unpacked safely only when all of these hold:
   - The function is a function declaration or a `const` arrow/function expression, not recursive,
     not a generator or async (await inlining is a later step), uses no `this`, `arguments`,
     `super` or `new.target`.
   - Every free variable in the body resolves to the same declaration at the call site (same module,
     not shadowed there); body locals that clash with names in scope at the call site are renamed.
   - Body shape: either a single expression (expression-bodied arrow or a block with only
     `return <expr>`), or statements ending in exactly one `return` (or none) with no other `return`.
   - Single-expression bodies inline anywhere: parameters are substituted; an argument is substituted
     directly only if it is an identifier or literal and its parameter is used at most once, or it is
     an identifier/literal used any number of times; other arguments need hoisting (below).
   - Hoisting (multi-statement bodies, or arguments that are not simple): only at call sites that are
     a whole expression statement, the initializer of a `const`/`let` declaration with one
     declarator, or the expression of a `return` — the call is then the first thing evaluated in that
     statement, so arguments become `const` bindings in order, followed by the body statements, and
     the final `return e` becomes the statement's use of `e`.
   - Wrap substituted expressions in parentheses where precedence requires it.
7. `typescript-infer-return-types` (sweep, `--files`, `--exported-only` default true): functions and
   methods without a return type annotation get the type TypeScript infers, using its "Infer function
   return type" refactor. Skipped (listed in details) when the inferred type text contains `any`
   that was not written, or an `import("…")` type that would need a new import TypeScript did not
   add.
8. `typescript-namespace-to-named` (sweep, `--files`): `import * as x from "m"` where `x` is only
   used as `x.name` becomes `import { name, … } from "m"` (TypeScript's "Convert namespace import to
   named imports"), with clashes renamed by TypeScript. Skipped where `x` is used as a value on its
   own.
9. `typescript-import-type` (sweep, `--files`): imports and import specifiers used only as types
   become `import type` / `type` specifiers (TypeScript's fix-all for type-only imports).
10. `typescript-rename-files` (sweep, `--files`, `--case kebab|camel|pascal|snake`): files whose base
    name does not match the case are renamed with move-file's import rewriting. `index.*`, files
    whose new name collides (also by case alone with another file) are skipped and listed. A rename
    that only changes case (`Button.ts` → `button.ts`) is made: core `writeChanges` applies all
    deletions before all writes, so a case-insensitive file system never deletes the file just written.
    Path strings outside imports (`vi.mock("./x")`) are not rewritten, as in move-file.
11. `typescript-remove-console` (rewrite, `--files`, `--methods log` default, comma list): removes
    `console.<method>(…)` calls that are whole expression statements. Calls used as values are left
    and listed.

### Added later in the conversation (all `refactor`, targeted at one place)

Positions are `--at <path>:<line>[:<column>]`, 1-based; `<column>` is needed only when the line holds
more than one candidate.

12. `typescript-template-string` (refactor, `--at`): the string concatenation (`+` chain containing
    at least one string literal) at that position becomes a template literal, using TypeScript's
    "Convert to template string" refactor. Refuses when TypeScript does not offer it there.
13. `typescript-remove-unused-variable` (refactor, `--at` on the variable's name): removes a local
    `const`/`let`/`var` binding that nothing references. If it is one declarator of several, only
    that declarator goes; a destructured binding loses only that element when the rest stays valid.
    Refuses when the variable is referenced, exported, a module-level declaration that another file
    could see, a parameter, or when its initializer could have side effects (only literals,
    identifiers, function/arrow expressions, and object/array/template literals built from those
    count as side-effect free).
14. `typescript-convert-function` (refactor, `--at` on the function, `--to arrow|function`):
    - `--to arrow`: a function declaration becomes `const name = (…) => …` (or a function expression
      becomes an arrow, via TypeScript's refactor). Refuses when the function uses `this`,
      `arguments`, `super` or `new.target`, is a generator, is called with `new`, is overloaded, is
      a default export, or is referenced before its declaration in its scope (hoisting would break).
    - `--to function`: `const name = (…) => …` (or `function (…) {…}`) becomes a function
      declaration `function name(…) {…}`. Refuses when the arrow uses `this`, `arguments`, `super`
      or `new.target` (lexical in an arrow), when the variable has a type annotation (it would be
      lost), or when the declaration has other declarators.
    The function's body, type parameters, parameters and return type are kept.

The rest of the codemod ideas, and sweeps on part of a file (`--range`), are in `TODO.md`.

## Published codemods

They live as their own images: `containers/codemod-<name>/Containerfile`, each pinning one codemod
package version (and its runner, jscodeshift) installed at build time. A shared small package
`packages/action-codemod` is the entrypoint: `codemod --transform <name> --files <glob,glob>
[--parser tsx]` runs that transform from the pinned package over the matched files, offline. Each
image carries a table of its transforms and their kinds (judged by what each transform does: most
migrations are `rewrite`, pure import/syntax cleanups can be `sweep`); an unknown transform is
`INVALID_ARGS`. It reports that kind with the subject `<kind>(<package>@<version>/<transform>):
<globs>`. The first example is one well-known React codemod package (the builder picks and pins one that runs with
no network), demonstrated on `examples/react-app`. `scripts/build-images.sh` builds it with the rest.

## Tests

- Each action: node:test unit tests on the example repos, covering the safe path and each refusal
  listed above, with exact expected file contents where practical.
- Each new image and one action per image: a Swift integration test through the real binary,
  including the `Refactor-Kind` trailer.
- Existing tests keep passing (their subjects change prefix for sweeps; update those expectations).
