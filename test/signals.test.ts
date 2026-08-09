import { describe, expect, it } from "vitest";

import { diffLockfiles } from "../src/diff.js";
import type { Enrichment } from "../src/enrich/index.js";
import type { VulnInfo } from "../src/enrich/osv.js";
import type { VersionInfo } from "../src/enrich/registry.js";
import { summarize, worstLevel } from "../src/signals.js";
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
    online: true,
    truncated: false,
  };
}

const OFFLINE: Enrichment = {
  versions: new Map(),
  vulns: new Map(),
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
    expect(signal?.title).toContain("preinstall + postinstall");
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

    expect(summary.size).toEqual({ bytes: 1000, known: 2, total: 3 });
  });

  it("adds up sizes across both directions when they are all known", () => {
    const summary = summarize(
      diffLockfiles(lockfileOf(["gone@1.0.0"]), lockfileOf(["new@1.0.0"])),
      enrichmentOf({
        "gone@1.0.0": { unpackedSize: 3000 },
        "new@1.0.0": { unpackedSize: 1000 },
      }),
    );

    expect(summary.size).toEqual({ bytes: -2000, known: 2, total: 2 });
  });

  it("ranks the worst level present", () => {
    expect(worstLevel([{ level: "info", rule: "x", package: "p", title: "t" }])).toBe("info");
    expect(
      worstLevel([
        { level: "info", rule: "x", package: "p", title: "t" },
        { level: "high", rule: "y", package: "p", title: "t" },
      ]),
    ).toBe("high");
    expect(worstLevel([])).toBeUndefined();
  });
});
