import type { LockDiff, PackageChange } from "../diff.js";
import type { HttpOptions } from "./http.js";
import { fetchVulnerabilities, type VulnInfo } from "./osv.js";
import { fetchVersionInfo, specKey, type VersionInfo, type VersionSpec } from "./registry.js";

export interface EnrichOptions {
  offline: boolean;
  registry: string;
  timeoutMs: number;
  /** Upper bound on registry lookups, so a huge diff cannot stall a PR check. */
  maxLookups: number;
  userAgent: string;
}

export interface Enrichment {
  versions: Map<string, VersionInfo>;
  vulns: Map<string, VulnInfo[]>;
  /** False when running offline, or when every lookup failed. */
  online: boolean;
  /** True when the diff was larger than the lookup budget. */
  truncated: boolean;
}

export const EMPTY_ENRICHMENT: Enrichment = {
  versions: new Map(),
  vulns: new Map(),
  online: false,
  truncated: false,
};

export const DEFAULT_ENRICH_OPTIONS: Omit<EnrichOptions, "offline" | "userAgent"> = {
  registry: "https://registry.npmjs.org",
  timeoutMs: 20_000,
  // A wholesale "update everything" commit touches a couple of hundred
  // packages and needs two lookups each; the budget is set above that so the
  // ordinary large upgrade still gets a complete answer. The deadline, not
  // this number, is what protects a pathological diff.
  maxLookups: 400,
};

/**
 * Attach registry and advisory data to the packages a diff touches.
 *
 * Everything here is optional: `--offline` skips it, and any request that
 * fails or runs past the deadline simply leaves that fact unknown. Signals
 * that depend on missing data are dropped rather than reported as clean.
 */
export async function enrichDiff(diff: LockDiff, options: EnrichOptions): Promise<Enrichment> {
  if (options.offline) return EMPTY_ENRICHMENT;

  const http: HttpOptions = {
    deadline: Date.now() + options.timeoutMs,
    userAgent: options.userAgent,
  };

  const { current, previous, truncated } = collectSpecs(diff, options.maxLookups);
  if (current.length === 0 && previous.length === 0) return EMPTY_ENRICHMENT;

  // Advisories are queried for both sides: knowing what a bump *fixes* is as
  // useful to a reviewer as knowing what it introduces, and OSV batches 200
  // versions into a single request either way.
  const [versions, vulns] = await Promise.all([
    fetchVersionInfo([...current, ...previous], { ...http, registry: options.registry }),
    fetchVulnerabilities([...current, ...previous], http),
  ]);

  return {
    versions,
    vulns,
    online: versions.size > 0 || vulns.size > 0,
    truncated,
  };
}

interface CollectedSpecs {
  /** Versions the branch is introducing — worth checking for advisories. */
  current: VersionSpec[];
  /** Versions being replaced, needed only to compare against the new ones. */
  previous: VersionSpec[];
  truncated: boolean;
}

/**
 * Choose what to look up, most interesting first, and stop at the budget.
 * Removed packages are fetched last and only for their size, which is what
 * makes the install-size total add up instead of counting one direction.
 */
function collectSpecs(diff: LockDiff, maxLookups: number): CollectedSpecs {
  const ranked = [
    ...diff.added,
    ...diff.changed.filter((change) => change.breaking),
    ...diff.changed.filter((change) => !change.breaking),
    ...diff.removed,
  ];

  const current: VersionSpec[] = [];
  const previous: VersionSpec[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (const change of ranked) {
    if (current.length + previous.length >= maxLookups) {
      truncated = true;
      break;
    }
    if (change.kind === "removed") {
      addSpec(previous, seen, change.name, change.from);
      continue;
    }
    addSpec(current, seen, change.name, change.to);
    // The old version is only fetched to diff its metadata against the new one.
    if (change.kind === "changed") addSpec(previous, seen, change.name, change.from);
  }

  return { current, previous, truncated };
}

function addSpec(target: VersionSpec[], seen: Set<string>, name: string, version?: string): void {
  if (version === undefined) return;
  const spec = { name, version };
  const key = specKey(spec);
  if (seen.has(key)) return;
  seen.add(key);
  target.push(spec);
}

/** Registry metadata for the version a change moves to. */
export function infoFor(enrichment: Enrichment, change: PackageChange): VersionInfo | undefined {
  return change.to === undefined
    ? undefined
    : enrichment.versions.get(specKey({ name: change.name, version: change.to }));
}

/** Registry metadata for the version a change moves away from. */
export function previousInfoFor(
  enrichment: Enrichment,
  change: PackageChange,
): VersionInfo | undefined {
  return change.from === undefined
    ? undefined
    : enrichment.versions.get(specKey({ name: change.name, version: change.from }));
}

/** Advisories affecting the version a change moves to. */
export function vulnsFor(enrichment: Enrichment, change: PackageChange): VulnInfo[] {
  if (change.to === undefined) return [];
  return enrichment.vulns.get(specKey({ name: change.name, version: change.to })) ?? [];
}

/** Advisories that affected the version a change moves away from. */
export function previousVulnsFor(enrichment: Enrichment, change: PackageChange): VulnInfo[] {
  if (change.from === undefined) return [];
  return enrichment.vulns.get(specKey({ name: change.name, version: change.from })) ?? [];
}
