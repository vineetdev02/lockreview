import { getJson, pool, type HttpOptions } from "./http.js";

export interface VersionInfo {
  name: string;
  version: string;
  license?: string;
  unpackedSize?: number;
  deprecated?: string;
  /** npm accounts that can publish this package, as of now. */
  maintainers?: string[];
  /** The account that published this specific version. */
  publisher?: string;
  /**
   * True when the release came from npm Trusted Publishing (OIDC from a CI
   * provider) rather than a personal token. That is a hardening measure, so a
   * publisher "change" into it is not a finding.
   */
  automated?: boolean;
  /** Lifecycle scripts that run on install, if any. */
  installScripts?: string[];
}

export interface VersionSpec {
  name: string;
  version: string;
}

const INSTALL_LIFECYCLE = ["preinstall", "install", "postinstall"] as const;

interface RegistryManifest {
  license?: string | { type?: string };
  deprecated?: string;
  dist?: { unpackedSize?: number };
  maintainers?: Array<{ name?: string } | string>;
  _npmUser?: { name?: string; trustedPublisher?: { id?: string } };
  scripts?: Record<string, string>;
}

export function specKey(spec: VersionSpec): string {
  return `${spec.name}@${spec.version}`;
}

/**
 * Fetch one manifest per package version from the npm registry.
 *
 * Single-version manifests are ~2-8 KB each, unlike the full packument which
 * can run to megabytes for popular packages — that is what makes checking
 * maintainers and install scripts affordable on every pull request.
 */
export async function fetchVersionInfo(
  specs: readonly VersionSpec[],
  options: HttpOptions & { registry: string; concurrency?: number },
): Promise<Map<string, VersionInfo>> {
  const found = new Map<string, VersionInfo>();
  if (specs.length === 0) return found;

  const base = options.registry.replace(/\/+$/, "");

  const infos = await pool(specs, options.concurrency ?? 10, async (spec) => {
    // Scoped names carry a slash, so the name is encoded as a single path
    // segment: `@babel/code-frame` -> `%40babel%2Fcode-frame`.
    const path = `${encodeURIComponent(spec.name)}/${encodeURIComponent(spec.version)}`;
    const manifest = await getJson<RegistryManifest>(`${base}/${path}`, options);
    return manifest === undefined ? undefined : toVersionInfo(spec, manifest);
  });

  for (const info of infos) {
    if (info) found.set(specKey(info), info);
  }

  return found;
}

function toVersionInfo(spec: VersionSpec, manifest: RegistryManifest): VersionInfo {
  const scripts = manifest.scripts ?? {};
  const installScripts = INSTALL_LIFECYCLE.filter(
    (name) => typeof scripts[name] === "string" && scripts[name]!.trim().length > 0,
  );

  return {
    name: spec.name,
    version: spec.version,
    license: normalizeLicense(manifest.license),
    unpackedSize: typeof manifest.dist?.unpackedSize === "number" ? manifest.dist.unpackedSize : undefined,
    deprecated: typeof manifest.deprecated === "string" ? manifest.deprecated : undefined,
    maintainers: normalizeMaintainers(manifest.maintainers),
    publisher: manifest._npmUser?.name,
    automated: manifest._npmUser?.trustedPublisher !== undefined,
    installScripts: installScripts.length > 0 ? [...installScripts] : undefined,
  };
}

function normalizeLicense(license: RegistryManifest["license"]): string | undefined {
  if (typeof license === "string") return license;
  if (license && typeof license === "object" && typeof license.type === "string") return license.type;
  return undefined;
}

function normalizeMaintainers(maintainers: RegistryManifest["maintainers"]): string[] | undefined {
  if (!Array.isArray(maintainers)) return undefined;

  const names = maintainers
    .map((entry) => (typeof entry === "string" ? entry : entry?.name))
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .map((name) => name.toLowerCase());

  return names.length > 0 ? [...new Set(names)].sort() : undefined;
}
