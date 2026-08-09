import { describe, expect, it } from "vitest";

import { diffLockfiles } from "../src/diff.js";
import { classifyBump, compareVersions, isBreaking, parseVersion } from "../src/semver.js";
import { lockfileOf } from "./fixtures.js";

describe("semver", () => {
  it.each([
    ["1.0.0", "1.0.1", -1],
    ["1.2.0", "1.10.0", -1],
    ["2.0.0", "10.0.0", -1],
    ["1.0.0", "1.0.0", 0],
    ["1.0.0", "1.0.0-rc.1", 1],
    ["1.0.0-rc.1", "1.0.0-rc.2", -1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-alpha.1", "1.0.0-beta", -1],
    ["1.0.0-1", "1.0.0-alpha", -1],
    ["1.0.0+build", "1.0.0", 0],
  ])("orders %s against %s", (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected);
  });

  it("sorts unparseable versions after real ones", () => {
    expect(compareVersions("1.0.0", "file:../local")).toBe(-1);
    expect(compareVersions("file:../local", "1.0.0")).toBe(1);
  });

  it.each([
    ["1.0.0", "2.0.0", "major"],
    ["1.0.0", "1.1.0", "minor"],
    ["1.0.0", "1.0.1", "patch"],
    ["1.0.0-rc.1", "1.0.0-rc.2", "prerelease"],
    ["2.0.0", "1.0.0", "downgrade"],
    ["1.0.0", "git+ssh://host/repo", "other"],
  ])("classifies %s -> %s as %s", (from, to, expected) => {
    expect(classifyBump(from, to)).toBe(expected);
  });

  it("treats a 0.x minor bump as breaking", () => {
    expect(isBreaking("0.21.5", "0.23.0", "minor")).toBe(true);
    expect(isBreaking("1.21.5", "1.23.0", "minor")).toBe(false);
    expect(isBreaking("1.0.0", "2.0.0", "major")).toBe(true);
  });

  it("parses only well-formed versions", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion("v1.2.3")?.major).toBe(1);
    expect(parseVersion("workspace:*")).toBeUndefined();
  });
});

describe("diffLockfiles", () => {
  it("splits packages into added, removed and changed", () => {
    const diff = diffLockfiles(
      lockfileOf(["chalk@5.0.0", "lodash@4.17.21", "left-pad@1.3.0"]),
      lockfileOf(["chalk@5.3.0", "lodash@4.17.21", "vite@7.0.0"]),
    );

    expect(diff.added.map((change) => change.name)).toEqual(["vite"]);
    expect(diff.removed.map((change) => change.name)).toEqual(["left-pad"]);
    expect(diff.changed.map((change) => change.name)).toEqual(["chalk"]);
  });

  it("records the highest version on each side", () => {
    const diff = diffLockfiles(lockfileOf(["chalk@4.1.2"]), lockfileOf(["chalk@4.1.2", "chalk@5.3.0"]));
    const [change] = diff.changed;

    expect(change?.from).toBe("4.1.2");
    expect(change?.to).toBe("5.3.0");
    expect(change?.bump).toBe("major");
    expect(change?.breaking).toBe(true);
  });

  it("reports a change when only the number of copies moves", () => {
    const diff = diffLockfiles(lockfileOf(["chalk@5.3.0"]), lockfileOf(["chalk@5.3.0", "chalk@4.1.2"]));

    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.after).toHaveLength(2);
    // The headline version did not move, so there is no bump to report.
    expect(diff.changed[0]?.bump).toBeUndefined();
  });

  it("ignores packages that are identical on both sides", () => {
    const diff = diffLockfiles(lockfileOf(["chalk@5.3.0"]), lockfileOf(["chalk@5.3.0"]));
    expect(diff.changed).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it("sorts changes with the most disruptive first", () => {
    const diff = diffLockfiles(
      lockfileOf(["a@1.0.0", "b@1.0.0", "c@2.0.0", "d@1.0.0"]),
      lockfileOf(["a@1.0.1", "b@2.0.0", "c@1.0.0", "d@1.1.0"]),
    );

    expect(diff.changed.map((change) => change.bump)).toEqual([
      "downgrade",
      "major",
      "minor",
      "patch",
    ]);
  });

  it("marks a package as dev-only when every copy is dev", () => {
    const diff = diffLockfiles(
      lockfileOf([{ name: "vitest", version: "1.0.0", dev: true }]),
      lockfileOf([{ name: "vitest", version: "2.0.0", dev: true }]),
    );
    expect(diff.changed[0]?.devOnly).toBe(true);
  });

  it("does not claim dev-only when the lockfile never said so", () => {
    const diff = diffLockfiles(lockfileOf(["vitest@1.0.0"]), lockfileOf(["vitest@2.0.0"]));
    expect(diff.changed[0]?.devOnly).toBe(false);
  });
});
