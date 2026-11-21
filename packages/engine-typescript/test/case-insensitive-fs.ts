import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";

/**
 * Makes `node:fs` behave like a case-insensitive, case-preserving file system (macOS through a Docker
 * Desktop bind mount) for paths under `root`: reading, stat-ing, writing and removing a path finds a file
 * that exists under another case. `readdirSync` stays exact, as on such a file system. Patches the
 * process; call the returned function to undo it.
 */
export function caseInsensitiveFs(root: string): () => void {
  const orig = {
    readFileSync: fs.readFileSync,
    existsSync: fs.existsSync,
    statSync: fs.statSync,
    lstatSync: fs.lstatSync,
    readdirSync: fs.readdirSync,
    rm: fs.promises.rm,
    writeFile: fs.promises.writeFile,
    readFile: fs.promises.readFile,
  };

  /** The real path of `p` when it exists under another case; else `p`. */
  const ci = (p: unknown): any => {
    if (typeof p !== "string" || !p.startsWith(root)) return p;
    if (orig.existsSync(p)) return p;
    const dir = dirname(p);
    if (dir === p) return p;
    const realDir: string = ci(dir);
    let entries: string[];
    try {
      entries = orig.readdirSync(realDir) as string[];
    } catch {
      return p;
    }
    const want = basename(p).toLowerCase();
    const hit = entries.find((e) => e.toLowerCase() === want);
    return join(realDir, hit ?? basename(p));
  };

  const f = fs as any;
  const promises = fs.promises as any;
  f.readFileSync = (p: unknown, ...a: unknown[]) => (orig.readFileSync as any)(ci(p), ...a);
  f.existsSync = (p: unknown) => orig.existsSync(ci(p));
  f.statSync = (p: unknown, ...a: unknown[]) => (orig.statSync as any)(ci(p), ...a);
  f.lstatSync = (p: unknown, ...a: unknown[]) => (orig.lstatSync as any)(ci(p), ...a);
  promises.rm = (p: unknown, ...a: unknown[]) => (orig.rm as any)(ci(p), ...a);
  promises.writeFile = (p: unknown, ...a: unknown[]) => (orig.writeFile as any)(ci(p), ...a);
  promises.readFile = (p: unknown, ...a: unknown[]) => (orig.readFile as any)(ci(p), ...a);
  syncBuiltinESMExports();

  return () => {
    Object.assign(f, {
      readFileSync: orig.readFileSync,
      existsSync: orig.existsSync,
      statSync: orig.statSync,
      lstatSync: orig.lstatSync,
    });
    Object.assign(promises, { rm: orig.rm, writeFile: orig.writeFile, readFile: orig.readFile });
    syncBuiltinESMExports();
  };
}
