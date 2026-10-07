import { describe, expect, it } from "vitest";

import { diffLockfiles } from "../src/diff.js";
import type { Enrichment } from "../src/enrich/index.js";
import type { VulnInfo } from "../src/enrich/osv.js";
import type { VersionInfo } from "../src/enrich/registry.js";
import { gate, isRuleId, RULE_IDS, type Signal, summarize, worstLevel } from "../src/signals.js";
import { lockfileOf } from "./fixtures.js";

function enrichmentOf(
  versions: Record<string, Partial<VersionInfo>>,
  vulns: Record<string, VulnInfo[]> = {},
): Enrichment {
  const versionMap = new Map<string, VersionInfo>();
  for (const [key, value] of Object.entries(versions)) {
    const at = key.indexOf("@", 1);
    versionMap.set(key, { name: key.slice(0, at), version: key.slice(at + 1), ...value });
  }

  return {
    versions: versionMap,
    vulns: new Map(Object.entries(vulns)),
    // Everything named here was answered by OSV, clean or not.
    vulnsChecked: new Set([...Object.keys(versions), ...Object.keys(vulns)]),
    online: true,
    truncated: false,
  };
}

const OFFLINE: Enrichment = {
  versions: new Map(),
  vulns: new Map(),
  vulnsChecked: new Set(),
  online: false,
  truncated: false,
};

const rules = (summary: ReturnType<typeof summarize>): string[] =>
  summary.signals.map((signal) => signal.rule);

describe("install scripts", () => {
  it("flags a dependency that starts running code on install", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf(["thing@1.0.0"]), lockfileOf(["thing@1.1.0"])),
      enrichmentOf({
        "thing@1.0.0": {},
        "thing@1.1.0": { installScripts: ["postinstall"] },
      }),
    );

    const signal = summary.signals.find((entry) => entry.rule === "install-script");
    expect(signal?.level).toBe("high");
    expect(signal?.title).toContain("postinstall");
  });

  it("stays quiet when the old version already had one", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf(["thing@1.0.0"]), lockfileOf(["thing@1.1.0"])),
      enrichmentOf({
        "thing@1.0.0": { installScripts: ["postinstall"] },
        "thing@1.1.0": { installScripts: ["postinstall"] },
      }),
    );

    expect(rules(summary)).not.toContain("install-script");
  });

  it("does not claim a script is new when the old version is unknown", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf(["thing@1.0.0"]), lockfileOf(["thing@1.1.0"])),
      enrichmentOf({ "thing@1.1.0": { installScripts: ["postinstall"] } }),
    );

    expect(rules(summary)).not.toContain("install-script");
  });

  it("mentions a new dependency that installs with a script", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf([]), lockfileOf(["thing@1.0.0"])),
      enrichmentOf({ "thing@1.0.0": { installScripts: ["preinstall", "postinstall"] } }),
    );

    const signal = summary.signals.find((entry) => entry.rule === "install-script");
    expect(signal?.level).toBe("warn");
    expect(signal?.title).toContain("preinstall, postinstall");
  });
});

describe("ownership", () => {
  it("flags an account that gained publish rights", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf(["thing@1.0.0"]), lockfileOf(["thing@1.1.0"])),
      enrichmentOf({
        "thing@1.0.0": { maintainers: ["alice"] },
        "thing@1.1.0": { maintainers: ["alice", "mallory"] },
      }),
    );

    const signal = summary.signals.find((entry) => entry.rule === "maintainer");
    expect(signal?.level).toBe("warn");
    expect(signal?.title).toContain("mallory");
  });

  it("ignores a maintainer who lost access", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf(["thing@1.0.0"]), lockfileOf(["thing@1.1.0"])),
      enrichmentOf({
        "thing@1.0.0": { maintainers: ["alice", "bob"] },
        "thing@1.1.0": { maintainers: ["alice"] },
      }),
    );

    expect(rules(summary)).not.toContain("maintainer");
  });

  it("flags a release published by an outsider", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf(["thing@1.0.0"]), lockfileOf(["thing@1.1.0"])),
      enrichmentOf({
        "thing@1.0.0": { maintainers: ["alice"], publisher: "alice" },
        "thing@1.1.0": { maintainers: ["alice"], publisher: "mallory" },
      }),
    );

    const signal = summary.signals.find((entry) => entry.rule === "maintainer");
    expect(signal?.level).toBe("high");
    expect(signal?.title).toContain("mallory");
  });

  it("treats trusted publishing as routine, not an ownership change", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf(["thing@1.0.0"]), lockfileOf(["thing@1.1.0"])),
      enrichmentOf({
        "thing@1.0.0": { maintainers: ["alice"], publisher: "alice" },
        "thing@1.1.0": { maintainers: ["alice"], publisher: "GitHub Actions", automated: true },
      }),
    );

    expect(rules(summary)).not.toContain("maintainer");
  });

  it("says nothing about a publisher who was already a maintainer", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf(["thing@1.0.0"]), lockfileOf(["thing@1.1.0"])),
      enrichmentOf({
        "thing@1.0.0": { maintainers: ["alice", "bob"], publisher: "alice" },
        "thing@1.1.0": { maintainers: ["alice", "bob"], publisher: "bob" },
      }),
    );

    expect(rules(summary)).not.toContain("maintainer");
  });
});

describe("advisories", () => {
  const vuln = (id: string, severity: VulnInfo["severity"]): VulnInfo => ({
    id,
    severity,
    url: `https://osv.dev/vulnerability/${id}`,
  });

  it("reports an advisory a new dependency brings in", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf([]), lockfileOf(["thing@1.0.0"])),
      enrichmentOf({ "thing@1.0.0": {} }, { "thing@1.0.0": [vuln("GHSA-1", "critical")] }),
    );

    const signal = summary.signals.find((entry) => entry.rule === "vulnerability");
    expect(signal?.level).toBe("high");
  });

  it("reports an upgrade that fixes one", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf(["thing@1.0.0"]), lockfileOf(["thing@1.1.0"])),
      enrichmentOf(
        { "thing@1.0.0": {}, "thing@1.1.0": {} },
        { "thing@1.0.0": [vuln("GHSA-1", "high")] },
      ),
    );

    const signal = summary.signals.find((entry) => entry.rule === "vulnerability-fixed");
    expect(signal?.level).toBe("info");
    expect(rules(summary)).not.toContain("vulnerability");
  });

  it("stays quiet about an advisory that was already there", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf(["thing@1.0.0"]), lockfileOf(["thing@1.1.0"])),
      enrichmentOf(
        { "thing@1.0.0": {}, "thing@1.1.0": {} },
        { "thing@1.0.0": [vuln("GHSA-1", "high")], "thing@1.1.0": [vuln("GHSA-1", "high")] },
      ),
    );

    expect(summary.signals).toHaveLength(0);
  });

  /*
   * OSV is asked in batches, and a batch can fail on its own. When the batch
   * holding the new version failed and the one holding the old version came
   * back, the new version looked advisory-free and the report announced a fix
   * nobody had checked — a failed lookup reading as clean.
   */
  it("does not claim a fix when the new version was never checked", () => {
    const enrichment = enrichmentOf(
      { "thing@1.0.0": {}, "thing@1.1.0": {} },
      { "thing@1.0.0": [vuln("GHSA-1", "high")] },
    );
    enrichment.vulnsChecked.delete("thing@1.1.0");

    const summary = summarize(diffLockfiles(lockfileOf(["thing@1.0.0"]), lockfileOf(["thing@1.1.0"])), enrichment);

    expect(rules(summary)).not.toContain("vulnerability-fixed");
  });

  it("still reports an advisory on the new version when the old one was never checked", () => {
    const enrichment = enrichmentOf(
      { "thing@1.0.0": {}, "thing@1.1.0": {} },
      { "thing@1.1.0": [vuln("GHSA-2", "critical")] },
    );
    enrichment.vulnsChecked.delete("thing@1.0.0");

    const summary = summarize(diffLockfiles(lockfileOf(["thing@1.0.0"]), lockfileOf(["thing@1.1.0"])), enrichment);

    expect(rules(summary)).toContain("vulnerability");
  });

  it("counts removing a vulnerable package as a fix", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf(["thing@1.0.0"]), lockfileOf([])),
      enrichmentOf({ "thing@1.0.0": {} }, { "thing@1.0.0": [vuln("GHSA-1", "moderate")] }),
    );

    expect(rules(summary)).toContain("vulnerability-fixed");
  });
});

describe("lockfile-only rules", () => {
  it("flags a version that moved backwards without any network data", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf(["thing@2.0.0"]), lockfileOf(["thing@1.0.0"])),
      OFFLINE,
    );

    expect(rules(summary)).toContain("downgrade");
  });

  it("flags a dependency installed straight from a code host", () => {
    const summary = summarize(
      diffLockfiles(
        lockfileOf([]),
        lockfileOf([
          {
            name: "thing",
            version: "1.0.0",
            resolved: "https://codeload.github.com/someone/thing/tar.gz/abc123",
          },
        ]),
      ),
      OFFLINE,
    );

    const signal = summary.signals.find((entry) => entry.rule === "source");
    expect(signal?.title).toContain("codeload.github.com");
  });

  /*
   * registry.yarnpkg.com is Yarn's name for the npm registry. A yarn.lock in
   * which some entries say one and some the other — a contributor with a
   * different registry setting is enough — changed nothing about where the code
   * comes from, and a high-level finding there fails every --check.
   */
  it("treats yarn's registry and npm's as the same place", () => {
    const summary = summarize(
      diffLockfiles(
        lockfileOf([{ name: "chalk", version: "5.3.0", resolved: "https://registry.yarnpkg.com/chalk/-/chalk-5.3.0.tgz" }]),
        lockfileOf([{ name: "chalk", version: "5.4.0", resolved: "https://registry.npmjs.org/chalk/-/chalk-5.4.0.tgz" }]),
      ),
      OFFLINE,
    );

    expect(rules(summary)).not.toContain("source");
  });

  it("reads a deprecation pnpm recorded in the lockfile, offline", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf([]), lockfileOf([{ name: "request", version: "2.88.2", deprecated: "request has been deprecated" }])),
      OFFLINE,
    );

    expect(summary.signals.find((signal) => signal.rule === "deprecated")?.detail).toBe("request has been deprecated");
  });

  it("does not call a version newly deprecated when the old one was too", () => {
    const summary = summarize(
      diffLockfiles(
        lockfileOf([{ name: "request", version: "2.88.0", deprecated: "deprecated" }]),
        lockfileOf([{ name: "request", version: "2.88.2", deprecated: "deprecated" }]),
      ),
      OFFLINE,
    );

    expect(rules(summary)).not.toContain("deprecated");
  });

  it("does not flag a private registry as unusual", () => {
    const summary = summarize(
      diffLockfiles(
        lockfileOf([]),
        lockfileOf([
          {
            name: "thing",
            version: "1.0.0",
            resolved: "https://artifactory.corp.example.com/api/npm/npm/thing/-/thing-1.0.0.tgz",
          },
        ]),
      ),
      OFFLINE,
    );

    expect(rules(summary)).not.toContain("source");
  });

  it("flags a licence change", () => {
    const summary = summarize(
      diffLockfiles(
        lockfileOf([{ name: "thing", version: "1.0.0", license: "MIT" }]),
        lockfileOf([{ name: "thing", version: "2.0.0", license: "BUSL-1.1" }]),
      ),
      OFFLINE,
    );

    const signal = summary.signals.find((entry) => entry.rule === "license");
    expect(signal?.level).toBe("high");
    expect(signal?.title).toContain("MIT → BUSL-1.1");
  });

  it("notices an integrity hash going missing", () => {
    const summary = summarize(
      diffLockfiles(
        lockfileOf([{ name: "thing", version: "1.0.0", integrity: "sha512-a" }]),
        lockfileOf([{ name: "thing", version: "1.0.1" }]),
      ),
      OFFLINE,
    );

    expect(rules(summary)).toContain("integrity");
  });

  it("lists the extra copies of a package in semver order", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf(["chalk@9.0.0"]), lockfileOf(["chalk@2.0.0", "chalk@9.0.0", "chalk@10.0.0"])),
      OFFLINE,
    );

    const duplicates = summary.signals.find((signal) => signal.rule === "duplicates");
    expect(duplicates?.title).toContain("3 different versions");
    // A string sort reads back "10.0.0, 2.0.0, 9.0.0", which is worse than
    // useless on the one line that exists to be skimmed.
    expect(duplicates?.detail).toBe("2.0.0, 9.0.0, 10.0.0");
  });
});

describe("noise control", () => {
  it("collapses the same finding across many packages into one line", () => {
    const before = lockfileOf(
      Array.from({ length: 8 }, (_, index) => ({
        name: `pkg-${index}`,
        version: "1.0.0",
        resolved: `https://registry.npmjs.org/pkg-${index}/-/pkg-${index}-1.0.0.tgz`,
      })),
    );
    const after = lockfileOf(
      Array.from({ length: 8 }, (_, index) => ({
        name: `pkg-${index}`,
        version: "1.0.1",
        resolved: `https://npm.internal.example.com/pkg-${index}/-/pkg-${index}-1.0.1.tgz`,
      })),
    );

    const summary = summarize(diffLockfiles(before, after), OFFLINE);
    const sourceSignals = summary.signals.filter((signal) => signal.rule === "source");

    expect(sourceSignals).toHaveLength(1);
    expect(sourceSignals[0]?.count).toBe(8);
    expect(sourceSignals[0]?.package).toBe("8 packages");
  });

  it("leaves a handful of findings listed individually", () => {
    const before = lockfileOf([
      { name: "a", version: "1.0.0", resolved: "https://registry.npmjs.org/a.tgz" },
      { name: "b", version: "1.0.0", resolved: "https://registry.npmjs.org/b.tgz" },
    ]);
    const after = lockfileOf([
      { name: "a", version: "1.0.1", resolved: "https://npm.internal.example.com/a.tgz" },
      { name: "b", version: "1.0.1", resolved: "https://npm.internal.example.com/b.tgz" },
    ]);

    const summary = summarize(diffLockfiles(before, after), OFFLINE);
    expect(summary.signals.filter((signal) => signal.rule === "source")).toHaveLength(2);
  });
});

describe("summary", () => {
  it("counts each kind of bump", () => {
    const summary = summarize(
      diffLockfiles(
        lockfileOf(["a@1.0.0", "b@1.0.0", "c@1.0.0", "d@2.0.0", "gone@1.0.0"]),
        lockfileOf(["a@2.0.0", "b@1.1.0", "c@1.0.1", "d@1.0.0", "new@1.0.0"]),
      ),
      OFFLINE,
    );

    expect(summary).toMatchObject({
      added: 1,
      removed: 1,
      changed: 4,
      major: 1,
      minor: 1,
      patch: 1,
      downgrades: 1,
    });
  });

  it("reports no install size when offline", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf([]), lockfileOf(["thing@1.0.0"])),
      OFFLINE,
    );
    expect(summary.size).toBeUndefined();
  });

  it("withholds the install size when too few sizes are known", () => {
    const after = lockfileOf(Array.from({ length: 10 }, (_, index) => `pkg-${index}@1.0.0`));
    const summary = summarize(
      diffLockfiles(lockfileOf([]), after),
      enrichmentOf({ "pkg-0@1.0.0": { unpackedSize: 1024 } }),
    );

    expect(summary.size).toBeUndefined();
  });

  it("withholds the install size when lookups were truncated", () => {
    const enrichment = enrichmentOf({
      "gone@1.0.0": { unpackedSize: 3000 },
      "new@1.0.0": { unpackedSize: 1000 },
    });

    const summary = summarize(diffLockfiles(lockfileOf(["gone@1.0.0"]), lockfileOf(["new@1.0.0"])), {
      ...enrichment,
      truncated: true,
    });

    expect(summary.size).toBeUndefined();
  });

  it("still reports a total when a few sizes are simply unrecorded", () => {
    const before = lockfileOf(["a@1.0.0", "b@1.0.0", "c@1.0.0"]);
    const after = lockfileOf(["a@2.0.0", "b@2.0.0", "c@2.0.0"]);
    const summary = summarize(
      diffLockfiles(before, after),
      enrichmentOf({
        "a@1.0.0": { unpackedSize: 1000 },
        "a@2.0.0": { unpackedSize: 2000 },
        "b@1.0.0": { unpackedSize: 500 },
        "b@2.0.0": { unpackedSize: 500 },
      }),
    );

    expect(summary.size).toEqual({ bytes: 1000, known: 2, total: 3, platformSpecific: 0 });
  });

  it("adds up sizes across both directions when they are all known", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf(["gone@1.0.0"]), lockfileOf(["new@1.0.0"])),
      enrichmentOf({
        "gone@1.0.0": { unpackedSize: 3000 },
        "new@1.0.0": { unpackedSize: 1000 },
      }),
    );

    expect(summary.size).toEqual({ bytes: -2000, known: 2, total: 2, platformSpecific: 0 });
  });

  /*
   * esbuild, swc, rollup and Next.js publish one binary package per platform,
   * and a lockfile lists every one of them while an install fetches one. Adding
   * esbuild read as +224 MB — about twenty times what an install grows by.
   */
  it("leaves platform-specific packages out of the install size, and counts them", () => {
    const after = lockfileOf(["esbuild@0.21.5", "@esbuild/linux-x64@0.21.5", "@esbuild/darwin-arm64@0.21.5"]);
    const summary = summarize(
      diffLockfiles(lockfileOf([]), after),
      enrichmentOf({
        "esbuild@0.21.5": { unpackedSize: 130_000 },
        "@esbuild/linux-x64@0.21.5": { unpackedSize: 9_700_000, platformSpecific: true },
        "@esbuild/darwin-arm64@0.21.5": { unpackedSize: 9_300_000, platformSpecific: true },
      }),
    );

    expect(summary.size).toEqual({ bytes: 130_000, known: 1, total: 1, platformSpecific: 2 });
  });

  it("does the same for a platform package that was upgraded or removed", () => {
    const summary = summarize(
      diffLockfiles(
        lockfileOf(["@swc/core-linux-x64-gnu@1.7.0", "fsevents@2.3.2", "a@1.0.0"]),
        lockfileOf(["@swc/core-linux-x64-gnu@1.7.1", "a@2.0.0"]),
      ),
      enrichmentOf({
        "@swc/core-linux-x64-gnu@1.7.0": { unpackedSize: 40_000_000, platformSpecific: true },
        "@swc/core-linux-x64-gnu@1.7.1": { unpackedSize: 41_000_000, platformSpecific: true },
        "fsevents@2.3.2": { unpackedSize: 170_000, platformSpecific: true },
        "a@1.0.0": { unpackedSize: 1000 },
        "a@2.0.0": { unpackedSize: 1500 },
      }),
    );

    expect(summary.size).toEqual({ bytes: 500, known: 1, total: 1, platformSpecific: 2 });
  });

  it("still withholds a total when only platform-specific packages moved", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf([]), lockfileOf(["@esbuild/linux-x64@0.21.5"])),
      enrichmentOf({ "@esbuild/linux-x64@0.21.5": { unpackedSize: 9_700_000, platformSpecific: true } }),
    );

    expect(summary.size).toBeUndefined();
  });

  it("ranks the worst level present", () => {
    expect(worstLevel([{ level: "info", rule: "license", package: "p", title: "t" }])).toBe("info");
    expect(
      worstLevel([
        { level: "info", rule: "license", package: "p", title: "t" },
        { level: "high", rule: "integrity", package: "p", title: "t" },
      ]),
    ).toBe("high");
    expect(worstLevel([])).toBeUndefined();
  });
});

describe("the --check gate", () => {
  const signals: Signal[] = [
    { level: "high", rule: "vulnerability", package: "a", title: "advisory" },
    { level: "high", rule: "install-script", package: "b", title: "install script" },
    { level: "warn", rule: "maintainer", package: "c", title: "new maintainer" },
    { level: "info", rule: "duplicates", package: "d", title: "duplicated" },
  ];

  it("blocks on everything at or above the threshold", () => {
    expect(gate(signals, "high", new Set()).blocking).toHaveLength(2);
    expect(gate(signals, "warn", new Set()).blocking).toHaveLength(3);
    expect(gate(signals, "info", new Set()).blocking).toHaveLength(4);
  });

  it("moves an ignored rule out of the way without dropping it", () => {
    const outcome = gate(signals, "high", new Set(["install-script"] as const));

    expect(outcome.blocking.map((signal) => signal.rule)).toEqual(["vulnerability"]);
    expect(outcome.suppressed.map((signal) => signal.package)).toEqual(["b"]);
  });

  it("ignores nothing below the threshold, so the count stays honest", () => {
    const outcome = gate(signals, "high", new Set(["duplicates"] as const));

    expect(outcome.suppressed).toHaveLength(0);
  });

  it("can empty the gate entirely", () => {
    const outcome = gate(signals, "high", new Set(["vulnerability", "install-script"] as const));

    expect(outcome.blocking).toHaveLength(0);
    expect(outcome.suppressed).toHaveLength(2);
  });

  it("knows its own rule ids", () => {
    expect(isRuleId("install-script")).toBe(true);
    expect(isRuleId("instal-script")).toBe(false);
    for (const signal of signals) expect(RULE_IDS).toContain(signal.rule);
  });
});
