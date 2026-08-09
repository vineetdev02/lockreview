import { execFileSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";

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

export function repositoryRoot(cwd: string): string | undefined {
  return git(["rev-parse", "--show-toplevel"], { cwd, soft: true });
}

/** True when the ref resolves to a commit in this repository. */
export function refExists(ref: string, cwd: string): boolean {
  return git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd, soft: true }) !== undefined;
}

/** Read a file's contents at a git ref. Undefined when the path did not exist there. */
export function readFileAtRef(ref: string, filePath: string, cwd: string): string | undefined {
  const root = repositoryRoot(cwd);
  if (!root) throw new GitError("Not inside a git repository.");

  // git addresses paths from the repository root, always with forward slashes.
  const relativePath = relative(root, resolve(filePath)).split(sep).join("/");
  return git(["show", `${ref}:${relativePath}`], { cwd, soft: true });
}

/** True when the file differs from HEAD in the working tree or the index. */
export function hasLocalChanges(filePath: string, cwd: string): boolean {
  const status = git(["status", "--porcelain", "--", filePath], { cwd, soft: true });
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
