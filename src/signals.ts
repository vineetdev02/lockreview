import type { LockfileDiff, PackageChange } from "./diff.js";
import {
  infoFor,
  previousInfoFor,
  previousVulnsFor,
  vulnsFor,
  vulnsKnownFor,
  type Enrichment,
} from "./enrich/index.js";
import type { VersionInfo } from "./enrich/registry.js";
import type { VulnInfo } from "./enrich/osv.js";
import type { LockPackage } from "./lock/types.js";

export type SignalLevel = "high" | "warn" | "info";

/**
 * Every rule this tool can raise. `--ignore` validates against this list, so a
 * misspelled rule fails loudly instead of silently muting nothing — and typing
 * `rule` as a union means a new rule cannot be added without appearing here.
 */
export const RULE_IDS = [
  "deprecated",
  "downgrade",
  "duplicates",
  "install-script",
  "integrity",
  "license",
  "maintainer",
  "source",
  "vulnerability",
  "vulnerability-fixed",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export function isRuleId(value: string): value is RuleId {
  return (RULE_IDS as readonly string[]).includes(value);
}

export interface Signal {
  level: SignalLevel;
  /** Stable identifier, so `--check` and downstream tooling can filter on it. */
  rule: RuleId;
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
  /**
   * Packages published for some platforms only, left out of all three numbers
   * above: a lockfile lists every platform's binary and an install fetches
   * one, so counting them made adding esbuild read as +224 MB.
   */
  platformSpecific: number;
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
export function summarize(diff: LockfileDiff, enrichment: Enrichment): DiffSummary {
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
    // A fix is a claim that the new version is clean of something, so it needs
    // OSV to have answered for the new version. A batch that failed would
    // otherwise read as "no advisories" and announce a fix nobody checked.
    if (vulnsKnownFor(enrichment, change)) {
      reportFixedVulnerabilities(change, notIn(before, after), signals);
    }
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
      // No backticks: details are escaped as somebody else's text in the
      // comment, so markup in our own wording would print as characters.
      detail: "Code from this package executes on every npm install, including in CI.",
    });
  }

  // pnpm writes the notice into the lockfile at install time, so an offline
  // run still knows it — the same fallback the licence takes below.
  const deprecated = info?.deprecated ?? entry?.deprecated;
  if (deprecated) {
    signals.push({
      level: "warn",
      rule: "deprecated",
      package: `${change.name}@${change.to ?? ""}`,
      title: "newly added but deprecated",
      detail: deprecated,
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
  if (oldHost && newHost && sameRegistry(oldHost) !== sameRegistry(newHost)) {
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

  const deprecated = info?.deprecated ?? newEntry?.deprecated;
  if (deprecated && !(before?.deprecated ?? oldEntry?.deprecated)) {
    signals.push({
      level: "warn",
      rule: "deprecated",
      package: label,
      title: "the new version is deprecated",
      detail: deprecated,
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

function computeSizeDelta(diff: LockfileDiff, enrichment: Enrichment): SizeDelta | undefined {
  if (!enrichment.online || enrichment.truncated) return undefined;

  let bytes = 0;
  let known = 0;
  let total = 0;
  let platformSpecific = 0;

  const platformOnly = (change: PackageChange): boolean => {
    const only =
      infoFor(enrichment, change)?.platformSpecific === true ||
      previousInfoFor(enrichment, change)?.platformSpecific === true;
    if (only) platformSpecific += 1;
    return only;
  };

  for (const change of diff.added) {
    if (platformOnly(change)) continue;
    total += 1;
    const size = infoFor(enrichment, change)?.unpackedSize;
    if (size === undefined) continue;
    known += 1;
    bytes += size;
  }

  for (const change of diff.removed) {
    if (platformOnly(change)) continue;
    total += 1;
    const size = previousInfoFor(enrichment, change)?.unpackedSize;
    if (size === undefined) continue;
    known += 1;
    bytes -= size;
  }

  for (const change of diff.changed) {
    if (platformOnly(change)) continue;
    total += 1;
    const after = infoFor(enrichment, change)?.unpackedSize;
    const before = previousInfoFor(enrichment, change)?.unpackedSize;
    if (after === undefined || before === undefined) continue;
    known += 1;
    bytes += after - before;
  }

  if (total === 0 || known / total < MIN_SIZE_COVERAGE) return undefined;
  return { bytes, known, total, platformSpecific };
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

/**
 * One registry under two names. Yarn Classic writes registry.yarnpkg.com, which
 * serves the npm registry, and a yarn.lock routinely holds both spellings — a
 * contributor with a different registry setting is enough. Moving between them
 * changes nothing about where the code comes from, and as a high-level finding
 * it failed every --check it appeared in.
 */
const REGISTRY_ALIASES: Record<string, string> = { "registry.yarnpkg.com": "registry.npmjs.org" };

function sameRegistry(host: string): string {
  return REGISTRY_ALIASES[host] ?? host;
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
export interface GateResult {
  /** Signals at or above the threshold that `--ignore` did not exempt. */
  blocking: Signal[];
  /** Signals that would have blocked, held back by `--ignore`. */
  suppressed: Signal[];
}

/**
 * What `--check` acts on. Ignoring is deliberately whole-rule rather than
 * per-package: a team that has decided install scripts are acceptable has made
 * one decision, and re-listing every package that has one is how an allowlist
 * rots into a rubber stamp.
 */
export function gate(
  signals: readonly Signal[],
  threshold: SignalLevel,
  ignored: ReadonlySet<RuleId>,
): GateResult {
  const limit = LEVEL_ORDER[threshold];
  const blocking: Signal[] = [];
  const suppressed: Signal[] = [];

  for (const signal of signals) {
    if (LEVEL_ORDER[signal.level] > limit) continue;
    if (ignored.has(signal.rule)) suppressed.push(signal);
    else blocking.push(signal);
  }

  return { blocking, suppressed };
}

export function worstLevel(signals: readonly Signal[]): SignalLevel | undefined {
  if (signals.some((signal) => signal.level === "high")) return "high";
  if (signals.some((signal) => signal.level === "warn")) return "warn";
  if (signals.some((signal) => signal.level === "info")) return "info";
  return undefined;
}
