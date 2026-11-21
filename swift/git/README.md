# git (module `Git`)

Git, as the binary uses it on the caller's repo. Depends on `report` and `process`.

Public API:
- `Git(cwd:environment:)`: runs `git` with the caller's environment minus every `GIT_*` variable, plus
  `GIT_OPTIONAL_LOCKS=0` (a status stopped part way never leaves `.git/index.lock` in the repo) and
  `environment`; `raw`, `data` (stdout bytes) and `callAsFunction` (stdout text, for hashes and refs).
- `GitPath` (a path as exact bytes, ordered as git orders them), `NonUTF8Path`, `TreeEntry`,
  `lsTree(_:_:)`, `nulSeparated(_:)`, `nulSeparatedPaths(_:)`, `repoPathNotUTF8(_:)`, `assertClean(_:)`
  (also refuses assume-unchanged and skip-worktree entries).
- `Workspace(repo:)`: a temporary folder with the export (`dir`, what the sandbox mounts as
  `/workspace`) and a temporary index; `create()` makes the folders (register the removal first). `export(commit:)`, `scan()` (`.git` entries and every
  `.gitattributes`, by raw names, symlinks not followed), `capture()` (`git add -A` into the temporary
  index → tree), `writeTree()`, `restore(_:)`, `ignoredGitignores()`, `remove()` (true once the folder is gone; a failed removal is tried again by the
  next call), `leftover` (the folder's path until a removal succeeded).
- Checks on what an image left: `checkLeftovers(_:attributesBefore:)` (no `.git`, no `.gitattributes`
  change, before git reads the export), `checkCapture(_:git:head:tree:)` (no `.gitignore` change, no
  new or changed gitlink; removed gitlinks are put back).
- `fastForward(_:parent:commit:)`: `git merge --ff-only --no-overwrite-ignore` without hooks, inside
  `Lifecycle.mergeWindow`; `DIRTY_WORKTREE` when the repo moved while the image ran, else
  `IMAGE_FAILED`.
