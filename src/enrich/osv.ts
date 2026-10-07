import { getJson, pool, postJson, type HttpOptions } from "./http.js";
import { specKey, type VersionSpec } from "./registry.js";

export type VulnSeverity = "critical" | "high" | "moderate" | "low" | "unknown";

export interface VulnInfo {
  id: string;
  severity: VulnSeverity;
  summary?: string;
  url: string;
}

interface BatchResponse {
  results?: Array<{ vulns?: Array<{ id?: string }> }>;
}

interface VulnDetail {
  id?: string;
  summary?: string;
  database_specific?: { severity?: string };
  severity?: Array<{ type?: string; score?: string }>;
}

const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";
const OSV_VULN_URL = "https://api.osv.dev/v1/vulns";
const BATCH_SIZE = 200;
/** Cap the follow-up detail lookups; the batch call already gives the count. */
const MAX_DETAIL_LOOKUPS = 25;

export interface VulnLookup {
  /** Advisories per `name@version`, only for versions that have any. */
  vulns: Map<string, VulnInfo[]>;
  /**
   * Every `name@version` OSV actually answered for, advisories or not. A
   * version missing from `vulns` is only clean if it is in here: a batch that
   * failed leaves its versions unknown, and unknown must never read as clean.
   */
  checked: Set<string>;
}

/**
 * Look up known advisories for a set of package versions via OSV.dev.
 *
 * One batched request covers up to 200 versions, so the common pull request
 * costs a single round trip. Severity comes from a second, capped pass.
 */
export async function fetchVulnerabilities(
  specs: readonly VersionSpec[],
  options: HttpOptions,
): Promise<VulnLookup> {
  const byPackage = new Map<string, VulnInfo[]>();
  const checked = new Set<string>();
  if (specs.length === 0) return { vulns: byPackage, checked };

  const idsByKey = new Map<string, string[]>();
  const allIds = new Set<string>();

  for (let start = 0; start < specs.length; start += BATCH_SIZE) {
    const chunk = specs.slice(start, start + BATCH_SIZE);
    const body = {
      queries: chunk.map((spec) => ({
        package: { name: spec.name, ecosystem: "npm" },
        version: spec.version,
      })),
    };

    const response = await postJson<BatchResponse>(OSV_BATCH_URL, body, options);
    if (!response?.results) continue;

    response.results.forEach((result, index) => {
      const spec = chunk[index];
      if (!spec || !result || typeof result !== "object") return;
      checked.add(specKey(spec));
      const ids = (result?.vulns ?? [])
        .map((vuln) => vuln?.id)
        .filter((id): id is string => typeof id === "string");
      if (ids.length === 0) return;
      idsByKey.set(specKey(spec), ids);
      for (const id of ids) allIds.add(id);
    });
  }

  const details = await fetchDetails([...allIds].slice(0, MAX_DETAIL_LOOKUPS), options);

  for (const [key, ids] of idsByKey) {
    const vulns = ids.map(
      (id): VulnInfo =>
        details.get(id) ?? { id, severity: "unknown", url: `https://osv.dev/vulnerability/${id}` },
    );
    vulns.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    byPackage.set(key, vulns);
  }

  return { vulns: byPackage, checked };
}

async function fetchDetails(ids: string[], options: HttpOptions): Promise<Map<string, VulnInfo>> {
  const found = new Map<string, VulnInfo>();

  const details = await pool(ids, 8, (id) =>
    getJson<VulnDetail>(`${OSV_VULN_URL}/${encodeURIComponent(id)}`, options),
  );

  details.forEach((detail, index) => {
    const id = ids[index];
    if (!id) return;
    found.set(id, {
      id,
      severity: readSeverity(detail),
      summary: detail?.summary,
      url: `https://osv.dev/vulnerability/${id}`,
    });
  });

  return found;
}

function readSeverity(detail: VulnDetail | undefined): VulnSeverity {
  const label = detail?.database_specific?.severity?.toLowerCase();
  if (label === "critical" || label === "high" || label === "moderate" || label === "low") {
    return label;
  }
  if (label === "medium") return "moderate";

  return scoreToSeverity(detail?.severity);
}

/** Fall back to the CVSS vector's base score when no label is published. */
function scoreToSeverity(severity: VulnDetail["severity"]): VulnSeverity {
  const vector = severity?.find((entry) => entry?.type?.startsWith("CVSS"))?.score;
  if (!vector) return "unknown";

  const numeric = Number(vector);
  if (!Number.isFinite(numeric)) return "unknown";
  if (numeric >= 9) return "critical";
  if (numeric >= 7) return "high";
  if (numeric >= 4) return "moderate";
  return "low";
}

export const SEVERITY_ORDER: Record<VulnSeverity, number> = {
  critical: 0,
  high: 1,
  moderate: 2,
  low: 3,
  unknown: 4,
};
