import { indexPackages, LockParseError, type Lockfile, type LockPackage } from "./types.js";

interface NpmV3Entry {
  version?: string;
  resolved?: string;
  integrity?: string;
  dev?: boolean;
  devOptional?: boolean;
  optional?: boolean;
  license?: string;
  hasInstallScript?: boolean;
  link?: boolean;
  name?: string;
}

interface NpmV1Entry {
  version?: string;
  resolved?: string;
  integrity?: string;
  dev?: boolean;
  optional?: boolean;
  dependencies?: Record<string, NpmV1Entry>;
}

interface NpmLockDocument {
  lockfileVersion?: number;
  packages?: Record<string, NpmV3Entry>;
  dependencies?: Record<string, NpmV1Entry>;
}

/** Parse `package-lock.json` or `npm-shrinkwrap.json`, lockfileVersion 1, 2 or 3. */
export function parseNpmLock(text: string): Lockfile {
  let doc: NpmLockDocument;
  try {
    doc = JSON.parse(text) as NpmLockDocument;
  } catch (error) {
    throw new LockParseError(`package-lock.json is not valid JSON: ${(error as Error).message}`);
  }
  if (doc === null || typeof doc !== "object") {
    throw new LockParseError("package-lock.json did not contain an object.");
  }

  const version = typeof doc.lockfileVersion === "number" ? String(doc.lockfileVersion) : "unknown";

  // v2 carries both shapes; `packages` is the authoritative one and records
  // strictly more (license, install scripts), so prefer it whenever present.
  const list = doc.packages ? fromPackagesMap(doc.packages) : fromLegacyTree(doc.dependencies ?? {});

  return {
    kind: "npm",
    lockfileVersion: version,
    packages: indexPackages(list),
    entryCount: list.length,
  };
}

function fromPackagesMap(packages: Record<string, NpmV3Entry>): LockPackage[] {
  const list: LockPackage[] = [];

  for (const [path, entry] of Object.entries(packages)) {
    if (!entry || typeof entry !== "object") continue;
    // "" is the project root and "packages/app" style keys are workspace
    // members — local code, not dependencies.
    const name = nameFromPath(path);
    if (name === undefined) continue;
    // `link: true` entries point at a workspace directory; the real content is
    // the target entry, which appears separately.
    if (entry.link) continue;
    if (typeof entry.version !== "string") continue;

    list.push({
      name,
      version: entry.version,
      resolved: entry.resolved,
      integrity: entry.integrity,
      dev: entry.dev === true || entry.devOptional === true,
      optional: entry.optional === true,
      hasInstallScript: entry.hasInstallScript === true,
      license: typeof entry.license === "string" ? entry.license : undefined,
      path,
    });
  }

  return list;
}

/**
 * npm 6 lockfiles (v1) store a nested tree instead of a flat map. Walk it and
 * flatten, keeping the tree path so duplicate copies stay distinguishable.
 */
function fromLegacyTree(tree: Record<string, NpmV1Entry>): LockPackage[] {
  const list: LockPackage[] = [];

  const walk = (deps: Record<string, NpmV1Entry>, prefix: string): void => {
    for (const [name, entry] of Object.entries(deps)) {
      if (!entry || typeof entry !== "object") continue;
      const path = `${prefix}node_modules/${name}`;
      if (typeof entry.version === "string") {
        list.push({
          name,
          version: entry.version,
          resolved: entry.resolved,
          integrity: entry.integrity,
          dev: entry.dev === true,
          optional: entry.optional === true,
          path,
        });
      }
      if (entry.dependencies) walk(entry.dependencies, `${path}/`);
    }
  };

  walk(tree, "");
  return list;
}

/**
 * `node_modules/foo` -> `foo`, `node_modules/a/node_modules/@scope/b` ->
 * `@scope/b`. Returns undefined for the root and for workspace member paths,
 * which are local packages rather than installed dependencies.
 */
export function nameFromPath(path: string): string | undefined {
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  if (index === -1) return undefined;
  const name = path.slice(index + marker.length);
  return name.length > 0 ? name : undefined;
}
