import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { parseBunLock } from "./bun.js";
import { parseDenoLock } from "./deno.js";
import { parseNpmLock } from "./npm.js";
import { parsePnpmLock } from "./pnpm.js";
import { LockParseError, type Lockfile } from "./types.js";
import { parseYarnLock } from "./yarn.js";

/** Lockfile names lockreview understands, in the order it looks for them. */
export const SUPPORTED_LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "deno.lock",
] as const;

/**
 * `bun.lockb` is Bun's older binary format, which only Bun itself can read;
 * `bun install --save-text-lockfile` migrates it to the text `bun.lock`.
 */
const UNSUPPORTED_LOCKFILES = ["bun.lockb"] as const;

/** Parse a lockfile, choosing the reader from its filename. */
export function parseLockfile(path: string, text: string): Lockfile {
  const name = basename(path);

  if (name === "package-lock.json" || name === "npm-shrinkwrap.json") return parseNpmLock(text);
  if (name === "pnpm-lock.yaml" || name === "pnpm-lock.yml") return parsePnpmLock(text);
  if (name === "yarn.lock") return parseYarnLock(text);
  if (name === "bun.lock") return parseBunLock(text);
  if (name === "deno.lock") return parseDenoLock(text);

  if ((UNSUPPORTED_LOCKFILES as readonly string[]).includes(name)) {
    throw new LockParseError(
      `${name} is not supported yet. lockreview reads ${SUPPORTED_LOCKFILES.join(", ")}.`,
    );
  }

  // Files pulled out of git or saved by hand rarely keep their original name,
  // so fall back to recognising the format from the contents.
  const sniffed = sniffKind(text);
  if (sniffed === "npm") return parseNpmLock(text);
  if (sniffed === "pnpm") return parsePnpmLock(text);
  if (sniffed === "yarn") return parseYarnLock(text);
  if (sniffed === "bun") return parseBunLock(text);
  if (sniffed === "deno") return parseDenoLock(text);

  throw new LockParseError(
    `Cannot tell what kind of lockfile "${name}" is. Expected one of ${SUPPORTED_LOCKFILES.join(", ")}.`,
  );
}

/** Recognise a lockfile format from its first lines. */
export function sniffKind(text: string): "npm" | "pnpm" | "yarn" | "bun" | "deno" | undefined {
  const head = text.slice(0, 4096);

  // Bun is checked before npm: both are JSON objects carrying a
  // "lockfileVersion", and only Bun also keys its workspaces off "".
  if (/"lockfileVersion"\s*:/.test(head) && /"workspaces"\s*:\s*\{/.test(head)) return "bun";
  if (/^\s*\{/.test(head) && /"lockfileVersion"\s*:/.test(head)) return "npm";
  // Deno is the one JSON lockfile with no "lockfileVersion" at all: it numbers
  // itself with a bare "version", which package.json also carries — but as a
  // semver string, never the plain integer Deno writes.
  if (
    /^\s*\{/.test(head) &&
    /"version"\s*:\s*(?:"\d+"|\d+)\s*[,}]/.test(head) &&
    /"(npm|jsr|remote|redirects)"\s*:/.test(head)
  ) {
    return "deno";
  }
  if (/^\s*lockfileVersion\s*:/m.test(head)) return "pnpm";
  if (/^__metadata\s*:/m.test(head) || /yarn lockfile v1/.test(head)) return "yarn";

  return undefined;
}

/**
 * Find the lockfile for a project: check the directory, then walk up to the
 * filesystem root so the tool still works from inside a subdirectory.
 */
export function findLockfile(startDir: string): string | undefined {
  let dir = resolve(startDir);

  for (;;) {
    for (const name of SUPPORTED_LOCKFILES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Look for a lockfile this tool cannot read yet, to give a precise error. */
export function findUnsupportedLockfile(startDir: string): string | undefined {
  const dir = resolve(startDir);
  for (const name of UNSUPPORTED_LOCKFILES) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
