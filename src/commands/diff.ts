import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

import { getBool, getNumber, getString, type ParsedArgs, UsageError } from "../args.js";
import { diffLockfiles } from "../diff.js";
import { DEFAULT_ENRICH_OPTIONS, enrichDiff, EMPTY_ENRICHMENT } from "../enrich/index.js";
import {
  detectBaseRef,
  hasLocalChanges,
  isGitRepository,
  mergeBase,
  readFileAtRef,
  refExists,
  shortSha,
} from "../git.js";
import { findLockfile, findUnsupportedLockfile, parseLockfile } from "../lock/parse.js";
import { emptyLockfile, type Lockfile } from "../lock/types.js";
import { renderJson } from "../render/json.js";
import { renderMarkdown } from "../render/markdown.js";
import { renderTerminal } from "../render/terminal.js";
import type { Report, RenderOptions } from "../report.js";
import { summarize, type SignalLevel } from "../signals.js";

export const DIFF_FLAGS = {
  lockfile: "string",
  base: "string",
  json: "boolean",
  markdown: "boolean",
  all: "boolean",
  check: "boolean",
  "fail-on": "string",
  offline: "boolean",
  registry: "string",
  timeout: "string",
  color: "boolean",
} as const;

export class LockdiffError extends Error {}

/** Exit codes, documented in the README so CI can branch on them. */
export const EXIT = { ok: 0, findings: 1, usage: 2, failed: 3 } as const;

interface Side {
  label: string;
  read: () => string | undefined;
}

export async function diffCommand(args: ParsedArgs, version: string): Promise<number> {
  const cwd = process.cwd();
  const lockfilePath = resolveLockfilePath(args, cwd);
  const lockfileName = basename(lockfilePath);

  const [beforeSide, afterSide] = resolveSides(args, lockfilePath, cwd);

  const beforeText = beforeSide.read();
  const afterText = afterSide.read();

  if (afterText === undefined) {
    throw new LockdiffError(`Could not read ${lockfileName} at ${afterSide.label}.`);
  }

  const after = parseLockfile(lockfileName, afterText);
  // A missing file on the old side means the branch introduces the lockfile;
  // everything in it is genuinely new rather than an error.
  const before =
    beforeText === undefined ? emptyLockfile(after.kind) : parseLockfile(lockfileName, beforeText);

  const diff = diffLockfiles(before, after);

  const offline = getBool(args, "offline") || process.env.LOCKDIFF_OFFLINE === "1";
  const enrichment = await enrichDiff(diff, {
    ...DEFAULT_ENRICH_OPTIONS,
    offline,
    registry: getString(args, "registry") ?? process.env.npm_config_registry ?? DEFAULT_ENRICH_OPTIONS.registry,
    timeoutMs: timeoutMs(args),
    userAgent: `lockdiff/${version} (+https://github.com/vineetdev02/lockdiff)`,
  });

  const summary = summarize(diff, enrichment);

  const report: Report = {
    lockfile: lockfileName,
    kind: after.kind,
    before: { label: beforeSide.label, lockfileVersion: before.lockfileVersion },
    after: { label: afterSide.label, lockfileVersion: after.lockfileVersion },
    diff,
    summary,
    enrichment,
    notes: buildNotes(diff, enrichment, offline),
  };

  const options: RenderOptions = { all: getBool(args, "all") };
  process.stdout.write(renderOutput(args, report, options));

  return exitCodeFor(args, report);
}

function renderOutput(args: ParsedArgs, report: Report, options: RenderOptions): string {
  if (getBool(args, "json")) return renderJson(report);
  if (getBool(args, "markdown")) return renderMarkdown(report, options);
  return renderTerminal(report, options);
}

function exitCodeFor(args: ParsedArgs, report: Report): number {
  if (!getBool(args, "check")) return EXIT.ok;

  const threshold = failOnLevel(args);
  const order: SignalLevel[] = ["high", "warn", "info"];
  const limit = order.indexOf(threshold);

  const triggered = report.summary.signals.some((signal) => order.indexOf(signal.level) <= limit);
  return triggered ? EXIT.findings : EXIT.ok;
}

function failOnLevel(args: ParsedArgs): SignalLevel {
  const value = getString(args, "fail-on") ?? "high";
  if (value === "high" || value === "warn" || value === "info") return value;
  throw new UsageError(`Option "--fail-on" expects high, warn or info, got "${value}".`);
}

function timeoutMs(args: ParsedArgs): number {
  const seconds = getNumber(args, "timeout");
  if (seconds === undefined) return DEFAULT_ENRICH_OPTIONS.timeoutMs;
  if (seconds <= 0) throw new UsageError(`Option "--timeout" expects a positive number of seconds.`);
  return Math.round(seconds * 1000);
}

function resolveLockfilePath(args: ParsedArgs, cwd: string): string {
  const explicit = getString(args, "lockfile");
  if (explicit) {
    if (!existsSync(explicit)) throw new LockdiffError(`No such file: ${explicit}`);
    return explicit;
  }

  // `lockdiff before.json after.json` is self-contained: both sides are on
  // disk, so there is no project lockfile to go looking for. The head file
  // names the format both sides are parsed as.
  const files = args.positionals.filter(isExistingFile);
  if (args.positionals.length === 2 && files.length === 2) return files[1] as string;

  const found = findLockfile(cwd);
  if (found) return found;

  const unsupported = findUnsupportedLockfile(cwd);
  if (unsupported) {
    throw new LockdiffError(
      `Found ${basename(unsupported)}, which lockdiff cannot read yet. ` +
        `Supported: package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, yarn.lock.`,
    );
  }

  throw new LockdiffError(
    "No lockfile found here or in any parent directory. Pass one with --lockfile.",
  );
}

/**
 * Work out the two sides to compare, mirroring `git diff`:
 *
 *   lockdiff                 base branch → working tree
 *   lockdiff main            main        → working tree
 *   lockdiff main feature    main        → feature
 *   lockdiff old.json new.json           two files on disk
 */
function resolveSides(args: ParsedArgs, lockfilePath: string, cwd: string): [Side, Side] {
  const positionals = args.positionals;

  if (positionals.length > 2) {
    throw new UsageError("Expected at most two arguments: a base and a head.");
  }

  if (positionals.length === 2) {
    return [
      sideFor(positionals[0] as string, lockfilePath, cwd),
      sideFor(positionals[1] as string, lockfilePath, cwd),
    ];
  }

  const workingTree: Side = {
    label: "working tree",
    read: () => readFileSync(lockfilePath, "utf8"),
  };

  if (positionals.length === 1) {
    return [sideFor(positionals[0] as string, lockfilePath, cwd), workingTree];
  }

  const explicitBase = getString(args, "base");
  if (explicitBase) {
    return [refSide(explicitBase, lockfilePath, cwd), workingTree];
  }

  return automaticSides(lockfilePath, cwd, workingTree);
}

/**
 * With no arguments, answer the question the reviewer actually has: what did
 * this branch do to the lockfile? Uncommitted edits win, then the branch point
 * against the base branch, then the last commit.
 */
function automaticSides(lockfilePath: string, cwd: string, workingTree: Side): [Side, Side] {
  if (!isGitRepository(cwd)) {
    throw new LockdiffError(
      "Not a git repository, so there is nothing to compare against. " +
        "Pass two lockfiles: lockdiff old.json new.json",
    );
  }

  if (hasLocalChanges(lockfilePath, cwd)) {
    return [refSide("HEAD", lockfilePath, cwd), workingTree];
  }

  const base = detectBaseRef(cwd);
  if (base) {
    const forkPoint = mergeBase(base, "HEAD", cwd);
    const head = shortSha("HEAD", cwd);
    if (forkPoint && shortSha(forkPoint, cwd) !== head) {
      return [
        { label: base, read: () => readFileAtRef(forkPoint, lockfilePath, cwd) },
        refSide("HEAD", lockfilePath, cwd),
      ];
    }
  }

  if (refExists("HEAD~1", cwd)) {
    return [refSide("HEAD~1", lockfilePath, cwd), refSide("HEAD", lockfilePath, cwd)];
  }

  throw new LockdiffError(
    "Nothing to compare: the lockfile is unchanged and this branch has no commits of its own. " +
      "Pass a ref, for example `lockdiff main`.",
  );
}

/** A positional argument is a path if it exists on disk, otherwise a git ref. */
function sideFor(value: string, lockfilePath: string, cwd: string): Side {
  if (isExistingFile(value)) {
    return { label: value, read: () => readFileSync(value, "utf8") };
  }
  return refSide(value, lockfilePath, cwd);
}

function isExistingFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function refSide(ref: string, lockfilePath: string, cwd: string): Side {
  if (!isGitRepository(cwd)) {
    throw new LockdiffError(`"${ref}" is not a file, and this is not a git repository.`);
  }
  if (!refExists(ref, cwd)) {
    throw new LockdiffError(`"${ref}" is neither a file nor a git ref in this repository.`);
  }
  return { label: ref, read: () => readFileAtRef(ref, lockfilePath, cwd) };
}

function buildNotes(
  diff: ReturnType<typeof diffLockfiles>,
  enrichment: typeof EMPTY_ENRICHMENT,
  offline: boolean,
): string[] {
  const notes: string[] = [];
  const touched = diff.added.length + diff.changed.length + diff.removed.length;

  if (offline) {
    notes.push("Offline: install scripts, maintainers, advisories and sizes were not checked.");
  } else if (!enrichment.online && touched > 0) {
    notes.push(
      "The npm registry could not be reached, so only lockfile-level checks ran. Use --offline to silence this.",
    );
  }

  if (enrichment.truncated) {
    notes.push("This diff is large: registry checks stopped at the lookup budget.");
  }

  return notes;
}
