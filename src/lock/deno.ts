import { indexPackages, LockParseError, type Lockfile, type LockPackage } from "./types.js";
import { nameFromDescriptor } from "./yarn.js";

/**
 * Parse `deno.lock` — versions 2 through 5.
 *
 * Deno keeps two registries in one file, and moved them between versions:
 *
 *   v2, v3   { "version": "3", "packages": { "npm": {…}, "jsr": {…} }, "remote": {…} }
 *   v4, v5   { "version": "4", "npm": {…}, "jsr": {…}, "remote": {…} }
 *
 * Both sections are read from wherever they sit, so one reader covers every
 * version Deno 1.40 through 2.x writes.
 *
 * `remote` — bare `https://` imports keyed by URL and hashed, with no version
 * anywhere — is skipped: there is no version to compare, so a diff of it would
 * be the unreadable hash wall lockreview exists to replace.
 */
export function parseDenoLock(text: string): Lockfile {
  const doc = parseJson(text);

  const version = versionOf(doc.version);
  const nested = asRecord(doc.packages);
  const npm = asRecord(doc.npm) ?? asRecord(nested?.npm);
  const jsr = asRecord(doc.jsr) ?? asRecord(nested?.jsr);

  // Lockfile v1 was a flat map of remote URL to hash, with no version field and
  // no package sections at all. Nothing in it carries a version, so there is
  // nothing to review — say so rather than reporting an empty diff as clean.
  if (!npm && !jsr && version === "unknown") {
    throw new LockParseError(
      "deno.lock records only remote URL hashes, which carry no versions to compare. " +
        "lockreview reads the npm and jsr sections of lockfile version 2 and later.",
    );
  }

  const list = [...entriesOf(npm, ""), ...entriesOf(jsr, "jsr:")];

  return {
    kind: "deno",
    lockfileVersion: version,
    packages: indexPackages(list),
    entryCount: list.length,
  };
}

/**
 * JSR packages keep their `jsr:` prefix — the way Deno itself spells them in an
 * import — because they are not npm packages under a similar name. The prefix
 * is also what stops the enrichment step spending a registry or advisory lookup
 * on a name registry.npmjs.org has never heard of.
 */
function entriesOf(section: Record<string, unknown> | undefined, prefix: string): LockPackage[] {
  if (!section) return [];

  const list: LockPackage[] = [];
  for (const [key, raw] of Object.entries(section)) {
    const parsed = parseDenoKey(key);
    if (!parsed) continue;
    list.push({
      name: `${prefix}${parsed.name}`,
      version: parsed.version,
      integrity: integrityOf(raw),
      // deno.lock records neither install scripts, licences nor a dev/prod
      // split, and it never names the registry a package came from — that is
      // whatever `NPM_CONFIG_REGISTRY` pointed at, which may not be npmjs.org.
      // All of it stays undefined so an offline run reads as unknown, not clean.
    });
  }
  return list;
}

/**
 * Split `chalk@5.3.0` or `@std/assert@1.0.13` into name and version.
 *
 * Deno appends the resolved peer dependencies to an npm key —
 * `vite@5.4.0_@types+node@22.5.0` — the same way pnpm does. The suffix is part
 * of the identity of the *install*, not of the package, and two copies that
 * differ only by peers are the same version to a reviewer, so it is dropped.
 * A version can never contain `_`, so cutting at the first one is safe even
 * for the npm names that contain underscores.
 */
export function parseDenoKey(key: string): { name: string; version: string } | undefined {
  const name = nameFromDescriptor(key);
  if (!name || key.length <= name.length) return undefined;

  const rest = key.slice(name.length + 1);
  const version = rest.split("_")[0] ?? "";
  if (version === "") return undefined;

  return { name, version };
}

function integrityOf(raw: unknown): string | undefined {
  const entry = asRecord(raw);
  const integrity = entry?.integrity;
  return typeof integrity === "string" && integrity !== "" ? integrity : undefined;
}

function versionOf(raw: unknown): string {
  if (typeof raw === "string" && raw !== "") return raw;
  if (typeof raw === "number") return String(raw);
  return "unknown";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJson(text: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = JSON.parse(text) as unknown;
  } catch (error) {
    throw new LockParseError(`deno.lock is not valid JSON: ${(error as Error).message}`);
  }

  const record = asRecord(doc);
  if (!record) throw new LockParseError("deno.lock did not contain an object.");
  return record;
}
