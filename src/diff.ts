import type { Lockfile, LockPackage } from "./lock/types.js";
import { classifyBump, compareVersions, isBreaking, type BumpKind } from "./semver.js";

export type ChangeKind = "added" | "removed" | "changed";

export interface PackageChange {
  name: string;
  kind: ChangeKind;
  /** Every version present before the change, sorted ascending. */
  before: LockPackage[];
  /** Every version present after the change, sorted ascending. */
  after: LockPackage[];
  /** Highest version before — the one a reviewer thinks of as "the" version. */
  from?: string;
  /** Highest version after. */
  to?: string;
  bump?: BumpKind;
  breaking: boolean;
  /** True when no copy of this package is reachable outside devDependencies. */
  devOnly: boolean;
}

export interface LockDiff {
  before: Lockfile;
  after: Lockfile;
  added: PackageChange[];
  removed: PackageChange[];
  changed: PackageChange[];
  /** Distinct package names on each side. */
  namesBefore: number;
  namesAfter: number;
}

/** Compare two parsed lockfiles by package name. */
export function diffLockfiles(before: Lockfile, after: Lockfile): LockDiff {
  const added: PackageChange[] = [];
  const removed: PackageChange[] = [];
  const changed: PackageChange[] = [];

  const names = new Set([...before.packages.keys(), ...after.packages.keys()]);

  for (const name of names) {
    const beforeVersions = before.packages.get(name) ?? [];
    const afterVersions = after.packages.get(name) ?? [];

    if (beforeVersions.length === 0) {
      added.push(buildChange(name, "added", beforeVersions, afterVersions));
      continue;
    }
    if (afterVersions.length === 0) {
      removed.push(buildChange(name, "removed", beforeVersions, afterVersions));
      continue;
    }
    if (sameVersionSet(beforeVersions, afterVersions)) continue;

    changed.push(buildChange(name, "changed", beforeVersions, afterVersions));
  }

  added.sort(byName);
  removed.sort(byName);
  changed.sort(bySeverityThenName);

  return {
    before,
    after,
    added,
    removed,
    changed,
    namesBefore: before.packages.size,
    namesAfter: after.packages.size,
  };
}

function buildChange(
  name: string,
  kind: ChangeKind,
  before: LockPackage[],
  after: LockPackage[],
): PackageChange {
  const from = highestVersion(before);
  const to = highestVersion(after);

  let bump: BumpKind | undefined;
  let breaking = false;
  if (kind === "changed" && from !== undefined && to !== undefined && from !== to) {
    bump = classifyBump(from, to);
    breaking = isBreaking(from, to, bump);
  }

  return {
    name,
    kind,
    before,
    after,
    from,
    to,
    bump,
    breaking,
    devOnly: isDevOnly(kind === "removed" ? before : after),
  };
}

function highestVersion(packages: LockPackage[]): string | undefined {
  if (packages.length === 0) return undefined;
  let highest = packages[0]?.version;
  for (const pkg of packages) {
    if (highest === undefined || compareVersions(pkg.version, highest) > 0) highest = pkg.version;
  }
  return highest;
}

/**
 * Dev-only when every copy is marked dev. Lockfiles that do not record the
 * distinction (pnpm 9, yarn) leave `dev` undefined, which reads as "not known
 * to be dev-only" — the safer answer for a reviewer.
 */
function isDevOnly(packages: LockPackage[]): boolean {
  return packages.length > 0 && packages.every((pkg) => pkg.dev === true);
}

function sameVersionSet(a: LockPackage[], b: LockPackage[]): boolean {
  if (a.length !== b.length) return false;
  const versions = new Set(b.map((pkg) => pkg.version));
  return a.every((pkg) => versions.has(pkg.version));
}

const SEVERITY: Record<BumpKind, number> = {
  downgrade: 0,
  major: 1,
  minor: 2,
  patch: 3,
  prerelease: 4,
  other: 5,
};

function byName(a: PackageChange, b: PackageChange): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function bySeverityThenName(a: PackageChange, b: PackageChange): number {
  const left = a.bump ? SEVERITY[a.bump] : SEVERITY.other;
  const right = b.bump ? SEVERITY[b.bump] : SEVERITY.other;
  if (left !== right) return left - right;
  return byName(a, b);
}

/** Every package name touched by the diff — the set worth enriching. */
export function changedNames(diff: LockDiff): PackageChange[] {
  return [...diff.added, ...diff.changed, ...diff.removed];
}
