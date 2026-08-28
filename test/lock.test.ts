import { describe, expect, it } from "vitest";

import { parseNpmLock } from "../src/lock/npm.js";
import { parseLockfile, sniffKind } from "../src/lock/parse.js";
import { parsePnpmKey, parsePnpmLock } from "../src/lock/pnpm.js";
import { LockParseError } from "../src/lock/types.js";
import { nameFromDescriptor, parseYarnLock } from "../src/lock/yarn.js";
import { parseBunLock } from "../src/lock/bun.js";
import { parseDenoKey, parseDenoLock } from "../src/lock/deno.js";
import {
  BUN_V1,
  DENO_V1,
  DENO_V3,
  DENO_V4,
  NPM_V1,
  NPM_V3,
  PNPM_V5,
  PNPM_V6,
  PNPM_V9,
  YARN_BERRY,
  YARN_CLASSIC,
} from "./fixtures.js";

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

describe("bun lockfiles", () => {
  const lock = parseBunLock(BUN_V1);

  it("reads a JSONC file with comments and trailing commas", () => {
    expect(lock.kind).toBe("bun");
    expect(lock.lockfileVersion).toBe("1");
  });

  it("skips workspace members and linked directories", () => {
    expect(lock.packages.has("lib")).toBe(false);
    expect(lock.packages.has("linked")).toBe(false);
  });

  it("names the package from the tuple, not the key", () => {
    // The key is an install alias; the tuple carries the real package.
    expect(lock.packages.has("aliased")).toBe(false);
    expect(versionsOf(lock, "is-even")).toEqual(["1.0.0"]);
  });

  it("treats a nested key as a path, not part of the name", () => {
    expect(lock.packages.has("express/ms")).toBe(false);
    expect(versionsOf(lock, "ms")).toEqual(["2.0.0", "2.1.3"]);
    expect(lock.packages.get("ms")?.[0]?.path).toBe("express/ms");
  });

  it("finds the integrity hash whatever the tuple arity is", () => {
    // Registry entries carry it fourth, git entries fourth after an object,
    // and tarball entries third.
    expect(lock.packages.get("chalk")?.[0]?.integrity).toBe("sha512-chalk");
    expect(lock.packages.get("is-number")?.[0]?.integrity).toBe("sha512-isnumber");
    expect(lock.packages.get("is-odd")?.[0]?.integrity).toBe("sha512-isodd3");
  });

  it("never mistakes a folder name for the registry", () => {
    // The git tuple's third element is a directory, not a registry URL.
    expect(lock.packages.get("is-number")?.[0]?.resolved).not.toContain("jonschlinkert-is-number");
  });

  it("spells out the git shorthand so the source rule can read it", () => {
    expect(lock.packages.get("is-number")?.[0]?.resolved).toBe(
      "git+https://github.com/jonschlinkert/is-number#0c6b15a",
    );
  });

  it("keeps a tarball and a private registry as their own URLs", () => {
    expect(lock.packages.get("is-odd")?.[0]?.resolved).toBe(
      "https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz",
    );
    expect(lock.packages.get("internal")?.[0]?.resolved).toBe("https://npm.corp.example.com/");
  });

  it("leaves the default registry unresolved rather than assuming npmjs.org", () => {
    // Bun writes "" for whatever registry the install was configured with,
    // which is not necessarily the public one.
    expect(lock.packages.get("chalk")?.[0]?.resolved).toBeUndefined();
  });

  it("says nothing about install scripts, which bun.lock does not record", () => {
    // esbuild really does have a postinstall; the lockfile cannot show it, so
    // reporting `false` here would read as "checked, and it is clean".
    expect(lock.packages.get("esbuild")?.[0]?.hasInstallScript).toBeUndefined();
    expect(lock.packages.get("chalk")?.[0]?.dev).toBeUndefined();
  });

  it("counts every entry, duplicates included", () => {
    expect(lock.entryCount).toBe(8);
  });

  it("rejects a file it cannot parse", () => {
    expect(() => parseBunLock("{ not json")).toThrow(LockParseError);
    expect(() => parseBunLock("[]")).toThrow(/did not contain an object/);
  });

  it("does not cut the file short at a // inside a base64 hash", () => {
    const tricky = `{ "lockfileVersion": 1, "workspaces": {}, "packages": {
      "a": ["a@1.0.0", "", {}, "sha512-ab//cd=="],
      "b": ["b@2.0.0", "", {}, "sha512-ef"],
    } }`;
    const parsed = parseBunLock(tricky);
    expect(parsed.packages.get("a")?.[0]?.integrity).toBe("sha512-ab//cd==");
    expect(parsed.packages.has("b")).toBe(true);
  });
});

describe("deno lockfiles", () => {
  const lock = parseDenoLock(DENO_V4);

  it("reads lockfile version 4", () => {
    expect(lock.kind).toBe("deno");
    expect(lock.lockfileVersion).toBe("4");
  });

  it("reads the npm section", () => {
    expect(versionsOf(lock, "chalk")).toEqual(["5.3.0"]);
    expect(lock.packages.get("chalk")?.[0]?.integrity).toBe("sha512-chalk");
  });

  it("drops the resolved peer suffix from an npm key", () => {
    // vite@5.4.0_@types+node@22.5.0 is one install of one version, not a
    // version a reviewer would ever type.
    expect(versionsOf(lock, "vite")).toEqual(["5.4.0"]);
  });

  it("keeps jsr packages under the prefix Deno itself uses", () => {
    expect(versionsOf(lock, "jsr:@std/assert")).toEqual(["1.0.13"]);
    expect(lock.packages.has("@std/assert")).toBe(false);
  });

  it("skips remote URL imports, which carry no version", () => {
    expect([...lock.packages.keys()].some((name) => name.startsWith("https://"))).toBe(false);
    expect(lock.entryCount).toBe(5);
  });

  it("says nothing about install scripts, licences or the dev split", () => {
    const esbuild = lock.packages.get("esbuild")?.[0];
    expect(esbuild?.hasInstallScript).toBeUndefined();
    expect(esbuild?.license).toBeUndefined();
    expect(esbuild?.dev).toBeUndefined();
  });

  it("never assumes a registry deno.lock does not record", () => {
    expect(lock.packages.get("chalk")?.[0]?.resolved).toBeUndefined();
  });

  it("finds both sections when v3 nests them under packages", () => {
    const v3 = parseDenoLock(DENO_V3);
    expect(v3.lockfileVersion).toBe("3");
    expect(versionsOf(v3, "chalk")).toEqual(["5.4.0"]);
    expect(versionsOf(v3, "jsr:@std/assert")).toEqual(["1.0.13"]);
  });

  it("refuses a v1 file instead of reporting its hashes as no changes", () => {
    expect(() => parseDenoLock(DENO_V1)).toThrow(/no versions to compare/);
  });

  it("rejects a file it cannot parse", () => {
    expect(() => parseDenoLock("{ not json")).toThrow(LockParseError);
    expect(() => parseDenoLock("[]")).toThrow(/did not contain an object/);
  });

  it.each([
    ["chalk@5.3.0", "chalk", "5.3.0"],
    ["@std/assert@1.0.13", "@std/assert", "1.0.13"],
    ["vite@5.4.0_@types+node@22.5.0", "vite", "5.4.0"],
    ["some_pkg@1.2.3", "some_pkg", "1.2.3"],
  ])("splits the key %s", (key, name, version) => {
    expect(parseDenoKey(key)).toEqual({ name, version });
  });

  it.each(["chalk", "", "@scope/name"])("refuses the unversioned key %s", (key) => {
    expect(parseDenoKey(key)).toBeUndefined();
  });
});

describe("format detection", () => {
  it.each([
    [NPM_V3, "npm"],
    [PNPM_V9, "pnpm"],
    [YARN_BERRY, "yarn"],
    [YARN_CLASSIC, "yarn"],
    [BUN_V1, "bun"],
    [DENO_V4, "deno"],
    [DENO_V3, "deno"],
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
