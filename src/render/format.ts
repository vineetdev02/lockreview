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
