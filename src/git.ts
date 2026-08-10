import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

export class GitError extends Error {}

interface RunOptions {
  cwd: string;
  /** Return undefined instead of throwing when git exits non-zero. */
  soft?: boolean;
}

function git(args: string[], options: RunOptions): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (error) {
    if (options.soft) return undefined;
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new GitError(stderr && stderr.length > 0 ? stderr : (error as Error).message);
  }
}

export function isGitRepository(cwd: string): boolean {
  return git(["rev-parse", "--git-dir"], { cwd, soft: true }) !== undefined;
}

/** True when the ref resolves to a commit in this repository. */
export function refExists(ref: string, cwd: string): boolean {
  return git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd, soft: true }) !== undefined;
}

/**
 * Read a file's contents at a git ref. Undefined when the path did not exist
 * there.
 *
 * The path is handed to git as `<ref>:./<name>` from the file's own directory,
 * rather than being made relative to `rev-parse --show-toplevel` here. That
 * matters because the two paths often disagree textually while pointing at the
 * same place: git reports the resolved path, so a symlinked directory (`/tmp`
 * on macOS is one) or a Windows 8.3 short name would otherwise produce a
 * relative path full of `../..` and silently read nothing.
 */
export function readFileAtRef(ref: string, filePath: string, cwd: string): string | undefined {
  const absolute = resolve(cwd, filePath);
  return git(["show", `${ref}:./${basename(absolute)}`], { cwd: dirname(absolute), soft: true });
}

/**
 * True when the file differs from HEAD in the working tree or the index.
 *
 * Addressed from the file's own directory for the same reason as
 * {@link readFileAtRef}: a path spelled differently from git's resolved one
 * lands outside the tree git thinks it is looking at, and an empty status
 * would read as "no local changes".
 */
export function hasLocalChanges(filePath: string, cwd: string): boolean {
  const absolute = resolve(cwd, filePath);
  const status = git(["status", "--porcelain", "--", `./${basename(absolute)}`], {
    cwd: dirname(absolute),
    soft: true,
  });
  return status !== undefined && status.length > 0;
}

export function mergeBase(a: string, b: string, cwd: string): string | undefined {
  return git(["merge-base", a, b], { cwd, soft: true });
}

export function shortSha(ref: string, cwd: string): string | undefined {
  return git(["rev-parse", "--short", ref], { cwd, soft: true });
}

/**
 * Work out what this branch should be compared against.
 *
 * On GitHub Actions the target branch is handed to us; locally the tracking
 * branch is the best answer, then the repository's default branch.
 */
export function detectBaseRef(cwd: string): string | undefined {
  const fromCi = process.env.GITHUB_BASE_REF;
  if (fromCi) {
    for (const candidate of [`origin/${fromCi}`, fromCi]) {
      if (refExists(candidate, cwd)) return candidate;
    }
  }

  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
    cwd,
    soft: true,
  });
  if (upstream && refExists(upstream, cwd)) return upstream;

  const originHead = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    cwd,
    soft: true,
  });
  if (originHead && refExists(originHead, cwd)) return originHead;

  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (refExists(candidate, cwd)) return candidate;
  }

  return undefined;
}
