# TypeScript 7.1 in the typescript image: findings

Branch `typescript-7`. Question from the owner: can the typescript image run on TypeScript 7.1's API instead of
the 6.0.3 JavaScript library? Short answer: the parser, module resolution, programs, diagnostics and the checker
are there, and the image now plans duplicate-folder, move-file, rename-files and imports-to-* on it. The language
service features jig leans on most (rename locations, refactors, code fixes, organize imports) are not in 7.1's
API, so every other action stays on TypeScript 6.0.3. Both are installed: `typescript` (6.0.3) and `typescript7`
(`npm:typescript@7.1.0-beta`).

Versions on 2026-11-23: `latest` 7.0.2, `beta` 7.1.0-beta (used here), `next` 7.1.0-dev.20261123.1. 7.0 has no
programmatic API; 7.1 is the first with one.

## What 7.1 exposes to Node

Sources: the package's own typings (`dist/api/sync/api.d.ts`, `dist/api/proto.generated.d.ts`, `dist/api/fs.d.ts`,
`dist/ast/*.d.ts`), the [7.1 beta announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/),
and probes against the installed package.

- **Packaging.** `typescript@7.1` is a thin JS package plus one native compiler per platform, as dependencies
  `@typescript/typescript-<os>-<cpu>` (`linux-x64`, `linux-arm64`, … 21 in all, each about 10 MB). npm installs the one
  that fits. `lib/version.cjs` is the package's main; the API is in subpath exports.
- **Transport.** `typescript/sync` spawns the Go `tsc` binary and talks to it over its stdin/stdout with a
  MessagePack protocol; the sync client blocks on `readSync`/`writeSync` (`syncChannel.ts`, a pure-JS replacement
  for the old `libsyncrpc` addon). `typescript/async` is the same API with promises. One `API` object = one child
  process; `api.close()` (or `using`) stops it. Spawn and first request: about 10 ms.
- **Entry points.** `typescript/sync`, `typescript/async`, `typescript/fs` (request filesystems), `typescript/ast`
  (node types, `SyntaxKind`, `NodeFlags`, scanner, `forEachChild` as a node method, `getTokenAtPosition`…),
  `typescript/ast/is` (type guards), `typescript/ast/factory`, `typescript/ast/visitor`.
- **Batching.** Every method has a `.gen` generator form; `api.batch(...gens)` sends them in one round trip. Measured:
  1000 sequential `resolveModuleName` calls 175 ms, 3000 batched 215 ms.
- **Parser / AST.** No parser runs in JS. `api.createSourceFile(name, text)` parses in Go and ships a binary AST that the
  client decodes lazily; positions are UTF-16 offsets, `getStart`, `getText`, `parent`, `jsDoc`, `referencedFiles` are
  there. Differences from 6: `getModeForUsageLocation` and `impliedNodeFormat` need a program (a standalone source file
  has none); in JavaScript files the parser *also* puts JSDoc `@import` and `@type` into the tree as `Reparsed` nodes
  (a `JSImportDeclaration` statement, a type annotation), next to the JSDoc nodes themselves. `isStringLiteralLike` is
  gone (use `isStringLiteral || isNoSubstitutionTemplateLiteral`). Shipping ASTs is not free: 3000 small files took
  2.4 s to parse and read sequentially (TypeScript 6 in process: 1.6 s, cold).
- **Module resolution.** `api.createModuleResolver(options)` → `resolver.resolveModuleName(name, containingDirectory,
  mode, { snapshot })`. Resolution can run against a snapshot, so it sees that snapshot's filesystem.
- **Snapshots and filesystems.** `api.createSnapshot({ fileSystem, openProjects, openFiles, createPrograms, … })` and
  `snapshot.update(…)`. A filesystem is either full or a *layer* (`createFileSystemLayer(files, { removedPaths })`)
  over the disk or the base snapshot; layers stack across `update`. This is what replaces a custom
  `ModuleResolutionHost` / `LanguageServiceHost`: the engine's overlay becomes a layer. `openProjects` loads a tsconfig's
  configured project and builds its whole program (about 400 ms for 3000 files); `createPrograms` makes synthetic
  programs from root files and options (with `noResolve`/`noLib` they only parse).
- **Host filesystem callbacks.** `new API({ fs })` routes the compiler's own disk access (`readFile`, `fileExists`,
  `directoryExists`, `getAccessibleEntries`, `realpath`, `stat`, …) through JS callbacks, each of which can answer or
  hand back to the OS (`serverFS.useOS`).
- **Config.** `parseConfigFile`, `readConfigFile`, `parseJsonConfigFileContent`, `parseCommandLine` (about 35 ms for a
  tsconfig over 3000 files). Options come back finalized (`pathsBasePath`, absolute `baseUrl`). TypeScript 7 still
  reads `baseUrl` but resolves nothing through it: `paths` are relative to the tsconfig's folder.
- **Program.** `getSourceFile`, `getResolvedModule…`, `getModeForUsageLocation`, `getSourceFileMetadata`
  (`impliedNodeFormat`, package.json type), all diagnostics kinds, `emit`/`emitToString`.
- **Checker.** Broad: `getSymbolAtLocation`/`AtPosition`, `getTypeAtLocation`, `getTypeOfSymbol`, `getResolvedSignature`,
  `typeToString`, `typeToTypeNode`, `signatureToSignatureDeclaration`, `getAliasedSymbol`, `getExportsOfModule`,
  `getReferencesToSymbolInFile`, `resolveName`, `getSymbolsInScope`, `isTypeAssignableTo`, a printer (`printNode`).
- **Language service (API).** Only `getImportAdderEdits`, `getImportEditsForSymbols`, `getReferencedSymbolsForNode`,
  `getSignatureUsage`, `getCompletionsAtPosition`, `formatNodeForInsertion`. **No** rename, `findRenameLocations`,
  `getEditsForFileRename`, `organizeImports`, `getApplicableRefactors`/`getEditsForRefactor`, `getCodeFixesAtPosition`.
- **LSP server.** `tsc --lsp --stdio` (initialize probed) has `renameProvider`, `workspace.fileOperations.willRename`
  (the LSP form of `getEditsForFileRename`), code actions `quickfix`, `source.organizeImports.ts`,
  `source.removeUnusedImports.ts`, `source.sortImports.ts`, `source.fixAll.ts`, references, formatting. It has **no**
  `refactor.*` code actions (no extract, move to file, infer return type, convert parameters, convert to template
  string). `API.fromLSPConnection` can attach the 7.1 API to a running LSP session.

## Per action

"7.1" = runs on TypeScript 7.1 on this branch. "6" = still on 6.0.3, with why.

| Action | Now | Why / how |
|---|---|---|
| duplicate-folder | **7.1** | relocate core, below |
| move-file | **7.1** | relocate core |
| rename-files | **7.1** | relocate core |
| imports-to-relative, imports-to-alias, imports-to-subpath | **7.1** | `Sweep7` in import-style.ts, below |
| rename | 6 | needs `findRenameLocations`/`getRenameInfo` with prefix/suffix text: not in the API. The LSP server's `textDocument/rename` does it (and is fast, see numbers), but jig would need an LSP client and to feed the overlay through `didOpen`/`didChange`. |
| organize-imports | 6 | `organizeImports`: not in the API; the LSP server has `source.organizeImports.ts`. Same LSP-client cost as rename. |
| extract (move symbols to a file) | 6 | `getEditsForRefactor("Move to file")`: no refactors in 7.1, API or LSP. |
| infer-return-types | 6 | `getEditsForRefactor("Infer function return type")`: no refactors. Could be rebuilt on `checker.getReturnTypeOfSignature` + `typeToString`/`typeToTypeNode` + printer, by hand. |
| params-to-object | 6 | `getEditsForRefactor("Convert parameters to destructured object")` + `getReferencesAtPosition`: no refactors. |
| template-string | 6 | `getEditsForRefactor("Convert to template string")`: no refactors. |
| namespace-to-named, import-type | 6 | `getEditsForRefactor` and `getCodeFixesAtPosition`: neither in 7.1's API (code fixes only through LSP quickfix). |
| convert-function | 6 | `findReferences` + checker. 7.1 has `getReferencedSymbolsForNode` and a checker: portable in principle, not done. |
| inline-function, lift-out, remove-console, remove-unused-variable, default-to-named, remove-barrels | 6 | checker-only (plus 6's AST and text edits on the overlay's language service). 7.1's checker covers what they ask; each is a rewrite of a 500–1500 line file onto 7.1's AST, guards and snapshots. Not done in this pass. |
| add-import-extensions | 6 | uses the 6 program for resolution; portable like imports-to-*, not done. |
| subpath-imports | 6 | being removed on another branch; left untouched on purpose. |

### relocate core (duplicate-folder, move-file, rename-files)

`relocate.ts` no longer touches TypeScript 6:

- Each side of the change is a snapshot over a filesystem layer: *before* = the engine's overlay on the disk;
  *after* = that plus the copies (and minus the moved files). This replaces the two `ModuleResolutionHost` worlds.
- Importers are parsed by parse-only synthetic programs (`allowJs`, `noResolve`, `noLib`, `types: []`), one per
  nearest tsconfig, so each file gets its module format and each reference its resolution mode
  (`program.getModeForUsageLocation`) as TypeScript decides them; in move mode the moving files are parsed again at
  their new place in the after snapshot.
- All references of all importers are resolved before the change in one `api.batch`; candidates after the change
  are resolved one by one (few).
- Options come from `api.parseConfigFile` (not `openProjects`, which builds the whole program). A tsconfig's
  include/files check (was `ts.matchFiles`) is `api.parseConfigFile` while the API's filesystem callbacks answer
  `getAccessibleEntries`/`directoryExists`/`realpath` for folders under the root from the world being checked, as the 6
  version did with `matchFiles`' listing callback.
- `importSpecifiers7` skips `Reparsed` nodes so a JSDoc `@import` counts once (the JSDoc walk reads it).
- A tsconfig whose `baseUrl` is another folder than its own is refused (`REFACTOR_UNAVAILABLE`), since TypeScript 7
  would resolve its `paths` differently than the user's TypeScript 6 does.

### imports-to-*

`Sweep7` (import-style.ts): a snapshot over the overlay; per engine project (folder of a tsconfig, or the root) a
synthetic program of every TypeScript file under the folder with the tsconfig's options, as the engine's language
service has; specifiers, modes, resolution and the before/after diagnostics (`getSyntacticDiagnostics` +
`getSemanticDiagnostics`, chained messages joined) all on 7.1. A rewrite is a new layer via `snapshot.update`, and the
program is rebuilt incrementally. Same `baseUrl` refusal.

## Speed (6.0.3 vs 7.1.0-beta)

Machine: the 4-core workspace, shared with other jobs (load average 5–6 during the runs, so numbers wander; medians of
interleaved runs, min in brackets). Node 26.13.1. Each run builds the relocate benchmark repo of
`duplicate-folder.test.ts` (50-file folder `src/big`, 3000 importers, a root tsconfig with an `@/*` alias) and times
`main()` (load, plan, write). Script: `bench.ts` and `lsp-rename.mjs` in the session scratchpad (not committed).

| Action | 6.0.3 | 7.1 |
|---|---|---|
| duplicate-folder src/big → src/lib/big | 520 ms (329) | 510 ms (332) |
| move-file src/shared.ts → src/lib/shared.ts (3051 importers parsed) | 1490 ms (964) | 1807 ms (1237) |
| imports-to-relative on 200 files (each rewrite checked for new errors) | 26.8 s | 0.71 s |
| rename `shared` (3051 files): jig's rename action on 6's language service | 1629 ms | — (stays on 6) |
| same rename through 7.1's LSP server: spawn, open, `textDocument/rename` (6101 edits, not written) | — | 290 ms |

Reading:

- Where the work is parsing many small files and resolving each reference once (move-file), 7.1 is *slower*: every
  AST crosses the pipe and is decoded in JS (about 350 ms of the 1.2 s for 3000 files), against 6's in-process parser.
  duplicate-folder (50 importers) is a tie.
- Where the work is checking (imports-to-*, which re-checks each rewritten file), 7.1 is 38× faster: the Go checker
  plus incremental snapshot updates against 6's language service re-checking per write.
- The language-service features 7.1 does have (through LSP) are about 5× faster on rename than jig's 6-based rename.
  That is the strongest case for an LSP client in the image later, for rename and organize-imports.

Earlier, before switching options and include checks from `openProjects` to `parseConfigFile` + filesystem
callbacks, 7.1 took about twice as long on duplicate-folder: opening a configured project builds its program.

## Test changes

All 562 package tests pass (`sh scripts/test-packages.sh`), and `pnpm -r typecheck` is clean.

1. `actions.test.ts`: removed "a TypeScript without the internal matchFiles is refused, not crashed on". relocate
   no longer uses `ts.matchFiles`, so there is nothing to strip; its two unused imports went with it.
2. `import-style.test.ts`: "paths relative to baseUrl: the alias folder is found through it…" became "a baseUrl other
   than the tsconfig's folder is refused: TypeScript 7 no longer resolves through it" (same fixture, now expects
   `REFACTOR_UNAVAILABLE` and no changes). The `baseUrl: "."` test is unchanged and passes.

## Image

No Containerfile change: `containers/typescript/package-lock.json` now locks `typescript7` and the platform packages
as optional, and `npm ci` installs the one for the build platform (linux-x64 here; linux-arm64 on arm). The image
grows from 386 MB to 432 MB. Built with a copy of `scripts/build-images.sh` tagged `localhost/jig/typescript:ts7`;
`jig --repo <copy of examples/duplicate-folder> localhost/jig/typescript:ts7 duplicate-folder --from src/feature --to
src/feature2` committed the same 5 files, byte for byte, as the 6.0.3 image (`:local`).

## Open points

- 7.1 is a beta; the API's protocol is unversioned between the JS client and the binary (both come from the same
  package, so the lockfile keeps them together).
- Mixed engines: actions on 6 and on 7 can see a repo differently where 6 and 7 differ (baseUrl, removed options,
  module-resolution defaults with no tsconfig). Only baseUrl is guarded.
- Next candidates, in order: rename and organize-imports through the LSP server; the checker-only actions on the 7.1
  API; refactor-based actions wait for TypeScript to expose refactors.
