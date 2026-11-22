# The fs image: commands that change the shape of the folder tree in /workspace (the repo root).
# Every command checks everything before it touches a file, then prints one report line
# (report v1, urn:jig:report:1) as the last line of stdout.

# Prints the failure report and exits 1.
def fail [code: string, instructions: string] {
  print ({schema: "urn:jig:report:1", ok: false, code: $code, instructions: $instructions} | to json --raw)
  exit 1
}

# Prints the success report. Every subject is `rewrite(fs <command>): ...`: the image names itself.
def ok [subject: string, summary: string] {
  print ({schema: "urn:jig:report:1", ok: true, kind: "rewrite", subject: $subject, summary: $summary} | to json --raw)
}

# Checks a path given on the command line and returns its normalized form: relative to the repo root,
# without a leading `./`, a trailing `/` or `.` parts. Refused (INVALID_ARGS): an empty path, an
# absolute one, the root itself, a `..` or `.git` part, and a path whose parent folders include a
# symlink or a file.
def normalize [path: string]: nothing -> string {
  if $path == "" {
    fail "INVALID_ARGS" 'The path "" is empty. Pass a path relative to the repo root.'
  }
  if ($path | str starts-with "/") {
    fail "INVALID_ARGS" $"The path \"($path)\" is absolute. Pass a path relative to the repo root."
  }
  let parts = ($path | split row "/" | where {|part| $part != "" and $part != "." })
  if ($parts | is-empty) {
    fail "INVALID_ARGS" $"The path \"($path)\" is the repo root itself. Pass a file or folder inside it."
  }
  if ".." in $parts {
    fail "INVALID_ARGS" $"The path \"($path)\" has a `..` part. Pass a path inside the repo, without `..`."
  }
  if ".git" in $parts {
    fail "INVALID_ARGS" $"The path \"($path)\" has a `.git` part. The fs image does not touch git's own files."
  }
  # Nushell's file commands expand `~` to HOME and `...` to `../..`, so these would leave the repo.
  for part in $parts {
    if ($part =~ '^\.{3,}$') or ($part | str starts-with "~") {
      fail "INVALID_ARGS" $"The path \"($path)\" has the part \"($part)\": names made only of dots, or starting with ~, are not supported as paths."
    }
  }
  for depth in 1..<($parts | length) {
    let parent = ($parts | first $depth | str join "/")
    # `path type` gives nothing for a missing path, which a `let` refuses as "expected string".
    let type = ($parent | path type | default "missing")
    if $type == "symlink" {
      fail "INVALID_ARGS" $"The path \"($path)\" goes through the symlink \"($parent)\". Pass the path the link points to instead."
    }
    if $type != "missing" and $type != "dir" {
      fail "INVALID_ARGS" $"The path \"($path)\" goes through \"($parent)\", which is not a folder."
    }
  }
  $parts | str join "/"
}

# Refuses (INVALID_ARGS) when anything exists at the path: a file, a folder or a symlink, a dangling one
# included (`path type` does not follow links).
def require-free [path: string] {
  if ($path | path type) != null {
    fail "INVALID_ARGS" $"\"($path)\" already exists. A destination must be free: pick another path, or remove \"($path)\" first."
  }
}

# Refuses (INVALID_ARGS) when nothing exists at the path.
def require-exists [path: string] {
  if ($path | path type) == null {
    fail "INVALID_ARGS" $"Nothing exists at \"($path)\". Pass an existing file or folder."
  }
}

# The number of files and symlinks at the path: 1 for a file or a symlink, else every file and symlink
# under the folder, dotfiles included, without following symlinks.
def count-files [path: string]: nothing -> int {
  if ($path | path type) != "dir" {
    return 1
  }
  cd $path
  glob --no-dir "**/*" | length
}

# Parses `--name value` pairs into a record. An unknown flag, a missing value, a repeated flag or
# anything that is not a flag is INVALID_ARGS with the usage.
def flags [args: list<string>, known: list<string>, usage: string]: nothing -> record {
  mut parsed = {}
  mut rest = $args
  while not ($rest | is-empty) {
    let arg = $rest.0
    if not ($arg | str starts-with "--") {
      fail "INVALID_ARGS" $"Unexpected argument \"($arg)\". Usage: ($usage)"
    }
    let name = ($arg | str substring 2..)
    if $name not-in $known {
      fail "INVALID_ARGS" $"Unknown flag ($arg). Usage: ($usage)"
    }
    if $name in $parsed {
      fail "INVALID_ARGS" $"The flag ($arg) is given twice. Usage: ($usage)"
    }
    if ($rest | length) < 2 {
      fail "INVALID_ARGS" $"The flag ($arg) needs a value. Usage: ($usage)"
    }
    $parsed = ($parsed | insert $name $rest.1)
    $rest = ($rest | skip 2)
  }
  $parsed
}

def copy [args: list<string>] {
  let usage = "copy --from <path> --to <path>"
  let given = (flags $args [from to] $usage)
  if "from" not-in $given {
    fail "INVALID_ARGS" $"copy needs --from. Usage: ($usage)"
  }
  if "to" not-in $given {
    fail "INVALID_ARGS" $"copy needs --to. Usage: ($usage)"
  }
  let from = (normalize $given.from)
  let to = (normalize $given.to)
  require-exists $from
  require-free $to
  if ($to | str starts-with $"($from)/") {
    fail "INVALID_ARGS" $"\"($to)\" is inside \"($from)\": a folder cannot be copied into itself. Pick a destination outside \"($from)\"."
  }
  let count = (count-files $from)
  let parent = ($to | path dirname)
  if $parent != "" {
    mkdir $parent
  }
  # --no-dereference copies symlinks as links, a folder's dotfiles come along, and --preserve [mode]
  # keeps every file's mode (without it, nu's cp applies the umask: 664 becomes 644).
  cp --recursive --no-dereference --preserve [mode] $from $to
  # nu's cp does not raise every error it meets, so check that everything arrived.
  if ($to | path type) == null {
    fail "INTERNAL" $"Copying \"($from)\" to \"($to)\" left nothing at \"($to)\"."
  }
  let copied = (count-files $to)
  if $copied != $count {
    fail "INTERNAL" $"Copying \"($from)\" to \"($to)\" copied ($copied) of ($count) files."
  }
  let files = if $count == 1 { "1 file" } else { $"($count) files" }
  ok $"rewrite\(fs copy\): ($from) → ($to)" $"Copied ($from) to ($to) \(($files)\)."
}

def move [args: list<string>] {
  let usage = "move --from <path> --to <path>"
  let given = (flags $args [from to] $usage)
  if "from" not-in $given {
    fail "INVALID_ARGS" $"move needs --from. Usage: ($usage)"
  }
  if "to" not-in $given {
    fail "INVALID_ARGS" $"move needs --to. Usage: ($usage)"
  }
  let from = (normalize $given.from)
  let to = (normalize $given.to)
  require-exists $from
  require-free $to
  if ($to | str starts-with $"($from)/") {
    fail "INVALID_ARGS" $"\"($to)\" is inside \"($from)\": a folder cannot be moved into itself. Pick a destination outside \"($from)\"."
  }
  let count = (count-files $from)
  let parent = ($to | path dirname)
  if $parent != "" {
    mkdir $parent
  }
  mv $from $to
  let files = if $count == 1 { "1 file" } else { $"($count) files" }
  ok $"rewrite\(fs move\): ($from) → ($to)" $"Moved ($from) to ($to) \(($files)\)."
}

def remove [args: list<string>] {
  let usage = "remove --paths <path,path>"
  let given = (flags $args [paths] $usage)
  if "paths" not-in $given {
    fail "INVALID_ARGS" $"remove needs --paths. Usage: ($usage)"
  }
  # Each item trimmed and empty items dropped, as the other images read their lists.
  let items = ($given.paths | split row "," | each {|item| $item | str trim } | where {|item| $item != "" })
  if ($items | is-empty) {
    fail "INVALID_ARGS" $"--paths \"($given.paths)\" names no path. Usage: ($usage)"
  }
  let paths = ($items | each {|path| normalize $path })
  for path in $paths {
    require-exists $path
  }
  for path in $paths {
    for other in $paths {
      if $path == $other {
        continue
      }
      if ($path | str starts-with $"($other)/") {
        fail "INVALID_ARGS" $"\"($path)\" is inside \"($other)\", which is removed too. Pass only \"($other)\"."
      }
    }
  }
  if ($paths | uniq | length) != ($paths | length) {
    fail "INVALID_ARGS" $"A path is given twice in \"($given.paths)\". Pass each path once."
  }
  let count = ($paths | each {|path| count-files $path } | math sum)
  for path in $paths {
    rm --recursive --permanent $path
  }
  let files = if $count == 1 { "1 file" } else { $"($count) files" }
  let named = ($paths | str join ", ")
  ok $"rewrite\(fs remove\): ($named)" $"Removed ($named) \(($files)\)."
}

def remove-matching [args: list<string>] {
  let usage = "remove-matching --files <glob,glob>"
  let given = (flags $args [files] $usage)
  if "files" not-in $given {
    fail "INVALID_ARGS" $"remove-matching needs --files. Usage: ($usage)"
  }
  # Each glob trimmed and empty ones dropped, as the other images read their lists.
  let globs = ($given.files | split row "," | each {|item| $item | str trim } | where {|item| $item != "" })
  if ($globs | is-empty) {
    fail "INVALID_ARGS" $"--files \"($given.files)\" names no glob. Usage: ($usage)"
  }
  for pattern in $globs {
    if ($pattern | str starts-with "/") {
      fail "INVALID_ARGS" $"The glob \"($pattern)\" is absolute. Pass a glob relative to the repo root."
    }
    if ".." in ($pattern | split row "/") {
      fail "INVALID_ARGS" $"The glob \"($pattern)\" has a `..` part. Pass a glob inside the repo, without `..`."
    }
    # Nushell expands `~` to HOME and `...` to `../..`, so these would leave the repo.
    for part in ($pattern | split row "/") {
      if ($part =~ '^\.{3,}$') or ($part | str starts-with "~") {
        fail "INVALID_ARGS" $"The glob \"($pattern)\" has the part \"($part)\": names made only of dots, or starting with ~, are not supported."
      }
    }
  }
  let root = (pwd)
  # glob matches dotfiles, does not follow symlinks into folders, and gives absolute paths. Folders are
  # left out (they are removed with `remove --paths`), and so is anything in git's own folder.
  let matched = (
    $globs
    | each {|pattern| glob --no-dir $pattern }
    | flatten
    | each {|path| $path | path relative-to $root }
    | where {|path| ".git" not-in ($path | split row "/") }
    | uniq
    | sort
  )
  # A glob that names a symlinked folder (`linked/*`) does go through it: refused like any such path.
  for path in $matched {
    normalize $path | ignore
  }
  let named = ($globs | str join ", ")
  if ($matched | is-empty) {
    fail "NO_CHANGES" $"No file matches ($named). Nothing to remove."
  }
  for path in $matched {
    rm --permanent $path
  }
  let count = ($matched | length)
  let files = if $count == 1 { "1 file" } else { $"($count) files" }
  # Listed like listLines in packages/core: two spaces in, at most 20, then `… and N more`.
  mut listed = ($matched | first 20 | each {|path| $"  ($path)" })
  if $count > 20 {
    $listed = ($listed | append $"  … and ($count - 20) more")
  }
  ok $"rewrite\(fs remove-matching\): ($named)" $"Removed ($files) matching ($named):\n($listed | str join "\n")"
}

def unwrap [args: list<string>] {
  let usage = "unwrap --folder <path>"
  let given = (flags $args [folder] $usage)
  if "folder" not-in $given {
    fail "INVALID_ARGS" $"unwrap needs --folder. Usage: ($usage)"
  }
  let folder = (normalize $given.folder)
  require-exists $folder
  if ($folder | path type) != "dir" {
    fail "INVALID_ARGS" $"\"($folder)\" is not a folder. unwrap moves a folder's contents up one level."
  }
  let parent = ($folder | path dirname)
  let names = (ls --all --short-names $folder | get name)
  # Where each item ends up. An item named like the folder itself is fine: the folder goes away first.
  let moves = (
    $names
    | each {|name|
        let to = if $parent == "" { $name } else { $"($parent)/($name)" }
        {name: $name, to: $to}
      }
  )
  let collisions = (
    $moves
    | where {|move| $move.to != $folder and ($move.to | path type) != null }
    | each {|move| $"\"($move.to)\"" }
  )
  if not ($collisions | is-empty) {
    fail "INVALID_ARGS" $"Unwrapping \"($folder)\" would overwrite ($collisions | str join ', '). A destination must be free: move or remove those first."
  }
  let count = (count-files $folder)
  # Git keeps no empty folders, so this only happens outside jig; refused until we know it is wanted.
  if $count == 0 {
    fail "NO_CHANGES" $"\"($folder)\" holds no files. Nothing to unwrap."
  }
  # A free temporary name next to the folder, so an item named like the folder can take its place.
  mut temporary = ""
  mut n = 0
  loop {
    let name = $".($folder | path basename).unwrap-($n)"
    $temporary = if $parent == "" { $name } else { $"($parent)/($name)" }
    # Not taken next to the folder, and not the name of an entry that is about to move there.
    if ($temporary | path type) == null and $name not-in $names {
      break
    }
    $n = $n + 1
  }
  mv $folder $temporary
  # Every path goes to cp/mv/rm as a plain variable: nu glob-expands a string built inline in the call,
  # so `app/[id]` would be read as a pattern.
  for move in $moves {
    let source = $"($temporary)/($move.name)"
    let destination = $move.to
    mv $source $destination
  }
  rm --recursive --permanent $temporary
  let files = if $count == 1 { "1 file" } else { $"($count) files" }
  let into = if $parent == "" { "the repo root" } else { $parent }
  ok $"rewrite\(fs unwrap\): ($folder)" $"Unwrapped ($folder) into ($into) \(($files)\)."
}

def wrap [args: list<string>] {
  let usage = "wrap --paths <path,path> --into <path>"
  let given = (flags $args [paths into] $usage)
  if "paths" not-in $given {
    fail "INVALID_ARGS" $"wrap needs --paths. Usage: ($usage)"
  }
  if "into" not-in $given {
    fail "INVALID_ARGS" $"wrap needs --into. Usage: ($usage)"
  }
  # Each item trimmed and empty items dropped, as the other images read their lists.
  let items = ($given.paths | split row "," | each {|item| $item | str trim } | where {|item| $item != "" })
  if ($items | is-empty) {
    fail "INVALID_ARGS" $"--paths \"($given.paths)\" names no path. Usage: ($usage)"
  }
  let paths = ($items | each {|path| normalize $path })
  let into = (normalize $given.into)
  for path in $paths {
    require-exists $path
  }
  require-free $into
  for path in $paths {
    if ($into | str starts-with $"($path)/") {
      fail "INVALID_ARGS" $"\"($into)\" is inside \"($path)\": a folder cannot be wrapped into itself. Pick a destination outside \"($path)\"."
    }
  }
  for path in $paths {
    for other in $paths {
      if $path == $other {
        continue
      }
      if ($path | str starts-with $"($other)/") {
        fail "INVALID_ARGS" $"\"($path)\" is inside \"($other)\", which is wrapped too. Pass only \"($other)\"."
      }
    }
  }
  let duplicates = (
    $paths
    | group-by {|path| $path | path basename }
    | items {|name, group| {name: $name, paths: $group} }
    | where {|entry| ($entry.paths | length) > 1 }
  )
  if not ($duplicates | is-empty) {
    let first = $duplicates.0
    let listed = ($first.paths | each {|path| $"\"($path)\"" } | str join ", ")
    fail "INVALID_ARGS" $"($listed) have the same name \"($first.name)\" and would collide in \"($into)\". Wrap them in separate runs, or rename one first."
  }
  let count = ($paths | each {|path| count-files $path } | math sum)
  mkdir $into
  for path in $paths {
    # A plain variable, never a string built inline: nu glob-expands those (`b[2]`).
    let destination = $"($into)/($path | path basename)"
    mv $path $destination
  }
  let files = if $count == 1 { "1 file" } else { $"($count) files" }
  let named = ($paths | str join ", ")
  ok $"rewrite\(fs wrap\): ($named) → ($into)" $"Wrapped ($named) into ($into) \(($files)\)."
}

# Prints the help (help v1, urn:jig:help:1): every command, its kinds and its flags.
def print-help [] {
  let help = {
    schema: "urn:jig:help:1"
    summary: "Copies, moves and removes files and folders."
    actions: [
      {
        name: "copy"
        kinds: ["rewrite"]
        summary: "Copies a file or folder to a free destination."
        flags: [
          {name: "--from", type: "path", required: true, description: "The file or folder to copy. Symlinks stay links and file modes are kept."}
          {name: "--to", type: "path", required: true, description: "Where the copy goes. It must be free and not inside --from; missing parent folders are created."}
        ]
      }
      {
        name: "move"
        kinds: ["rewrite"]
        summary: "Moves a file or folder to a free destination."
        flags: [
          {name: "--from", type: "path", required: true, description: "The file or folder to move."}
          {name: "--to", type: "path", required: true, description: "Where it goes. It must be free and not inside --from; missing parent folders are created."}
        ]
      }
      {
        name: "remove"
        kinds: ["rewrite"]
        summary: "Removes files and folders by path."
        flags: [
          {name: "--paths", type: "paths", required: true, description: "The files and folders to remove. Every path must exist."}
        ]
      }
      {
        name: "remove-matching"
        kinds: ["rewrite"]
        summary: "Removes every file a glob matches."
        flags: [
          {name: "--files", type: "globs", required: true, description: "The globs. Every file and symlink they match is removed, dotfiles too, never folders. No match is NO_CHANGES."}
        ]
      }
      {
        name: "unwrap"
        kinds: ["rewrite"]
        summary: "Moves a folder's contents up one level and removes the folder."
        flags: [
          {name: "--folder", type: "path", required: true, description: "The folder to unwrap. A name that collides with one already next to it refuses the whole run."}
        ]
      }
      {
        name: "wrap"
        kinds: ["rewrite"]
        summary: "Moves files and folders into a new folder."
        flags: [
          {name: "--paths", type: "paths", required: true, description: "The files and folders to move. Two with the same base name are refused."}
          {name: "--into", type: "path", required: true, description: "The new folder. It must be free and not inside any of --paths."}
        ]
      }
    ]
  }
  print ($help | to json --raw)
}

# Hand parsing (--wrapped), so nu's own flag errors never replace the JSON report.
def --wrapped main [...args: string] {
  try {
    # Help only when it is the one argument: `copy --help` is a normal run (and refused).
    if $args == ["--help"] {
      print-help
      return
    }
    let command = ($args | get 0?)
    let rest = ($args | skip 1)
    match $command {
      "copy" => { copy $rest }
      "move" => { move $rest }
      "remove" => { remove $rest }
      "remove-matching" => { remove-matching $rest }
      "unwrap" => { unwrap $rest }
      "wrap" => { wrap $rest }
      null => { fail "UNKNOWN_ACTION" "No command given. The fs image has: copy, move, remove, remove-matching, unwrap, wrap." }
      _ => { fail "UNKNOWN_ACTION" $"Unknown command \"($command)\". The fs image has: copy, move, remove, remove-matching, unwrap, wrap." }
    }
  } catch {|err|
    # The message, then what nu's error adds: its label texts, its help and its code.
    let details = ($err.details? | default {})
    let labels = (
      $details.labels?
      | default []
      | each {|label| $label.text? }
      | where {|text| $text != null and $text != "" and $text != $err.msg }
      | uniq
    )
    mut lines = [$err.msg]
    $lines = ($lines | append $labels)
    if ($details.help? | default "") != "" {
      $lines = ($lines | append $details.help)
    }
    if ($details.code? | default "") != "" {
      $lines = ($lines | append $"\(($details.code)\)")
    }
    fail "INTERNAL" $"The fs image failed unexpectedly: ($lines | str join '; ')"
  }
}
