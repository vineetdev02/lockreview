import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  detectBaseRef,
  hasLocalChanges,
  isGitRepository,
  mergeBase,
  readFileAtRef,
  refExists,
} from "../src/git.js";
import { findLockfile } from "../src/lock/parse.js";

/**
 * These run against a real repository rather than a mock: the parts worth
 * testing are exactly the ones that talk to git.
 */
describe("git integration", () => {
  let repo: string;
  let lockfile: string;

  const run = (...args: string[]): void => {
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  };

  const writeLock = (packages: Record<string, unknown>): void => {
    writeFileSync(lockfile, `${JSON.stringify({ lockfileVersion: 3, packages }, null, 2)}\n`);
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "lockreview-test-"));
    lockfile = join(repo, "package-lock.json");

    run("init", "--initial-branch=main");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "lockreview test");
    run("config", "commit.gpgsign", "false");

    writeLock({ "node_modules/chalk": { version: "5.0.0" } });
    run("add", ".");
    run("commit", "-m", "first");

    run("checkout", "-b", "feature");
    writeLock({ "node_modules/chalk": { version: "5.3.0" } });
    run("commit", "-am", "bump chalk");
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("recognises the repository", () => {
    expect(isGitRepository(repo)).toBe(true);
    expect(isGitRepository(tmpdir())).toBe(false);
  });

  it("finds the lockfile from the repository root", () => {
    expect(findLockfile(repo)).toBe(lockfile);
  });

  it("resolves refs that exist and rejects ones that do not", () => {
    expect(refExists("main", repo)).toBe(true);
    expect(refExists("nope", repo)).toBe(false);
  });

  it("reads the lockfile as it was at another ref", () => {
    const text = readFileAtRef("main", lockfile, repo);
    expect(text).toContain("5.0.0");
    expect(readFileAtRef("feature", lockfile, repo)).toContain("5.3.0");
  });

  it("returns nothing for a path that did not exist at that ref", () => {
    expect(readFileAtRef("main", join(repo, "absent.json"), repo)).toBeUndefined();
  });

  it("finds the point the branch forked from", () => {
    const base = mergeBase("main", "HEAD", repo);
    expect(base).toBeTruthy();
    expect(readFileAtRef(base as string, lockfile, repo)).toContain("5.0.0");
  });

  it("detects the default branch as the base", () => {
    expect(detectBaseRef(repo)).toBe("main");
  });

  /**
   * git reports the *resolved* path for a repository, so any path that reaches
   * the same place by another spelling — a symlinked directory, a Windows 8.3
   * short name — used to make the ref read silently return nothing.
   */
  it.skipIf(platform() === "win32")("reads through a symlinked path to the repository", () => {
    const alias = join(dirname(repo), `alias-${Date.now()}`);
    symlinkSync(repo, alias, "dir");

    try {
      const viaAlias = readFileAtRef("main", join(alias, "package-lock.json"), alias);
      expect(viaAlias).toContain("5.0.0");
      expect(viaAlias).toBe(readFileAtRef("main", lockfile, repo));

      writeLock({ "node_modules/chalk": { version: "5.9.9" } });
      expect(hasLocalChanges(join(alias, "package-lock.json"), alias)).toBe(true);
      run("checkout", "--", "package-lock.json");
    } finally {
      rmSync(alias, { force: true });
    }
  });

  it("notices uncommitted edits to the lockfile", () => {
    expect(hasLocalChanges(lockfile, repo)).toBe(false);
    writeLock({ "node_modules/chalk": { version: "5.4.0" } });
    expect(hasLocalChanges(lockfile, repo)).toBe(true);
    run("checkout", "--", "package-lock.json");
  });
});
