import { describe, expect, it } from "vitest";

import { diffLockfiles } from "../src/diff.js";
import type { Enrichment } from "../src/enrich/index.js";
import { setColorEnabled } from "../src/render/ansi.js";
import { printable } from "../src/render/format.js";
import { renderMarkdown } from "../src/render/markdown.js";
import { renderTerminal } from "../src/render/terminal.js";
import type { Report } from "../src/report.js";
import { summarize } from "../src/signals.js";
import { lockfileOf } from "./fixtures.js";

setColorEnabled(false);

/**
 * Most of what lockreview prints was written by somebody else: the deprecation
 * notice and the licence come from the package's author through the registry,
 * the advisory summary from OSV, the names and URLs from a lockfile that is
 * itself the thing under review. A tool whose job is to make a reviewer look
 * twice cannot let any of that text format itself.
 */
function reportWith(deprecated: string, name = "thing"): Report {
  const diff = diffLockfiles(lockfileOf([]), lockfileOf([`${name}@1.0.0`]));
  const enrichment: Enrichment = {
    versions: new Map([[`${name}@1.0.0`, { name, version: "1.0.0", deprecated }]]),
    vulns: new Map(),
    vulnsChecked: new Set([`${name}@1.0.0`]),
    online: true,
    truncated: false,
  };

  return {
    lockfile: "package-lock.json",
    kind: "npm",
    before: { label: "main", lockfileVersion: "3" },
    after: { label: "working tree", lockfileVersion: "3" },
    diff,
    summary: summarize(diff, enrichment),
    enrichment,
    notes: [],
  };
}

const ESC = "\u001b";

describe("printable", () => {
  it("shows control characters instead of handing them to the terminal", () => {
    expect(printable(`a${ESC}[2Jb`)).toBe("a\\u001b[2Jb");
    expect(printable("bell\u0007")).toBe("bell\\u0007");
    expect(printable("c1\u009b31m")).toBe("c1\\u009b31m");
  });

  it("makes invisible and direction-changing characters visible", () => {
    // A name that renders as "express" but is not.
    expect(printable("exp\u200bress")).toBe("exp\\u200bress");
    expect(printable("a\u202eb")).toBe("a\\u202eb");
  });

  it("turns line breaks into spaces rather than new lines of output", () => {
    expect(printable("one\ntwo\r\nthree\tfour")).toBe("one two three four");
  });

  it("leaves ordinary text, including non-Latin text, alone", () => {
    expect(printable("Use @babel/core — 使用新版本")).toBe("Use @babel/core — 使用新版本");
  });
});

describe("terminal output", () => {
  it("never writes an escape sequence it was handed", () => {
    // Clears the screen and prints a reassurance that is not lockreview's.
    const output = renderTerminal(reportWith(`${ESC}[2J${ESC}[HNo findings. All clear.`), { all: false });

    expect(output).not.toContain(ESC);
    expect(output).toContain("\\u001b[2J");
  });

  it("does not let a deprecation notice start a new line of the report", () => {
    const output = renderTerminal(reportWith("old\n  ✓ thing@1.0.0 is fine"), { all: false });
    expect(output).not.toMatch(/^\s+✓ thing@1\.0\.0 is fine/m);
  });
});

describe("markdown output", () => {
  const render = (deprecated: string, name?: string) => renderMarkdown(reportWith(deprecated, name), { all: false });

  it("does not turn a deprecation notice into a link", () => {
    const output = render("[Security update required](https://evil.example/login)");

    expect(output).not.toContain("[Security update required](https://evil.example/login)");
    expect(output).toContain("\\[Security update required\\]");
  });

  it("does not embed an image", () => {
    expect(render("![x](https://evil.example/pixel.png)")).not.toContain("![x](");
  });

  it("does not notify anyone it names", () => {
    const output = render("moved to @babel/core, ask @octocat");

    expect(output).not.toMatch(/(^|[^\w])@babel\b/);
    expect(output).not.toMatch(/(^|[^\w])@octocat\b/);
    expect(output).toContain("babel/core");
  });

  it("does not link to an issue in the repository it is posted in", () => {
    expect(render("see #123")).not.toMatch(/(^|[^\w&])#123/);
  });

  it("does not let an entity spell out what was escaped", () => {
    const output = render("&#64;octocat &lt;b&gt;");
    // The ampersand is spelled out, so neither entity is decoded into the
    // character it names.
    expect(output).toContain("&amp;#&#8203;64;octocat");
    expect(output).toContain("&amp;lt;b&amp;gt;");
  });

  it("does not open HTML", () => {
    expect(render('<img src="https://evil.example/x">')).not.toContain("<img");
  });

  it("keeps a backtick in a name inside its code span", () => {
    const output = render("deprecated", "odd`name");
    // The name has to stay one code span: a run of backticks longer than any
    // inside it opens and closes it.
    expect(output).toContain("``odd`name@1.0.0``");
  });

  it("keeps the table intact around a pipe", () => {
    const row = render("a | b").split("\n").find((line) => line.includes("deprecated"));
    expect(row?.split(/(?<!\\)\|/).length).toBe(5);
  });
});
