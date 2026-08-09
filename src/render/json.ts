import type { PackageChange } from "../diff.js";
import type { Report } from "../report.js";

/** Bumped when a field is removed or changes meaning. */
export const SCHEMA_VERSION = 1;

interface JsonChange {
  name: string;
  from?: string;
  to?: string;
  bump?: string;
  breaking?: boolean;
  dev?: boolean;
}

/** Render the report as stable JSON for scripts and other tools. */
export function renderJson(report: Report): string {
  const { summary } = report;

  const payload = {
    schema: SCHEMA_VERSION,
    lockfile: report.lockfile,
    kind: report.kind,
    before: report.before,
    after: report.after,
    summary: {
      added: summary.added,
      removed: summary.removed,
      changed: summary.changed,
      major: summary.major,
      minor: summary.minor,
      patch: summary.patch,
      downgrades: summary.downgrades,
      installedBefore: summary.entriesBefore,
      installedAfter: summary.entriesAfter,
      installSizeDelta: summary.size
        ? { bytes: summary.size.bytes, known: summary.size.known, total: summary.size.total }
        : null,
    },
    signals: summary.signals.map((signal) => ({
      level: signal.level,
      rule: signal.rule,
      package: signal.package,
      title: signal.title,
      detail: signal.detail ?? null,
      count: signal.count ?? 1,
    })),
    added: report.diff.added.map(toJsonChange),
    removed: report.diff.removed.map(toJsonChange),
    changed: report.diff.changed.map(toJsonChange),
    notes: report.notes,
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

function toJsonChange(change: PackageChange): JsonChange {
  return {
    name: change.name,
    from: change.from,
    to: change.to,
    bump: change.bump,
    breaking: change.breaking,
    dev: change.devOnly,
  };
}
