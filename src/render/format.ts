const UNITS = ["B", "KB", "MB", "GB"] as const;

/** Human byte size: 133372 -> "130 KB". */
export function formatBytes(bytes: number): string {
  const negative = bytes < 0;
  let value = Math.abs(bytes);
  let unit = 0;

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Number(value.toFixed(1));
  return `${negative ? "-" : ""}${rounded} ${UNITS[unit]}`;
}

/** Same as {@link formatBytes} but always carries a sign, for deltas. */
export function formatBytesDelta(bytes: number): string {
  if (bytes === 0) return "no change";
  return bytes > 0 ? `+${formatBytes(bytes)}` : formatBytes(bytes);
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Join a list for prose: "a, b and c". */
export function listSentence(items: readonly string[], limit = 4): string {
  if (items.length === 0) return "";
  if (items.length <= limit) {
    if (items.length === 1) return items[0] as string;
    return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  }
  return `${items.slice(0, limit).join(", ")} and ${items.length - limit} more`;
}

/**
 * Characters a terminal acts on rather than prints, and characters that print
 * as nothing at all: C0 and C1 controls (ESC opens every escape sequence),
 * DEL, soft hyphens and zero-width characters, line and paragraph separators,
 * and the bidirectional controls that reorder what is shown around them.
 */
const INVISIBLE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * Text that came from somewhere else, made safe to print.
 *
 * Most of a report was written by other people: the deprecation notice and the
 * licence by the package's author, the advisory summary by OSV, every name and
 * URL by a lockfile that is itself the change under review. Printed raw, an
 * escape sequence in a deprecation notice can clear the screen and draw a
 * clean report of its own, and a zero-width character can make a name read as
 * one it is not. So nothing is dropped silently: each such character is shown
 * as its `\uXXXX` code, where a reviewer can see it, and line breaks become
 * spaces so a notice cannot start a line that looks like lockreview's own.
 */
export function printable(text: string): string {
  return text
    .replace(/\r\n|[\n\r\t]/g, " ")
    .replace(INVISIBLE, (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`);
}
