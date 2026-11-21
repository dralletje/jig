# Ideas

Bigger and stranger ideas for refactors that make reviewing agent-written changes simpler. Nothing
here needs to exist yet; this is the place to collect them. Concrete, near-term actions live in
`TODO.md`; built ones are described in `README.md` and `docs/superpowers/specs/`.

The theme: when every mechanical change is a replayable command, a reviewer only has to read what
is left over.

## Owner's favourites

- **Thread a value through a call chain.** "Make `tenantId` available in `sendEmail`": add a
  parameter to the function and to every caller up the chain until a place where the value already
  exists, passing it along at each level. Normally hundreds of tedious lines mixed into a feature;
  as its own command it is one line to review, and the feature diff that uses the value is tiny.
- **Partial refactors** (the owner's idea, from "bake a feature flag" and "change a type and let it
  spread"): refactors that deliberately do *not* leave a working tree, but do most of the mechanical
  work. The next commit, written by an agent or a person, finishes it and is small and easy to
  review on its own. See the section below.

## Partial refactors

A partial refactor does the large mechanical part of a change and stops where judgement starts. The
tree after it may not typecheck or pass tests; that is the point: what is broken is exactly the list
of decisions left.

Examples:
- **Change a type and let it spread**: `string` → `UserId`, rewritten through every place where the
  new type flows by itself; every remaining type error is a real decision point.
- **Bake a feature flag**: given the flag is permanently on, keep the "on" branch of every
  `if (FLAG)` and remove the dead side; where the flag is used in ways the transform cannot decide
  (passed as a value, combined in conditions), leave it and let the type checker or a marker point at
  it.
- **Add a required parameter** without knowing the value at every call site: every call gets the
  parameter as a placeholder (`undefined as never`, a `TODO` identifier), so each call site shows up
  as an error to fill in.
- **Rename across a boundary the tool cannot see** (another package, a string-based lookup): do the
  part it can see and list the rest.

What they need:
- **Marking.** Commits record that they are partial (for example a trailer `Refactor-Partial: yes`,
  or a kind of its own), so CI, `git bisect` (`git bisect skip`) and reviewers know the tree is
  expected to be broken at that commit.
- **The leftover list.** The commit message (or a trailer) lists what is left: the new type errors
  or the call sites with placeholders, with file and line. The follow-up commit can be checked
  against that list: it should touch exactly those places.
- **Pairing.** A partial refactor and its follow-up are reviewed as a pair: the first one by its
  command (mechanical, trusted), the second by reading (small, all judgement).
- **Replay.** Still replayable from the recorded command, like every other refactor commit.

## Change how a branch is made

- **Re-run a refactor instead of resolving its conflicts.** When a rebase conflicts on a refactor
  commit, drop that commit's diff and run its `Refactor-Command` again on the new base. Renames and
  moves, the worst merge conflicts on long-lived branches, never conflict again.
- **Move refactors to the bottom of the branch.** Replay every refactor commit straight onto the base
  first and put the hand-written commits on top, so the reviewer approves the mechanical part as a
  block and then reads only the real change.
- **Turn a messy diff into commands.** Take a working tree (an agent's or a person's) and recognise
  which parts are a rename, move, extract, format or import change; express those as replayable
  commits and leave only the remainder as the commit people actually read. A 2,000-line diff could
  become nine refactor commits and an 80-line change.
- **"Make the change easy, then make the easy change", automated.** Given the feature the agent wants
  to write, search for the sequence of refactors that makes the final hand-written diff smallest
  (params to an object before adding a parameter, extract a function before changing it, thread a
  value before using it).

## Refactors that shrink feature diffs

- **Thread a value through a call chain** (see the favourites above).
- **Change a type and let it spread** (see partial refactors).
- **Collapse layers of indirection**: inline chains of functions that only forward to another.
- **Merge duplicates, with proof**: find code blocks that are identical apart from names, extract one
  shared function, and record in the commit that they were identical.
- **Move code, with proof**: a move whose moved text is checked to be byte-identical, so a review
  shows "moved, unchanged" instead of a red block and a green block.
- **Split or merge files** by their top-level declarations, with imports fixed up.
- **Bake a feature flag** (`rewrite`, or partial — see above).

## Proof and presentation

- **"Public API unchanged" proof**: generate the package's type declarations (`.d.ts`) before and
  after; if identical, mark the commit as changing no public API.
- **Run tests before and after** and record the result in the commit, so a passing run travels with a
  sweep.
- **Show the command, not the diff**: a review tool or GitHub bot collapses each verified refactor
  commit to one line ("renamed `foo` → `bar`, 14 files, verified") and leaves unexplained changes
  expanded.
- **Find unexplained lines**: for a mixed commit, mark which lines no known refactor explains; that
  is where review time should go.

## Beyond one repo

- **Exact reverts after later changes**: the inverse of a rename is a rename; `revert` runs the
  opposite command instead of applying a reverse patch that no longer fits.
- **Library refactors become codemods for their users**: a library's `Refactor-Command` history turns
  into a migration downstream repos run on themselves.
