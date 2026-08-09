import type { LockDiff } from "./diff.js";
import type { Enrichment } from "./enrich/index.js";
import type { LockKind } from "./lock/types.js";
import type { DiffSummary } from "./signals.js";

/** Where one side of the comparison came from, for the report header. */
export interface Side {
  /** Human label: a git ref, "working tree", or a file path. */
  label: string;
  lockfileVersion: string;
}

export interface Report {
  /** Lockfile filename, e.g. `package-lock.json`. */
  lockfile: string;
  kind: LockKind;
  before: Side;
  after: Side;
  diff: LockDiff;
  summary: DiffSummary;
  enrichment: Enrichment;
  /** Caveats worth printing: offline mode, truncated lookups, and so on. */
  notes: string[];
}

export interface RenderOptions {
  /** List every change instead of the most significant ones. */
  all: boolean;
}

/** Rows shown per section before the report starts summarising. */
export const DEFAULT_LIMIT = 20;

export function limitOf(options: RenderOptions): number {
  return options.all ? Number.POSITIVE_INFINITY : DEFAULT_LIMIT;
}
