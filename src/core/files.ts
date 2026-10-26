/**
 * Personal data files: readable by you only. New files get that from umask 077 (bot.ts, cli.ts), but files
 * created by an older version keep whatever mode they had – so fix them on start.
 */
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const PRIVATE_FILES = [".session.json", "history.json", ".basket.json", "families.json", ".recipe-usage.json"];
export const PRIVATE_DIRS = ["orders"];

/** chmod 600 the agent's files and 700 its folders (and 600 the files inside). Returns how many were changed. */
export function securePrivateFiles(root = "."): number {
  let changed = 0;
  const fix = (path: string, mode: number) => {
    try {
      if ((statSync(path).mode & 0o777) !== mode) {
        chmodSync(path, mode);
        changed++;
      }
    } catch {
      // not there, or not ours – nothing to fix
    }
  };
  for (const f of PRIVATE_FILES) fix(join(root, f), 0o600);
  for (const d of PRIVATE_DIRS) {
    const dir = join(root, d);
    if (!existsSync(dir)) continue;
    fix(dir, 0o700);
    for (const f of readdirSync(dir)) fix(join(dir, f), 0o600);
  }
  return changed;
}
