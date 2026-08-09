import { describe, expect, it } from "vitest";

import { parseNpmLock } from "../src/lock/npm.js";
import { parseLockfile, sniffKind } from "../src/lock/parse.js";
import { parsePnpmKey, parsePnpmLock } from "../src/lock/pnpm.js";
import { LockParseError } from "../src/lock/types.js";
import { nameFromDescriptor, parseYarnLock } from "../src/lock/yarn.js";
import { NPM_V1, NPM_V3, PNPM_V5, PNPM_V6, PNPM_V9, YARN_BERRY, YARN_CLASSIC } from "./fixtures.js";

const versionsOf = (lock: ReturnType<typeof parseNpmLock>, name: string): string[] =>
  (lock.packages.get(name) ?? []).map((pkg) => pkg.version);

describe("npm lockfiles", () => {
  const lock = parseNpmLock(NPM_V3);

  it("reads lockfileVersion 3", () => {
    expect(lock.kind).toBe("npm");
    expect(lock.lockfileVersion).toBe("3");
  });

  it("skips the root, workspace members and symlinks", () => {
    expect(lock.packages.has("")).toBe(false);
    expect(lock.packages.has("@demo/app")).toBe(false);
    expect(lock.packages.has("demo")).toBe(false);
  });

  it("keeps every version of a nested duplicate", () => {
    expect(versionsOf(lock, "chalk")).toEqual(["4.1.2", "5.3.0"]);
  });

  it("carries the metadata the risk rules depend on", () => {
    const esbuild = lock.packages.get("esbuild")?.[0];
    expect(esbuild?.hasInstallScript).toBe(true);
    expect(esbuild?.license).toBe("MIT");
    expect(esbuild?.dev).toBe(true);
    expect(esbuild?.integrity).toBe("sha512-esbuild");
  });

  it("flattens the nested tree of lockfileVersion 1", () => {
    const legacy = parseNpmLock(NPM_V1);
    expect(legacy.lockfileVersion).toBe("1");
    expect(versionsOf(legacy, "chalk")).toEqual(["5.3.0"]);
    expect(versionsOf(legacy, "ansi-styles")).toEqual(["6.2.1"]);
  });

  it("rejects invalid JSON with a readable message", () => {
    expect(() => parseNpmLock("{ not json")).toThrow(LockParseError);
  });
});

describe("pnpm lockfiles", () => {
  it("reads version 9 keys", () => {
    const lock = parsePnpmLock(PNPM_V9);
    expect(lock.lockfileVersion).toBe("9.0");
    expect(versionsOf(lock, "@babel/code-frame")).toEqual(["7.24.7"]);
    expect(versionsOf(lock, "chalk")).toEqual(["5.3.0"]);
    expect(lock.packages.get("request")?.[0]?.deprecated).toContain("deprecated");
  });

  it("ignores workspace directory links", () => {
    const lock = parsePnpmLock(PNPM_V9);
    expect(lock.packages.has("local-thing")).toBe(false);
  });

  it("reads version 6 keys and requiresBuild", () => {
    const lock = parsePnpmLock(PNPM_V6);
    expect(versionsOf(lock, "@babel/code-frame")).toEqual(["7.24.7"]);
    expect(lock.packages.get("esbuild")?.[0]?.hasInstallScript).toBe(true);
    expect(lock.packages.get("chalk")?.[0]?.dev).toBe(false);
  });

  it("reads version 5 keys with peer suffixes", () => {
    const lock = parsePnpmLock(PNPM_V5);
    expect(versionsOf(lock, "@storybook/react")).toEqual(["6.0.0"]);
    expect(versionsOf(lock, "chalk")).toEqual(["5.3.0"]);
  });

  it.each([
    ["chalk@5.3.0", "chalk", "5.3.0"],
    ["/chalk@5.3.0", "chalk", "5.3.0"],
    ["/@babel/code-frame@7.24.7", "@babel/code-frame", "7.24.7"],
    ["@babel/code-frame@7.24.7", "@babel/code-frame", "7.24.7"],
    ["/chalk/5.3.0", "chalk", "5.3.0"],
    ["/@storybook/react/6.0.0_react@16.13.1", "@storybook/react", "6.0.0"],
    ["@vitest/ui@1.0.0(vitest@1.0.0)", "@vitest/ui", "1.0.0"],
    ["some_pkg@1.0.0", "some_pkg", "1.0.0"],
  ])("parses the key %s", (key, name, version) => {
    expect(parsePnpmKey(key)).toEqual({ name, version });
  });

  it("ignores keys that are URLs", () => {
    expect(parsePnpmKey("https://codeload.github.com/x/y/tar.gz/abc")).toBeUndefined();
  });
});

describe("yarn lockfiles", () => {
  it("reads the classic format", () => {
    const lock = parseYarnLock(YARN_CLASSIC);
    expect(lock.kind).toBe("yarn");
    expect(lock.lockfileVersion).toBe("1");
    expect(versionsOf(lock, "@babel/code-frame")).toEqual(["7.24.7"]);
    expect(versionsOf(lock, "chalk")).toEqual(["5.3.0"]);
    expect(versionsOf(lock, "esbuild")).toEqual(["0.21.5"]);
    expect(lock.packages.get("chalk")?.[0]?.integrity).toBe("sha512-chalk");
  });

  it("does not treat nested dependency blocks as packages", () => {
    const lock = parseYarnLock(YARN_CLASSIC);
    expect(lock.packages.has("@babel/highlight")).toBe(false);
  });

  it("reads the berry format", () => {
    const lock = parseYarnLock(YARN_BERRY);
    expect(lock.kind).toBe("yarn-berry");
    expect(lock.lockfileVersion).toBe("8");
    expect(versionsOf(lock, "chalk")).toEqual(["5.3.0"]);
    expect(versionsOf(lock, "fsevents")).toEqual(["2.3.3"]);
  });

  it("skips workspace entries in berry", () => {
    const lock = parseYarnLock(YARN_BERRY);
    expect(lock.packages.has("demo")).toBe(false);
  });

  it.each([
    ["chalk@^5.0.0", "chalk"],
    ["@babel/code-frame@npm:^7.10.4", "@babel/code-frame"],
    ["fsevents@patch:fsevents@npm%3A2.3.3#optional!builtin", "fsevents"],
    ["ui@npm:@scope/ui@^1.0.0", "ui"],
    ["chalk", "chalk"],
  ])("takes the name from the descriptor %s", (descriptor, name) => {
    expect(nameFromDescriptor(descriptor)).toBe(name);
  });
});

describe("format detection", () => {
  it.each([
    [NPM_V3, "npm"],
    [PNPM_V9, "pnpm"],
    [YARN_BERRY, "yarn"],
    [YARN_CLASSIC, "yarn"],
  ])("recognises a lockfile from its contents", (text, kind) => {
    expect(sniffKind(text)).toBe(kind);
  });

  it("falls back to contents when the filename is unfamiliar", () => {
    expect(parseLockfile("saved-lock.txt", PNPM_V9).kind).toBe("pnpm");
  });

  it("names the package managers it cannot read yet", () => {
    expect(() => parseLockfile("bun.lockb", "")).toThrow(/not supported yet/);
  });

  it("gives up on content it does not recognise", () => {
    expect(() => parseLockfile("mystery.txt", "hello")).toThrow(LockParseError);
  });
});
