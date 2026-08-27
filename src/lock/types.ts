/** Which package manager wrote the lockfile. */
export type LockKind = "npm" | "pnpm" | "yarn" | "yarn-berry" | "bun";

/**
 * One resolved package in a lockfile, normalised across package managers.
 *
 * Fields beyond `name`/`version` are optional on purpose: every manager records
 * a different subset, and lockreview would rather say nothing than guess. A rule
 * that depends on a field it cannot see is skipped, not faked.
 */
export interface LockPackage {
  name: string;
  version: string;
  /** Tarball or git URL the package came from, when the lockfile records one. */
  resolved?: string;
  integrity?: string;
  /** Reachable only through devDependencies. */
  dev?: boolean;
  optional?: boolean;
  /** Runs preinstall/install/postinstall. npm lockfiles v2+ and pnpm record this. */
  hasInstallScript?: boolean;
  /** SPDX string as recorded in the lockfile (npm v2+ only). */
  license?: string;
  /** Deprecation message, when the lockfile carries one (pnpm). */
  deprecated?: string;
  /** Where in the tree this copy lives, for locating duplicates. */
  path?: string;
}

export interface Lockfile {
  kind: LockKind;
  /** Version as written by the manager, e.g. "3" for npm or "9.0" for pnpm. */
  lockfileVersion: string;
  /** name -> every version of that name present in the tree, sorted. */
  packages: Map<string, LockPackage[]>;
  /** Total resolved package entries, counting duplicate versions separately. */
  entryCount: number;
}

export class LockParseError extends Error {}

/** A lockfile with nothing in it — used when one side of a diff has no file. */
export function emptyLockfile(kind: LockKind): Lockfile {
  return { kind, lockfileVersion: "none", packages: new Map(), entryCount: 0 };
}

/** Index a flat package list by name, keeping versions sorted and deduplicated. */
export function indexPackages(list: LockPackage[]): Map<string, LockPackage[]> {
  const byName = new Map<string, LockPackage[]>();

  for (const pkg of list) {
    if (!pkg.name || !pkg.version) continue;
    const existing = byName.get(pkg.name);
    if (!existing) {
      byName.set(pkg.name, [pkg]);
      continue;
    }
    // The same name+version can appear at several tree paths; keep one copy,
    // preferring the entry that carries the most metadata.
    const duplicate = existing.find((other) => other.version === pkg.version);
    if (duplicate) {
      mergeInto(duplicate, pkg);
      continue;
    }
    existing.push(pkg);
  }

  for (const versions of byName.values()) {
    versions.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  }

  return byName;
}

function mergeInto(target: LockPackage, extra: LockPackage): void {
  target.resolved ??= extra.resolved;
  target.integrity ??= extra.integrity;
  target.license ??= extra.license;
  target.deprecated ??= extra.deprecated;
  target.path ??= extra.path;
  if (target.hasInstallScript === undefined) target.hasInstallScript = extra.hasInstallScript;
  // A package counts as production if any copy of it is reachable from prod.
  if (target.dev && !extra.dev) target.dev = false;
  if (target.optional && !extra.optional) target.optional = false;
}
