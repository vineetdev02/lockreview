import { describe, expect, it } from "vitest";

import { getBool, getNumber, getString, parseArgs, UsageError } from "../src/args.js";
import { diffLockfiles } from "../src/diff.js";
import { EMPTY_ENRICHMENT } from "../src/enrich/index.js";
import { setColorEnabled } from "../src/render/ansi.js";
import { formatBytes, formatBytesDelta, listSentence, plural } from "../src/render/format.js";
import { renderJson, SCHEMA_VERSION } from "../src/render/json.js";
import { COMMENT_MARKER, renderMarkdown } from "../src/render/markdown.js";
import { renderTerminal } from "../src/render/terminal.js";
import type { Report } from "../src/report.js";
import { summarize } from "../src/signals.js";
import { lockfileOf } from "./fixtures.js";

setColorEnabled(false);

const KNOWN = { base: "string", json: "boolean", check: "boolean", color: "boolean" } as const;

function reportOf(before: string[], after: string[]): Report {
  const diff = diffLockfiles(lockfileOf(before), lockfileOf(after));

  return {
    lockfile: "package-lock.json",
    kind: "npm",
    before: { label: "main", lockfileVersion: "3" },
    after: { label: "working tree", lockfileVersion: "3" },
    diff,
    summary: summarize(diff, EMPTY_ENRICHMENT),
    enrichment: EMPTY_ENRICHMENT,
    notes: [],
  };
}

describe("parseArgs", () => {
  it("handles positionals, spaced values and inline values", () => {
    const args = parseArgs(["main", "feature", "--base=origin/main", "--json"], KNOWN);

    expect(args.positionals).toEqual(["main", "feature"]);
    expect(getString(args, "base")).toBe("origin/main");
    expect(getBool(args, "json")).toBe(true);
  });

  it("supports --flag and --no-flag", () => {
    expect(parseArgs(["--no-color"], KNOWN).flags.get("color")).toBe(false);
    expect(getBool(parseArgs(["--check"], KNOWN), "check")).toBe(true);
  });

  it("rejects typos instead of ignoring them", () => {
    expect(() => parseArgs(["--jsno"], KNOWN)).toThrow(UsageError);
  });

  it("rejects a value-taking option with no value", () => {
    expect(() => parseArgs(["--base"], KNOWN)).toThrow(UsageError);
    expect(() => parseArgs(["--base", "--json"], KNOWN)).toThrow(UsageError);
  });

  it("rejects a non-numeric option value", () => {
    expect(() => getNumber(parseArgs(["--base", "soon"], KNOWN), "base")).toThrow(UsageError);
  });
});

describe("formatting", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1024, "1 KB"],
    [133_372, "130 KB"],
    [23_400_000, "22.3 MB"],
  ])("formats %d bytes", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it("signs deltas", () => {
    expect(formatBytesDelta(1024)).toBe("+1 KB");
    expect(formatBytesDelta(-1024)).toBe("-1 KB");
    expect(formatBytesDelta(0)).toBe("no change");
  });

  it("pluralises and joins", () => {
    expect(plural(1, "package")).toBe("1 package");
    expect(plural(3, "package")).toBe("3 packages");
    expect(listSentence(["a", "b"])).toBe("a and b");
    expect(listSentence(["a", "b", "c", "d", "e"])).toBe("a, b, c, d and 1 more");
  });
});

describe("terminal report", () => {
  it("summarises the change", () => {
    const output = renderTerminal(reportOf(["a@1.0.0", "gone@1.0.0"], ["a@2.0.0", "new@1.0.0"]), {
      all: false,
    });

    expect(output).toContain("main → working tree");
    expect(output).toContain("+1 added");
    expect(output).toContain("-1 removed");
    expect(output).toContain("~1 changed");
    expect(output).toContain("a");
    expect(output).toContain("1.0.0 → 2.0.0");
  });

  it("says so plainly when nothing moved", () => {
    expect(renderTerminal(reportOf(["a@1.0.0"], ["a@1.0.0"]), { all: false })).toContain(
      "No dependency changes.",
    );
  });

  it("truncates long lists unless --all is given", () => {
    const before = Array.from({ length: 40 }, (_, index) => `pkg-${index}@1.0.0`);
    const after = Array.from({ length: 40 }, (_, index) => `pkg-${index}@2.0.0`);

    expect(renderTerminal(reportOf(before, after), { all: false })).toContain("more (--all)");
    expect(renderTerminal(reportOf(before, after), { all: true })).not.toContain("more (--all)");
  });
});

describe("markdown report", () => {
  const output = renderMarkdown(reportOf(["a@1.0.0", "gone@1.0.0"], ["a@2.0.0", "new@1.0.0"]), {
    all: false,
  });

  it("starts with a marker a workflow can find again", () => {
    expect(output.startsWith(COMMENT_MARKER)).toBe(true);
  });

  it("puts long lists behind a disclosure", () => {
    expect(output).toContain("<details>");
    expect(output).toContain("`a`");
  });

  it("escapes pipes so tables survive odd package names", () => {
    const report = reportOf([], [{ name: "we|rd", version: "1.0.0" } as never]);
    expect(renderMarkdown(report, { all: false })).toContain("we\\|rd");
  });
});

describe("json report", () => {
  it("emits a stable, parseable shape", () => {
    const payload = JSON.parse(renderJson(reportOf(["a@1.0.0"], ["a@2.0.0"]))) as {
      schema: number;
      changed: Array<{ name: string; bump: string; breaking: boolean }>;
      summary: { major: number; installSizeDelta: unknown };
    };

    expect(payload.schema).toBe(SCHEMA_VERSION);
    expect(payload.changed[0]).toMatchObject({ name: "a", bump: "major", breaking: true });
    expect(payload.summary.major).toBe(1);
    expect(payload.summary.installSizeDelta).toBeNull();
  });
});
