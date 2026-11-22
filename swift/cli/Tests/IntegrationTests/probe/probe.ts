// Test-only image entrypoint. It checks what the container can see, and fakes the ways an image can
// behave, chosen by argv[0]. It runs with `/workspace` as its working directory.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const [mode, ...rest] = process.argv.slice(2);
const SCHEMA = "urn:jig:report:1";
/** A report v1 of kind refactor whose summary names the mode. */
const ok = (subject: string) =>
  console.log(JSON.stringify({ schema: SCHEMA, ok: true, kind: "refactor", subject, summary: `The probe ran ${mode}.` }));
const failed = (code: string, instructions: string) => console.log(JSON.stringify({ schema: SCHEMA, ok: false, code, instructions }));

async function hasNetwork(): Promise<boolean> {
  try {
    await fetch("http://1.1.1.1", { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

function write(path: string, text = "from image\n"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Every regular file under `dir`, by relative path, as base64. */
function files(dir: string, rel = "", out: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files(dir, path, out);
    else if (entry.isFile()) out[path] = readFileSync(join(dir, path)).toString("base64");
  }
  return out;
}

switch (mode) {
  case "check": {
    const seen = { nodeModules: existsSync("node_modules"), git: existsSync(".git"), network: await hasNetwork(), args: rest };
    writeFileSync("probe.json", `${JSON.stringify(seen)}\n`);
    ok("refactor(probe check): ran");
    break;
  }
  case "tree":
    // Writes `tree.json`: every regular file it sees, as base64.
    writeFileSync("tree.json", `${JSON.stringify(files("."))}\n`);
    ok("refactor(probe tree): ran");
    break;
  case "noisy":
    console.log("log one");
    console.log("{not json");
    console.log('{"ok":"not a boolean"}');
    writeFileSync("n.txt", "noisy\n");
    ok("refactor(probe noisy): ran");
    break;
  case "crash":
    console.log("boom");
    process.exit(3);
  case "fail":
    failed("SYMBOL_NOT_FOUND", "nope");
    process.exit(1);
  case "legacy":
    // A report from before report v1: no schema.
    writeFileSync("l.txt", "legacy\n");
    console.log(JSON.stringify({ ok: true, kind: "refactor", subject: "probe: legacy" }));
    break;
  case "partial":
    // A partial result: one change, and the place it could not handle named in the summary.
    writeFileSync("p.txt", "partial\n");
    console.log(
      JSON.stringify({
        schema: SCHEMA,
        ok: true,
        kind: "rewrite",
        subject: "rewrite(probe partial): ran",
        summary: "Changed p.txt.\n\nNot handled (1):\n  q.txt:3: q.txt is not handled\n    Change q.txt by hand.",
      }),
    );
    break;
  case "status":
    // A report with a key v1 no longer has (`status`): the image is out of date.
    writeFileSync("s.txt", "status\n");
    console.log(
      JSON.stringify({
        schema: SCHEMA,
        ok: true,
        kind: "refactor",
        status: "complete",
        subject: "refactor(probe status): ran",
        summary: "The probe ran status.",
      }),
    );
    break;
  case "none":
    ok("refactor(probe none): ran");
    break;
  case "write":
    // `write <path...>`: creates each path (and its folders) with the text "from image".
    for (const path of rest) write(path);
    ok("refactor(probe write): ran");
    break;
  case "gitfile":
    // `gitfile <path> <gitdir>`: a gitfile (`gitdir: <gitdir>`) at <path>, plus a new file.
    write(rest[0] as string, `gitdir: ${rest[1]}\n`);
    writeFileSync("fresh.txt", "fresh\n");
    ok("refactor(probe gitfile): ran");
    break;
  case "rm":
    // `rm <path...>`: removes each path, folders included.
    for (const path of rest) rmSync(path, { recursive: true, force: true });
    ok("refactor(probe rm): ran");
    break;
  case "mix":
    writeFileSync("a.ts", "// changed\n");
    write("new/deep/n.ts", "export {};\n");
    unlinkSync("b.ts");
    ok("refactor(probe mix): ran");
    break;
  case "replace-dir":
    // `replace-dir <path>`: the folder at <path> becomes a file.
    rmSync(rest[0] as string, { recursive: true });
    writeFileSync(rest[0] as string, "now a file\n");
    ok("refactor(probe replace-dir): ran");
    break;
  case "ignore-self":
    // `ignore-self <dir>`: a new `<dir>/.gitignore` that ignores itself and a file next to it.
    write(`${rest[0]}/.gitignore`, "*\n");
    write(`${rest[0]}/hidden.txt`);
    ok("refactor(probe ignore-self): ran");
    break;
  case "exec":
    appendFileSync("run.sh", "# x\n");
    ok("refactor(probe exec): ran");
    break;
  case "exec-new":
    writeFileSync("new.sh", "#!/bin/sh\necho new\n");
    chmodSync("new.sh", 0o755);
    ok("refactor(probe exec-new): ran");
    break;
  case "readonly-dir":
    // A normal change, plus a folder the host cannot delete without chmod.
    writeFileSync("n.txt", "readonly\n");
    mkdirSync("ro");
    writeFileSync("ro/x", "x\n");
    chmodSync("ro", 0o555);
    ok("refactor(probe readonly-dir): ran");
    break;
  case "hidden-git":
    // A `.git` inside a folder that can be listed but whose entries cannot be inspected (no x bit).
    write("d/sub/.git/x");
    writeFileSync("fresh.txt", "fresh\n");
    chmodSync("d", 0o444);
    ok("refactor(probe hidden-git): ran");
    break;
  case "subject":
    // `subject <text>`: reports the text (with `\n` and `\r` escapes read as newlines) as the subject.
    writeFileSync("s.txt", "s\n");
    ok((rest[0] ?? "").replace(/\\n/g, "\n").replace(/\\r/g, "\r"));
    break;
  case "random":
    // Writes `r.txt` with random content: a different tree on every run, with the same report.
    writeFileSync("r.txt", `${randomUUID()}\n`);
    ok("refactor(probe random): ran");
    break;
  case "write-text":
    // `write-text <path> <text>`: creates <path> (and its folders) with <text> and a newline.
    write(rest[0] as string, `${rest[1]}\n`);
    ok("refactor(probe write-text): ran");
    break;
  case "sleep":
    // `sleep <seconds> [<token>]`: a slow (or, with a large number, hanging) image. The token only
    // marks the container (its args) so a test can find it.
    await new Promise((resolve) => setTimeout(resolve, Number(rest[0]) * 1000));
    writeFileSync("slept.txt", "slept\n");
    ok("refactor(probe sleep): ran");
    break;
  case "spew": {
    // `spew [<token>]`: writes files into 50 folders, forever, as fast as it can (an image still writing
    // when the run is interrupted). The token only marks the container.
    for (let i = 0; ; i++) {
      const dir = `d${i % 50}`;
      if (i < 50) mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/f${i}`, "x\n");
      // Let the event loop breathe now and then, so signals and timers are not starved.
      if (i % 1000 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
  }
  case "bad-name":
    // A file whose name is not valid UTF-8 (b, 0xff, .txt), plus a normal change.
    writeFileSync(Buffer.from([0x62, 0xff, 0x2e, 0x74, 0x78, 0x74]), "bad\n");
    writeFileSync("fresh.txt", "fresh\n");
    ok("refactor(probe bad-name): ran");
    break;
  case "bad-dir":
    // A folder whose name is not valid UTF-8 (d, 0xfe) holding a `.git` folder.
    mkdirSync(Buffer.from([0x64, 0xfe]));
    mkdirSync(Buffer.concat([Buffer.from([0x64, 0xfe]), Buffer.from("/.git")]));
    writeFileSync("fresh.txt", "fresh\n");
    ok("refactor(probe bad-dir): ran");
    break;
  default:
    failed("UNKNOWN_ACTION", `unknown: ${mode}`);
    process.exit(1);
}
