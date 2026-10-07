import { afterEach, describe, expect, it, vi } from "vitest";

import { buildNotes } from "../src/commands/diff.js";
import { diffLockfiles } from "../src/diff.js";
import { fetchVulnerabilities } from "../src/enrich/osv.js";
import { fetchVersionInfo } from "../src/enrich/registry.js";
import { lockfileOf } from "./fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const http = { deadline: Date.now() + 60_000, userAgent: "lockreview-test" };

/**
 * OSV answers up to 200 versions per request. A run with more than that makes
 * several requests, and any one of them can fail while the others succeed.
 */
describe("advisory lookups", () => {
  it("records which versions OSV actually answered for", async () => {
    let call = 0;
    vi.stubGlobal("fetch", async (_url: string, init: { body?: string }) => {
      call += 1;
      const queries = (JSON.parse(init.body ?? "{}") as { queries: unknown[] }).queries;
      if (call === 1) return new Response("upstream timeout", { status: 503 });
      return Response.json({ results: queries.map(() => ({})) });
    });

    const specs = Array.from({ length: 250 }, (_, index) => ({ name: `pkg-${index}`, version: "1.0.0" }));
    const { vulns, checked } = await fetchVulnerabilities(specs, http);

    expect(vulns.size).toBe(0);
    // The first 200 went in the batch that failed: unknown, not clean.
    expect(checked.has("pkg-0@1.0.0")).toBe(false);
    expect(checked.has("pkg-199@1.0.0")).toBe(false);
    expect(checked.has("pkg-200@1.0.0")).toBe(true);
    expect(checked.size).toBe(50);
  });

  it("counts a version with advisories as checked too", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/querybatch")) return Response.json({ results: [{ vulns: [{ id: "GHSA-1" }] }] });
      return Response.json({ id: "GHSA-1", summary: "bad", database_specific: { severity: "HIGH" } });
    });

    const { vulns, checked } = await fetchVulnerabilities([{ name: "thing", version: "1.0.0" }], http);

    expect(checked.has("thing@1.0.0")).toBe(true);
    expect(vulns.get("thing@1.0.0")?.[0]).toMatchObject({ id: "GHSA-1", severity: "high" });
  });
});

describe("notes about what was not checked", () => {
  const diff = diffLockfiles(lockfileOf(["a@1.0.0"]), lockfileOf(["a@1.1.0", "b@2.0.0"]));
  const outcome = { blocking: [], suppressed: [] };
  const info = (name: string, version: string) => [`${name}@${version}`, { name, version }] as const;
  const enrichment = (versions: number, checked: string[]) => ({
    versions: new Map([info("a", "1.1.0"), info("b", "2.0.0")].slice(0, versions)),
    vulns: new Map(),
    vulnsChecked: new Set(checked),
    online: versions > 0 || checked.length > 0,
    truncated: false,
  });

  it("says nothing when every lookup came back", () => {
    expect(buildNotes(diff, enrichment(2, ["a@1.1.0", "b@2.0.0", "a@1.0.0"]), false, outcome)).toEqual([]);
  });

  it("names the advisories it could not check, rather than reading as clean", () => {
    const notes = buildNotes(diff, enrichment(2, ["a@1.1.0"]), false, outcome);
    expect(notes).toEqual(["OSV did not answer for 1 version, so advisories for those are unknown."]);
  });

  it("says when OSV did not answer at all", () => {
    expect(buildNotes(diff, enrichment(2, []), false, outcome)).toEqual([
      "OSV did not answer, so advisories were not checked.",
    ]);
  });

  it("says when only the registry was silent", () => {
    expect(buildNotes(diff, enrichment(0, ["a@1.1.0", "b@2.0.0"]), false, outcome)).toEqual([
      "No registry data came back, so install scripts, maintainers and licences were not checked.",
    ]);
  });

  it("keeps the old note when nothing came back at all", () => {
    expect(buildNotes(diff, enrichment(0, []), false, outcome)[0]).toMatch(/only lockfile-level checks ran/);
  });
});

describe("registry manifests", () => {
  it("marks a package published for some platforms only", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("linux-x64")) return Response.json({ os: ["linux"], cpu: ["x64"], dist: { unpackedSize: 9 } });
      if (url.includes("musl")) return Response.json({ libc: ["musl"], dist: { unpackedSize: 9 } });
      if (url.includes("everywhere")) return Response.json({ os: [], dist: { unpackedSize: 9 } });
      return Response.json({ dist: { unpackedSize: 9 } });
    });

    const infos = await fetchVersionInfo(
      [
        { name: "@esbuild/linux-x64", version: "0.21.5" },
        { name: "@rollup/rollup-linux-x64-musl", version: "4.0.0" },
        { name: "everywhere", version: "1.0.0" },
        { name: "esbuild", version: "0.21.5" },
      ],
      { ...http, registry: "https://registry.npmjs.org" },
    );

    expect(infos.get("@esbuild/linux-x64@0.21.5")?.platformSpecific).toBe(true);
    expect(infos.get("@rollup/rollup-linux-x64-musl@4.0.0")?.platformSpecific).toBe(true);
    expect(infos.get("everywhere@1.0.0")?.platformSpecific).toBe(false);
    expect(infos.get("esbuild@0.21.5")?.platformSpecific).toBe(false);
  });
});
