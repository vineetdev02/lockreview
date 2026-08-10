import type { PackageChange } from "../diff.js";
import { limitOf, type RenderOptions, type Report } from "../report.js";
import type { Signal, SignalLevel } from "../signals.js";
import { c, padEnd, terminalWidth, truncate } from "./ansi.js";
import { formatBytesDelta, plural } from "./format.js";

const LEVEL_MARK: Record<SignalLevel, string> = { high: "✗", warn: "!", info: "·" };

const BUMP_LABEL: Record<string, string> = {
  major: "major",
  minor: "minor",
  patch: "patch",
  prerelease: "pre",
  downgrade: "down",
  other: "",
};

/** Render the full terminal report. */
export function renderTerminal(report: Report, options: RenderOptions): string {
  const width = terminalWidth();
  const lines: string[] = [];

  lines.push("", header(report), "");

  if (isUnchanged(report)) {
    lines.push(
      `  ${c.dim("No dependency changes.")}  ${c.dim(`${report.summary.entriesAfter} packages installed.`)}`,
    );
    for (const note of report.notes) lines.push("", c.dim(`  ${note}`));
    lines.push("");
    return `${lines.join("\n")}\n`;
  }

  lines.push(...summaryBlock(report));

  if (report.summary.signals.length > 0) {
    lines.push("", ...signalsBlock(report.summary.signals, options, width));
  }

  if (report.diff.changed.length > 0) {
    lines.push("", ...changedBlock(report.diff.changed, options, width));
  }

  if (report.diff.added.length > 0) {
    lines.push("", ...packageListBlock("Added", report.diff.added, "green", options, width));
  }

  if (report.diff.removed.length > 0) {
    lines.push("", ...packageListBlock("Removed", report.diff.removed, "red", options, width));
  }

  for (const note of report.notes) {
    lines.push("", c.dim(`  ${note}`));
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function header(report: Report): string {
  const versions =
    report.before.lockfileVersion === report.after.lockfileVersion
      ? `${report.kind} v${report.after.lockfileVersion}`
      : `${report.kind} v${report.before.lockfileVersion} → v${report.after.lockfileVersion}`;

  return [
    c.bold("lockreview"),
    " ",
    c.cyan(report.lockfile),
    "  ",
    c.dim(`${report.before.label} → ${report.after.label}`),
    "  ",
    c.dim(`· ${versions}`),
  ].join("");
}

function summaryBlock(report: Report): string[] {
  const { summary } = report;
  const lines: string[] = [];

  const counts = [
    summary.added > 0 ? c.green(`+${summary.added} added`) : "",
    summary.removed > 0 ? c.red(`-${summary.removed} removed`) : "",
    summary.changed > 0 ? c.yellow(`~${summary.changed} changed`) : "",
  ].filter(Boolean);

  const totals = `${summary.entriesBefore} → ${summary.entriesAfter} installed packages`;
  lines.push(`  ${counts.length > 0 ? counts.join("   ") : c.dim("no changes")}   ${c.dim(totals)}`);

  const kinds = [
    summary.major > 0 ? `${summary.major} major` : "",
    summary.minor > 0 ? `${summary.minor} minor` : "",
    summary.patch > 0 ? `${summary.patch} patch` : "",
    summary.downgrades > 0 ? c.yellow(`${summary.downgrades} downgraded`) : "",
  ].filter(Boolean);

  const size = summary.size
    ? `install size ${formatBytesDelta(summary.size.bytes)}${
        summary.size.known < summary.size.total
          ? c.dim(` (${summary.size.known}/${summary.size.total} known)`)
          : ""
      }`
    : "";

  if (kinds.length > 0) {
    lines.push(`  ${kinds.join("   ")}${size ? `   ${c.dim("·")}   ${size}` : ""}`);
  } else if (size) {
    lines.push(`  ${size}`);
  }

  return lines;
}

function signalsBlock(signals: Signal[], options: RenderOptions, width: number): string[] {
  const limit = limitOf(options);
  const shown = signals.slice(0, limit);
  const lines = [c.bold("Worth a look")];

  for (const signal of shown) {
    const mark = colorFor(signal.level)(LEVEL_MARK[signal.level]);
    const name = c.bold(truncate(signal.package, 44));
    lines.push(`  ${mark}  ${name}`);
    lines.push(`     ${colorFor(signal.level)(truncate(signal.title, width - 6))}`);
    if (signal.detail) {
      for (const line of wrap(signal.detail, width - 8)) lines.push(c.dim(`     ${line}`));
    }
  }

  if (signals.length > shown.length) {
    lines.push(c.dim(`  … ${signals.length - shown.length} more (--all)`));
  }

  return lines;
}

function changedBlock(changes: PackageChange[], options: RenderOptions, width: number): string[] {
  const limit = limitOf(options);
  const shown = changes.slice(0, limit);
  const nameWidth = Math.min(
    Math.max(...shown.map((change) => change.name.length), 4),
    Math.max(20, Math.floor(width / 3)),
  );

  const lines = [c.bold(`Changed  ${c.dim(plural(changes.length, "package"))}`)];

  for (const change of shown) {
    const kind = BUMP_LABEL[change.bump ?? "other"] ?? "";
    const label = padEnd(kind ? colorForBump(change)(kind) : c.dim("—"), 6);
    const name = padEnd(truncate(change.name, nameWidth), nameWidth);
    const move = `${c.dim(change.from ?? "?")} → ${c.bold(change.to ?? "?")}`;
    const dev = change.devOnly ? c.dim("  (dev)") : "";
    lines.push(`  ${label}  ${name}  ${move}${dev}`);
  }

  if (changes.length > shown.length) {
    lines.push(c.dim(`  … ${changes.length - shown.length} more (--all)`));
  }

  return lines;
}

function packageListBlock(
  title: string,
  changes: PackageChange[],
  color: "green" | "red",
  options: RenderOptions,
  width: number,
): string[] {
  const limit = limitOf(options);
  const shown = changes.slice(0, limit);
  const paint = color === "green" ? c.green : c.red;

  const lines = [c.bold(`${title}  ${c.dim(plural(changes.length, "package"))}`)];
  const entries = shown.map((change) => {
    const version = change.kind === "removed" ? change.from : change.to;
    return `${change.name}@${version ?? "?"}${change.devOnly ? " (dev)" : ""}`;
  });

  for (const line of wrap(entries.join(", "), width - 4)) {
    lines.push(`  ${paint(line)}`);
  }

  if (changes.length > shown.length) {
    lines.push(c.dim(`  … ${changes.length - shown.length} more (--all)`));
  }

  return lines;
}

function isUnchanged(report: Report): boolean {
  return (
    report.diff.added.length === 0 &&
    report.diff.removed.length === 0 &&
    report.diff.changed.length === 0
  );
}

function colorFor(level: SignalLevel): (text: string) => string {
  if (level === "high") return c.red;
  if (level === "warn") return c.yellow;
  return c.gray;
}

function colorForBump(change: PackageChange): (text: string) => string {
  if (change.bump === "downgrade") return c.yellow;
  if (change.breaking) return c.red;
  if (change.bump === "major") return c.red;
  return c.dim;
}

/** Wrap plain text to a width, breaking on spaces where possible. */
function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];

  const lines: string[] = [];
  let current = "";

  for (const word of text.split(/\s+/)) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }

  if (current.length > 0) lines.push(current);
  return lines;
}
