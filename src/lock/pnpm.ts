import { parse as parseYaml } from "yaml";

import { indexPackages, LockParseError, type Lockfile, type LockPackage } from "./types.js";

interface PnpmEntry {
  resolution?: { integrity?: string; tarball?: string; directory?: string; type?: string };
  requiresBuild?: boolean;
  dev?: boolean;
  optional?: boolean;
  deprecated?: string;
}

interface PnpmDocument {
  lockfileVersion?: string | number;
  packages?: Record<string, PnpmEntry>;
}

/** Parse `pnpm-lock.yaml`, lockfileVersion 5 through 9. */
export function parsePnpmLock(text: string): Lockfile {
  let doc: PnpmDocument;
  try {
    doc = parseYaml(text) as PnpmDocument;
  } catch (error) {
    throw new LockParseError(`pnpm-lock.yaml is not valid YAML: ${(error as Error).message}`);
  }
  if (doc === null || typeof doc !== "object") {
    throw new LockParseError("pnpm-lock.yaml did not contain an object.");
  }

  const version = doc.lockfileVersion === undefined ? "unknown" : String(doc.lockfileVersion);
  const list: LockPackage[] = [];

  for (const [key, entry] of Object.entries(doc.packages ?? {})) {
    const parsed = parsePnpmKey(key);
    if (!parsed) continue;

    const resolution = entry?.resolution;
    // `directory` resolutions are workspace links, not installed packages.
    if (resolution?.directory !== undefined || resolution?.type === "directory") continue;

    list.push({
      name: parsed.name,
      version: parsed.version,
      resolved: resolution?.tarball,
      integrity: resolution?.integrity,
      dev: entry?.dev,
      optional: entry?.optional,
      // pnpm 5/6 record this directly; pnpm 9 dropped it, so it stays unknown
      // there rather than being guessed at.
      hasInstallScript: entry?.requiresBuild === true ? true : undefined,
      deprecated: typeof entry?.deprecated === "string" ? entry.deprecated : undefined,
      path: key,
    });
  }

  return {
    kind: "pnpm",
    lockfileVersion: version,
    packages: indexPackages(list),
    entryCount: list.length,
  };
}

const V6_KEY = /^(@[^/]+\/[^/@]+|[^/@][^/@]*)@(.+)$/;
const V5_KEY = /^(@[^/]+\/[^/]+|[^/]+)\/(.+)$/;

/**
 * pnpm has used three key shapes across lockfile versions:
 *
 *   v9  `@babel/code-frame@7.24.7`
 *   v6  `/@babel/code-frame@7.24.7`
 *   v5  `/@babel/code-frame/7.24.7_react@16.13.1`
 *
 * plus peer-dependency suffixes in `(...)` (v6/v9) or after `_` (v5).
 */
export function parsePnpmKey(rawKey: string): { name: string; version: string } | undefined {
  if (rawKey.includes("://")) return undefined;

  let key = rawKey.startsWith("/") ? rawKey.slice(1) : rawKey;
  const peerStart = key.indexOf("(");
  if (peerStart !== -1) key = key.slice(0, peerStart);
  if (key.length === 0) return undefined;

  const match = V6_KEY.exec(key) ?? V5_KEY.exec(key);
  if (!match) return undefined;

  const name = match[1];
  const rawVersion = match[2];
  if (name === undefined || rawVersion === undefined) return undefined;

  // v5 appended a peer hash to the version with an underscore; semver never
  // contains one, so cutting there is safe.
  const underscore = rawVersion.indexOf("_");
  const version = underscore === -1 ? rawVersion : rawVersion.slice(0, underscore);

  return version.length > 0 ? { name, version } : undefined;
}
