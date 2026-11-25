# TODO

Things the owner wants eventually, not yet planned in detail. Each action line gives its intended
kind (`refactor` = targeted and behaviour-preserving, `sweep` = generic many-file and
behaviour-preserving, `rewrite` = changes behaviour in a simple, repetitive way). See the specs in
`docs/superpowers/specs/` for what is already built or in progress.

Bigger ideas (threading a value through a call chain, partial refactors, turning a messy diff into
commands, and more) are collected in `IDEAS.md`.

## Tooling

- Match tool versions to the target repo (TypeScript, prettier) by building images per version.
- Publish the images: push to `ghcr.io` from CI (public, anonymous pulls, no Hub rate limits), record
  the registry manifest digest (`ghcr.io/<org>/…@sha256:…`) in `Refactor-Command` instead of the local
  image ID so replays work on any machine or mirror, sign with cosign (Sigstore, keyless via the CI
  identity) and let the binary verify before running, and build for amd64 and arm64. Needs a GitHub
  remote first. Any OCI registry works (Docker Hub, Quay, self-hosted Zot/Harbor) since the digest is
  content-addressed.
- Renaming non-top-level symbols; other languages and tools.

## Sweeps on part of a file

Let some sweeps work on a range instead of whole files: `--range <path>:<startLine>-<endLine>`
(1-based, inclusive), alongside or instead of `--files`. Only nodes that lie entirely inside the range
are touched. Fits:
- `format`: prettier's own `rangeStart`/`rangeEnd`.
- `infer-return-types`, `remove-console`, `let` → `const`, `==` → `===`,
  optional chaining, `includes`, `forEach` → `for…of`, template strings: per node, so a range is
  natural.
- Import sweeps (`add-import-extensions`, `namespace-to-named`, `import-type`):
  per import declaration in the range.
Not a fit: `organize-imports` (one import block), `remove-barrels`, `rename-files`,
`default-to-named` (file-level by nature).

## More actions

### refactor
- Extract a constant or function from an expression at `--at <path>:<line>:<col>[-<line>:<col>]`
  (TypeScript's extract refactors). Whole statements are done: `extract-function`.
- Promise chain → async/await for one function (TypeScript's "Convert to async function"), only where
  the result is just returned.

### sweep
- `let` → `const` where never reassigned.
- `var` → `let`/`const` where hoisting and scope cannot make a difference.
- String concatenation → template literals where one operand is a string literal (the many-file
  version of `template-string`).
- Remove unused local variables and parameters where side-effect free (the many-file version of
  `remove-unused-variable`).

### rewrite
- Remove `debugger` statements.
- `==` → `===` and `!=` → `!==`.
- `a && a.b` → `a?.b`.
- `indexOf(x) !== -1` → `includes(x)`.
- `forEach` → `for…of`.
- `substr` → `slice`.
- More published migration codemods, each as its own pinned image under `containers/codemod-<name>/`
  (`containers/codemod-react` carries `react-codemod` already): `types-react-codemod` (React 19:
  `ReactDOM.render` → `createRoot`, remove `forwardRef`), Next.js (`@next/codemod`: async request APIs),
  Jest → Vitest.

## Known limits worth lifting

What the actions leave alone today (from the code and the README), each worth doing when it comes up:

- `default-to-named`: JavaScript importers are only scanned syntactically (no resolution through
  tsconfig `paths`), and `require()`, `import()`, namespace imports and `vi.mock`/`jest.mock` factories of
  the default are left alone (named in the summary) instead of being rewritten.
- Moving files: on a case-insensitive file system a move that only changes the case of a folder
  (`src/Utils/a.ts` → `src/utils/a.ts`) is refused with a misleading "already exists" (the exact-case check
  only looks at the file name, not at the folders above it); file-only case changes work.
- Case-insensitive file systems with Unicode normalization (HFS+ stores names decomposed): the exact-case
  existence checks of moves and renames compare names as written, so composed and decomposed spellings of
  the same name are not told apart.
- `inline-function`: comments inside the function body are dropped (only comments attached to its
  statements are kept); generics, async functions, early returns, optional/rest/default parameters and
  calls from other modules are refused rather than handled.
- `convert-function`: hoisting is only checked for uses in the same file (a circular import that
  calls the function while modules evaluate is not seen).
- `remove-unused-variable`: parameters are refused (needs the callers updated); dropping the
  only element of an object pattern also drops a getter call and the `TypeError` for a `null` source, which is
  accepted and not checked.
- `move-file`/`extract`: TypeScript's "Move to file" does not rewrite re-exports
  (`export { foo } from "./a"`).
- `rename-files`: path strings outside imports (`vi.mock("./x")`) are not rewritten.
- References across package boundaries (workspace links, an `extends` from npm) are not followed by any
  TypeScript action.

## Small follow-ups (from the sandbox review)

- `swift/cli` integration: move `interruptedDuringTheExport` (rootlesskit suite) under the serialized
  docker-interruptions parent so it cannot overlap them under load.
- `sandbox+rootlesskit`: `leftovers` accumulates across `cleanup()` calls; the protocol says it lists what
  the last cleanup could not remove — reset it per cleanup or change the wording.
