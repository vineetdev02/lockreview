import type { LockDiff, PackageChange } from "./diff.js";
import {
  infoFor,
  previousInfoFor,
  previousVulnsFor,
  vulnsFor,
  type Enrichment,
} from "./enrich/index.js";
import type { VersionInfo } from "./enrich/registry.js";
import type { VulnInfo } from "./enrich/osv.js";
import type { LockPackage } from "./lock/types.js";

export type SignalLevel = "high" | "warn" | "info";

export interface Signal {
  level: SignalLevel;
  /** Stable identifier, so `--check` and downstream tooling can filter on it. */
  rule: string;
  package: string;
  /** One line, written for someone skimming a pull request. */
  title: string;
  detail?: string;
  /**
   * Signals sharing a group key describe the same underlying event across many
   * packages, and are collapsed into one line once there are enough of them.
   */
  group?: string;
  /** Wording to use once the group is collapsed, when the per-package title
   * would no longer be accurate for the whole set. */
  groupTitle?: string;
  /** How many packages this line stands for, after collapsing. */
  count?: number;
}

export interface SizeDelta {
  bytes: number;
  /** How many of the packages involved had a known unpacked size. */
  known: number;
  total: number;
}

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  major: number;
  minor: number;
  patch: number;
  downgrades: number;
  entriesBefore: number;
  entriesAfter: number;
  size?: SizeDelta;
  signals: Signal[];
}

const LEVEL_ORDER: Record<SignalLevel, number> = { high: 0, warn: 1, info: 2 };

/** Licenses worth surfacing when a dependency arrives carrying one. */
const RESTRICTIVE_LICENSE = /^(AGPL|SSPL|BUSL|BSL|CC-BY-NC|Commons-Clause|Elastic|RSAL|Parity)/i;

/** Summarise a diff and run every risk rule that has the data it needs. */
export function summarize(diff: LockDiff, enrichment: Enrichment): DiffSummary {
  const signals: Signal[] = [];

  for (const change of diff.added) {
    reportVulnerabilities(change, vulnsFor(enrichment, change), signals);
    collectAddedPackageSignals(change, enrichment, signals);
  }

  for (const change of diff.changed) {
    const before = previousVulnsFor(enrichment, change);
    const after = vulnsFor(enrichment, change);
    // Only what this change does: advisories it introduces, and ones it fixes.
    // Pre-existing advisories on both sides are not this pull request's news.
    reportVulnerabilities(change, notIn(after, before), signals);
    reportFixedVulnerabilities(change, notIn(before, after), signals);
    collectChangedPackageSignals(change, enrichment, signals);
  }

  for (const change of diff.removed) {
    reportFixedVulnerabilities(change, previousVulnsFor(enrichment, change), signals);
  }

  const collapsed = collapseBulkSignals(signals);
  collapsed.sort(
    (a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.package.localeCompare(b.package),
  );

  return {
    added: diff.added.length,
    removed: diff.removed.length,
    changed: diff.changed.length,
    major: diff.changed.filter((change) => change.bump === "major").length,
    minor: diff.changed.filter((change) => change.bump === "minor").length,
    patch: diff.changed.filter((change) => change.bump === "patch").length,
    downgrades: diff.changed.filter((change) => change.bump === "downgrade").length,
    entriesBefore: diff.before.entryCount,
    entriesAfter: diff.after.entryCount,
    size: computeSizeDelta(diff, enrichment),
    signals: collapsed,
  };
}

/** Threshold above which a repeated finding is reported once, with a count. */
const COLLAPSE_AFTER = 3;

/**
 * A registry migration changes the source of every package at once. Reporting
 * that four hundred times buries the three findings that matter, so repeated
 * group members become a single counted line.
 */
function collapseBulkSignals(signals: readonly Signal[]): Signal[] {
  const groups = new Map<string, Signal[]>();
  for (const signal of signals) {
    if (!signal.group) continue;
    const bucket = groups.get(signal.group);
    if (bucket) bucket.push(signal);
    else groups.set(signal.group, [signal]);
  }

  const collapsedGroups = new Set(
    [...groups].filter(([, members]) => members.length > COLLAPSE_AFTER).map(([key]) => key),
  );
  if (collapsedGroups.size === 0) return [...signals];

  const result: Signal[] = [];
  const emitted = new Set<string>();

  for (const signal of signals) {
    if (!signal.group || !collapsedGroups.has(signal.group)) {
      result.push(signal);
      continue;
    }
    if (emitted.has(signal.group)) continue;
    emitted.add(signal.group);

    const members = groups.get(signal.group) ?? [];
    const names = members.map((member) => member.package);
    result.push({
      ...signal,
      package: `${members.length} packages`,
      title: signal.groupTitle ?? signal.title,
      count: members.length,
      detail: `${names.slice(0, 4).join(", ")}${names.length > 4 ? `, +${names.length - 4} more` : ""}`,
    });
  }

  return result;
}

function reportVulnerabilities(
  change: PackageChange,
  vulns: readonly VulnInfo[],
  signals: Signal[],
): void {
  const worst = vulns[0];
  if (!worst) return;

  const level: SignalLevel =
    worst.severity === "critical" || worst.severity === "high" ? "high" : "warn";
  const rest = vulns.length > 1 ? ` (+${vulns.length - 1} more)` : "";

  signals.push({
    level,
    rule: "vulnerability",
    package: `${change.name}@${change.to ?? ""}`,
    title: `${worst.severity === "unknown" ? "known" : worst.severity} severity advisory${rest}`,
    detail: worst.summary ? `${worst.summary} — ${worst.url}` : worst.url,
  });
}

function reportFixedVulnerabilities(
  change: PackageChange,
  vulns: readonly VulnInfo[],
  signals: Signal[],
): void {
  if (vulns.length === 0) return;

  const label = change.kind === "removed" ? `${change.name} (removed)` : change.name;
  signals.push({
    level: "info",
    rule: "vulnerability-fixed",
    package: label,
    title: `no longer affected by ${vulns.length} ${vulns.length === 1 ? "advisory" : "advisories"}`,
    detail: vulns.map((vuln) => vuln.id).join(", "),
    group: "vulnerability-fixed",
    groupTitle: "no longer affected by known advisories",
  });
}

function notIn(candidates: readonly VulnInfo[], others: readonly VulnInfo[]): VulnInfo[] {
  const known = new Set(others.map((vuln) => vuln.id));
  return candidates.filter((vuln) => !known.has(vuln.id));
}

function collectAddedPackageSignals(
  change: PackageChange,
  enrichment: Enrichment,
  signals: Signal[],
): void {
  const info = infoFor(enrichment, change);
  const entry = entryAt(change.after, change.to);
  const scripts = installScriptsOf(info, entry);

  if (scripts) {
    signals.push({
      level: "warn",
      rule: "install-script",
      package: `${change.name}@${change.to ?? ""}`,
      title:
        scripts.length > 0
          ? `new dependency runs install scripts: ${scripts.join(", ")}`
          : "new dependency runs an install script",
      detail: "Code from this package executes on every `npm install`, including in CI.",
    });
  }

  if (info?.deprecated) {
    signals.push({
      level: "warn",
      rule: "deprecated",
      package: `${change.name}@${change.to ?? ""}`,
      title: "newly added but deprecated",
      detail: info.deprecated,
    });
  }

  const license = info?.license ?? entry?.license;
  if (license && RESTRICTIVE_LICENSE.test(license)) {
    signals.push({
      level: "warn",
      rule: "license",
      package: `${change.name}@${change.to ?? ""}`,
      title: `arrives under ${license}`,
      detail: "Not a permissive licence — worth checking against your distribution terms.",
    });
  }

  const source = unusualSource(entry?.resolved);
  if (source) {
    signals.push({
      level: "warn",
      rule: "source",
      package: `${change.name}@${change.to ?? ""}`,
      title: `installed straight from ${source}, not a package registry`,
      detail: entry?.resolved,
    });
  }
}

function collectChangedPackageSignals(
  change: PackageChange,
  enrichment: Enrichment,
  signals: Signal[],
): void {
  const info = infoFor(enrichment, change);
  const before = previousInfoFor(enrichment, change);
  const newEntry = entryAt(change.after, change.to);
  const oldEntry = entryAt(change.before, change.from);
  const label = `${change.name}@${change.from ?? "?"} → ${change.to ?? "?"}`;

  const ownership = maintainerChange(before, info);
  if (ownership) {
    signals.push({
      level: ownership.level,
      rule: "maintainer",
      package: label,
      title: ownership.title,
      detail: ownership.detail,
      group: ownership.group,
    });
  }

  const newScripts = installScriptsOf(info, newEntry);
  const oldScripts = installScriptsOf(before, oldEntry);
  // Only claim a script is new when the previous version's scripts are
  // actually known; a failed lookup must not read as "there were none".
  const oldScriptsKnown = before !== undefined || oldEntry?.hasInstallScript !== undefined;
  if (newScripts && oldScriptsKnown && !oldScripts) {
    signals.push({
      level: "high",
      rule: "install-script",
      package: label,
      title:
        newScripts.length > 0
          ? `now runs install scripts (${newScripts.join(", ")}) — the previous version did not`
          : "now runs an install script — the previous version did not",
      detail: "This version starts executing code during install.",
    });
  }

  const oldLicense = before?.license ?? oldEntry?.license;
  const newLicense = info?.license ?? newEntry?.license;
  if (oldLicense && newLicense && oldLicense !== newLicense) {
    signals.push({
      level: RESTRICTIVE_LICENSE.test(newLicense) ? "high" : "warn",
      rule: "license",
      package: label,
      title: `licence changed: ${oldLicense} → ${newLicense}`,
      group: `license:${oldLicense}->${newLicense}`,
    });
  }

  const oldHost = hostOf(oldEntry?.resolved);
  const newHost = hostOf(newEntry?.resolved);
  if (oldHost && newHost && oldHost !== newHost) {
    signals.push({
      level: "high",
      rule: "source",
      package: label,
      title: `now downloaded from ${newHost} (was ${oldHost})`,
      detail: newEntry?.resolved,
      group: `source:${oldHost}->${newHost}`,
    });
  }

  if (oldEntry?.integrity && !newEntry?.integrity) {
    signals.push({
      level: "warn",
      rule: "integrity",
      package: label,
      title: "no integrity hash recorded for the new version",
    });
  }

  if (info?.deprecated && !before?.deprecated) {
    signals.push({
      level: "warn",
      rule: "deprecated",
      package: label,
      title: "the new version is deprecated",
      detail: info.deprecated,
    });
  }

  if (change.bump === "downgrade") {
    signals.push({
      level: "warn",
      rule: "downgrade",
      package: label,
      title: "version moved backwards",
      detail: "Often an accidental revert from a stale branch or a resolution conflict.",
    });
  }

  const extraCopies = change.after.length - change.before.length;
  if (extraCopies > 0 && change.after.length > 1) {
    signals.push({
      level: "info",
      rule: "duplicates",
      package: change.name,
      title: `now installed at ${change.after.length} different versions (was ${change.before.length})`,
      detail: change.after.map((pkg) => pkg.version).join(", "),
      group: "duplicates",
      groupTitle: "now installed at more than one version each",
    });
  }
}

interface MaintainerFinding {
  level: SignalLevel;
  title: string;
  detail: string;
  group: string;
}

/**
 * npm freezes the maintainer list and the publishing account into each
 * published version, so comparing two versions of one package shows real
 * ownership movement rather than the account's state today.
 *
 * Only two things here are worth a reviewer's attention: an account that
 * gained the ability to publish, and a release pushed by someone who was not a
 * maintainer before. Accounts *losing* access and releases moving to Trusted
 * Publishing are routine, and reporting them buries the cases that matter.
 */
function maintainerChange(
  before: VersionInfo | undefined,
  after: VersionInfo | undefined,
): MaintainerFinding | undefined {
  if (!before || !after) return undefined;

  const oldOwners = before.maintainers;
  const newOwners = after.maintainers;

  if (oldOwners && newOwners) {
    const gained = newOwners.filter((name) => !oldOwners.includes(name));
    if (gained.length > 0) {
      const who = gained.join(", ");
      return {
        level: "warn",
        title: `${gained.length === 1 ? "a new account" : `${gained.length} new accounts`} can publish this package: ${who}`,
        detail: `Maintainers were ${oldOwners.join(", ")}; now ${newOwners.join(", ")}.`,
        group: `maintainer-gained:${who}`,
      };
    }
  }

  // A CI-signed release is a hardening step, not an ownership change.
  if (after.automated) return undefined;

  const oldPublisher = before.publisher;
  const newPublisher = after.publisher;
  if (!oldPublisher || !newPublisher || oldPublisher === newPublisher) return undefined;

  const wasMaintainer = oldOwners?.includes(newPublisher.toLowerCase()) ?? true;
  if (wasMaintainer) return undefined;

  return {
    level: "high",
    title: `published by ${newPublisher}, who did not maintain the previous version`,
    detail: `Version ${before.version} was published by ${oldPublisher}.`,
    group: `publisher-new:${newPublisher}`,
  };
}

/**
 * Prefer the registry's answer, which names the lifecycle scripts; fall back to
 * the lockfile, which only records that there is one. An empty array therefore
 * means "there is a script but its name is unknown", and undefined means "no
 * script, or no way to tell".
 */
function installScriptsOf(info?: VersionInfo, entry?: LockPackage): string[] | undefined {
  if (info?.installScripts && info.installScripts.length > 0) return info.installScripts;
  if (info) return undefined; // The registry answered, and said there are none.
  return entry?.hasInstallScript ? [] : undefined;
}

/**
 * A few packages predate npm recording unpacked sizes, so a small gap is fine
 * and gets reported alongside the total. A *truncated* run is different: it
 * stops in priority order, measuring additions while skipping removals, which
 * would inflate the number in one direction. An unstated total beats a wrong
 * one, so that case reports nothing at all.
 */
const MIN_SIZE_COVERAGE = 0.5;

function computeSizeDelta(diff: LockDiff, enrichment: Enrichment): SizeDelta | undefined {
  if (!enrichment.online || enrichment.truncated) return undefined;

  let bytes = 0;
  let known = 0;
  let total = 0;

  for (const change of diff.added) {
    total += 1;
    const size = infoFor(enrichment, change)?.unpackedSize;
    if (size === undefined) continue;
    known += 1;
    bytes += size;
  }

  for (const change of diff.removed) {
    total += 1;
    const size = previousInfoFor(enrichment, change)?.unpackedSize;
    if (size === undefined) continue;
    known += 1;
    bytes -= size;
  }

  for (const change of diff.changed) {
    total += 1;
    const after = infoFor(enrichment, change)?.unpackedSize;
    const before = previousInfoFor(enrichment, change)?.unpackedSize;
    if (after === undefined || before === undefined) continue;
    known += 1;
    bytes += after - before;
  }

  if (total === 0 || known / total < MIN_SIZE_COVERAGE) return undefined;
  return { bytes, known, total };
}

function entryAt(packages: LockPackage[], version?: string): LockPackage | undefined {
  if (version === undefined) return undefined;
  return packages.find((pkg) => pkg.version === version);
}

function hostOf(resolved?: string): string | undefined {
  if (!resolved) return undefined;
  try {
    return new URL(resolved).host;
  } catch {
    return undefined;
  }
}

const CODE_HOSTS = new Set([
  "github.com",
  "codeload.github.com",
  "gitlab.com",
  "bitbucket.org",
  "git.sr.ht",
]);

/**
 * Flag only genuinely unusual sources — a git repository or a code host.
 *
 * Private registries (Artifactory, Nexus, Verdaccio, GitHub Packages) are
 * normal and are deliberately not flagged: a rule that fires on every package
 * in a mirrored install teaches people to ignore the tool.
 */
function unusualSource(resolved?: string): string | undefined {
  if (!resolved) return undefined;
  if (/^git(\+|:)/.test(resolved)) return "a git repository";

  const host = hostOf(resolved);
  return host && CODE_HOSTS.has(host) ? host : undefined;
}

/** Highest severity present, for `--check` and for the one-line verdict. */
export function worstLevel(signals: readonly Signal[]): SignalLevel | undefined {
  if (signals.some((signal) => signal.level === "high")) return "high";
  if (signals.some((signal) => signal.level === "warn")) return "warn";
  if (signals.some((signal) => signal.level === "info")) return "info";
  return undefined;
}
