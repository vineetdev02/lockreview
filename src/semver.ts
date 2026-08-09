/**
 * Just enough semver for a diff: compare two versions and say what kind of
 * jump happened. Deliberately dependency-free — lockdiff never needs range
 * matching, only ordering and classification.
 */

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseVersion(version: string): ParsedVersion | undefined {
  const match = SEMVER.exec(version.trim());
  if (!match) return undefined;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

/** Semver ordering. Unparseable versions sort after parseable ones, then lexically. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);

  if (!left || !right) {
    if (left) return -1;
    if (right) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;

  return comparePrerelease(left.prerelease, right.prerelease);
}

function comparePrerelease(a: string[], b: string[]): number {
  // 1.0.0 (no prerelease) outranks 1.0.0-rc.1.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;

    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const difference = Number(left) - Number(right);
      if (difference !== 0) return difference < 0 ? -1 : 1;
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (left !== right) return left < right ? -1 : 1;
  }

  return 0;
}

export type BumpKind = "major" | "minor" | "patch" | "prerelease" | "downgrade" | "other";

/** Classify a version move. `other` covers git URLs, `file:` specs and the like. */
export function classifyBump(from: string, to: string): BumpKind {
  if (from === to) return "other";

  const before = parseVersion(from);
  const after = parseVersion(to);
  if (!before || !after) return "other";

  if (compareVersions(from, to) > 0) return "downgrade";

  if (before.major !== after.major) return "major";
  if (before.minor !== after.minor) return "minor";
  if (before.patch !== after.patch) return "patch";
  return "prerelease";
}

/** 0.x releases break on minor bumps; treat those as breaking too. */
export function isBreaking(from: string, to: string, bump: BumpKind): boolean {
  if (bump === "major") return true;
  if (bump !== "minor") return false;

  const before = parseVersion(from);
  const after = parseVersion(to);
  return before?.major === 0 && after?.major === 0;
}
