import { parse as parseYaml } from "yaml";

import { indexPackages, LockParseError, type Lockfile, type LockPackage } from "./types.js";

/** Parse `yarn.lock` — Berry (v2+) is YAML, Yarn Classic (v1) is its own format. */
export function parseYarnLock(text: string): Lockfile {
  return text.includes("__metadata:") ? parseBerry(text) : parseClassic(text);
}

interface BerryEntry {
  version?: string;
  resolution?: string;
  checksum?: string;
  linkType?: string;
}

function parseBerry(text: string): Lockfile {
  let doc: Record<string, BerryEntry>;
  try {
    doc = parseYaml(text) as Record<string, BerryEntry>;
  } catch (error) {
    throw new LockParseError(`yarn.lock is not valid YAML: ${(error as Error).message}`);
  }
  if (doc === null || typeof doc !== "object") {
    throw new LockParseError("yarn.lock did not contain an object.");
  }

  const metadata = doc["__metadata"] as { version?: string | number } | undefined;
  const list: LockPackage[] = [];

  for (const [key, entry] of Object.entries(doc)) {
    if (key === "__metadata" || !entry || typeof entry !== "object") continue;
    if (typeof entry.version !== "string") continue;
    // Workspace members resolve to themselves and carry a placeholder version.
    if (entry.resolution?.includes("@workspace:")) continue;
    if (entry.version === "0.0.0-use.local") continue;

    const name = nameFromDescriptor(firstDescriptor(key));
    if (!name) continue;

    list.push({
      name,
      version: entry.version,
      integrity: entry.checksum,
      resolved: entry.resolution,
      path: key,
    });
  }

  return {
    kind: "yarn-berry",
    lockfileVersion: metadata?.version === undefined ? "unknown" : String(metadata.version),
    packages: indexPackages(list),
    entryCount: list.length,
  };
}

/**
 * Yarn Classic entries look like:
 *
 *   "@babel/code-frame@^7.0.0", "@babel/code-frame@^7.10.4":
 *     version "7.24.7"
 *     resolved "https://registry.yarnpkg.com/..."
 *     integrity sha512-...
 */
function parseClassic(text: string): Lockfile {
  const list: LockPackage[] = [];
  let pendingName: string | undefined;
  let current: LockPackage | undefined;

  const flush = (): void => {
    if (current && current.version) list.push(current);
    current = undefined;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim().length === 0 || rawLine.trimStart().startsWith("#")) continue;

    const isHeader = !/^\s/.test(rawLine);
    if (isHeader) {
      flush();
      const header = rawLine.replace(/:\s*$/, "");
      pendingName = nameFromDescriptor(firstDescriptor(header));
      if (pendingName) current = { name: pendingName, version: "", path: header };
      continue;
    }

    if (!current) continue;
    // Only read the entry's own fields; nested blocks such as `dependencies:`
    // are indented further and are not part of this package's identity.
    const field = /^ {2}(\S+)\s+(.*)$/.exec(rawLine);
    if (!field) continue;

    const key = field[1];
    const value = unquote((field[2] ?? "").trim());
    if (key === "version") current.version = value;
    else if (key === "resolved") current.resolved = value;
    else if (key === "integrity") current.integrity = value;
  }
  flush();

  return {
    kind: "yarn",
    lockfileVersion: "1",
    packages: indexPackages(list),
    entryCount: list.length,
  };
}

/** `"a@^1", "a@^2"` -> `a@^1`. Splits on commas outside of quotes. */
function firstDescriptor(header: string): string {
  const parts = header.split(",");
  return unquote((parts[0] ?? "").trim());
}

/**
 * `@babel/code-frame@npm:^7.0.0` -> `@babel/code-frame`.
 *
 * A package name only ever contains "@" as the leading scope marker, so the
 * first "@" after position 0 always separates name from selector. That holds
 * for plain ranges (`chalk@^5.0.0`), aliases (`ui@npm:@scope/ui@^1.0.0`) and
 * Berry's protocols (`fsevents@patch:fsevents@npm%3A2.3.2#...`) alike — where
 * splitting on the *last* "@" would pick a separator inside the selector.
 */
export function nameFromDescriptor(descriptor: string): string | undefined {
  if (descriptor.length === 0) return undefined;

  const at = descriptor.indexOf("@", 1);
  const name = at > 0 ? descriptor.slice(0, at) : descriptor;

  return name.length > 0 ? name : undefined;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}
