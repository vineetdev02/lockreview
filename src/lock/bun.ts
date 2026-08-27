import { indexPackages, LockParseError, type Lockfile, type LockPackage } from "./types.js";
import { nameFromDescriptor } from "./yarn.js";

/**
 * Parse `bun.lock` — Bun's text lockfile (lockfileVersion 0 and 1).
 *
 * Every package is a tuple whose *arity and element types vary by source*,
 * which is the one trap in this format:
 *
 *   registry   ["is-odd@0.1.2", "", { dependencies }, "sha512-…"]
 *   git        ["is-number@github:owner/repo#sha", {}, "owner-repo-sha", "sha512-…"]
 *   tarball    ["is-odd@https://…/is-odd-3.0.1.tgz", { dependencies }, "sha512-…"]
 *   workspace  ["lib@workspace:packages/lib"]
 *
 * So elements are identified by their type and shape, never by their index.
 */
export function parseBunLock(text: string): Lockfile {
  const doc = parseJsonc(text);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new LockParseError("bun.lock did not contain an object.");
  }

  const { lockfileVersion, packages } = doc as { lockfileVersion?: unknown; packages?: unknown };
  const version = typeof lockfileVersion === "number" ? String(lockfileVersion) : "unknown";

  const list: LockPackage[] = [];
  if (packages && typeof packages === "object" && !Array.isArray(packages)) {
    for (const [path, raw] of Object.entries(packages as Record<string, unknown>)) {
      const pkg = toPackage(path, raw);
      if (pkg) list.push(pkg);
    }
  }

  return {
    kind: "bun",
    lockfileVersion: version,
    packages: indexPackages(list),
    entryCount: list.length,
  };
}

function toPackage(path: string, raw: unknown): LockPackage | undefined {
  if (!Array.isArray(raw)) return undefined;

  // The key is a tree path (`express/debug`) or an install alias (`aliased`),
  // so it is not the package name. Only the tuple's spec is authoritative.
  const spec = raw[0];
  if (typeof spec !== "string") return undefined;

  const name = nameFromDescriptor(spec);
  if (!name) return undefined;
  const selector = spec.length > name.length ? spec.slice(name.length + 1) : "";
  if (selector === "") return undefined;

  // Workspace members and linked directories are local code, not installed
  // dependencies — the same call npm.ts makes for `link: true` entries.
  if (selector.startsWith("workspace:") || selector.startsWith("link:")) return undefined;

  return {
    name,
    version: selector,
    resolved: resolvedFrom(selector, registryOf(raw)),
    integrity: integrityOf(raw),
    path,
    // Bun records neither install scripts nor the dev/prod split, so both stay
    // undefined rather than being inferred. `hasInstallScript` is still
    // answered online by the registry lookup; an offline run simply says
    // nothing instead of reporting a package as script-free.
  };
}

/**
 * The registry element is the only *string* that can sit at index 1 — the git
 * and tarball forms put an object there — and it is never an integrity hash.
 */
function registryOf(tuple: readonly unknown[]): string | undefined {
  const candidate = tuple[1];
  if (typeof candidate !== "string" || candidate === "" || isIntegrity(candidate)) return undefined;
  return candidate;
}

function integrityOf(tuple: readonly unknown[]): string | undefined {
  for (let index = tuple.length - 1; index >= 1; index -= 1) {
    const value = tuple[index];
    if (typeof value === "string" && isIntegrity(value)) return value;
  }
  return undefined;
}

function isIntegrity(value: string): boolean {
  return /^sha\d+-/.test(value);
}

/**
 * What the package was actually fetched from, in the shape the risk rules
 * expect: a URL they can read a host out of.
 *
 * An empty registry element means "whatever registry this install was
 * configured with" — which is not necessarily npmjs.org, since Bun writes it
 * empty for a mirrored install too. Inventing a URL there would manufacture a
 * source change out of a configuration lockreview cannot see, so it stays
 * undefined and the source rules simply do not fire.
 */
function resolvedFrom(selector: string, registry: string | undefined): string | undefined {
  if (/^(https?|git\+[a-z]+|git):/.test(selector)) return selector;

  // Bun's `github:owner/repo#ref` shorthand is a git source; spelling it out
  // is what lets the existing "installed straight from a git repository" rule
  // recognise it, rather than teaching that rule a Bun-specific prefix.
  const shorthand = /^(github|gitlab|bitbucket):(.+)$/.exec(selector);
  if (shorthand) {
    const host = { github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org" }[
      shorthand[1] as "github" | "gitlab" | "bitbucket"
    ];
    return `git+https://${host}/${shorthand[2] as string}`;
  }

  return registry;
}

/**
 * bun.lock is JSONC: Bun writes trailing commas, and a hand-edited file may
 * carry comments. Both are stripped with a string-aware scan — integrity
 * values are base64 and routinely contain `//`, which a naive comment stripper
 * would cut the rest of the file off at.
 */
function parseJsonc(text: string): unknown {
  const source = stripTrailingCommas(stripComments(text));
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new LockParseError(`bun.lock is not valid JSONC: ${(error as Error).message}`);
  }
}

function stripComments(text: string): string {
  let out = "";
  let index = 0;

  while (index < text.length) {
    const char = text[index] as string;

    if (char === '"') {
      const end = endOfString(text, index);
      out += text.slice(index, end);
      index = end;
      continue;
    }

    if (char === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      continue;
    }

    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

function stripTrailingCommas(text: string): string {
  let out = "";
  let index = 0;

  while (index < text.length) {
    const char = text[index] as string;

    if (char === '"') {
      const end = endOfString(text, index);
      out += text.slice(index, end);
      index = end;
      continue;
    }

    if (char === ",") {
      let ahead = index + 1;
      while (ahead < text.length && /\s/.test(text[ahead] as string)) ahead += 1;
      const next = text[ahead];
      if (next === "}" || next === "]") {
        index += 1; // Drop the comma, keep the whitespace that follows it.
        continue;
      }
    }

    out += char;
    index += 1;
  }

  return out;
}

/** Index just past the closing quote of the string starting at `start`. */
function endOfString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"') return index + 1;
    index += 1;
  }
  return text.length;
}
