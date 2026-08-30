const CODES = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
} as const;

export type ColorName = keyof typeof CODES;

let enabled = detectColorSupport();

function detectColorSupport(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== "0";
  return Boolean(process.stdout.isTTY);
}

export function setColorEnabled(value: boolean): void {
  enabled = value;
}

export function colorEnabled(): boolean {
  return enabled;
}

function wrap(name: ColorName, text: string): string {
  return enabled ? `${CODES[name]}${text}${CODES.reset}` : text;
}

export const c = {
  bold: (text: string) => wrap("bold", text),
  dim: (text: string) => wrap("dim", text),
  red: (text: string) => wrap("red", text),
  green: (text: string) => wrap("green", text),
  yellow: (text: string) => wrap("yellow", text),
  blue: (text: string) => wrap("blue", text),
  magenta: (text: string) => wrap("magenta", text),
  cyan: (text: string) => wrap("cyan", text),
  gray: (text: string) => wrap("gray", text),
};

/** Visible length, ignoring ANSI escapes. */
export function displayWidth(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

export function padEnd(text: string, width: number): string {
  const padding = width - displayWidth(text);
  return padding > 0 ? text + " ".repeat(padding) : text;
}

export function padStart(text: string, width: number): string {
  const padding = width - displayWidth(text);
  return padding > 0 ? " ".repeat(padding) + text : text;
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

export function terminalWidth(max = 120): number {
  const columns = process.stdout.columns ?? 100;
  return Math.max(60, Math.min(columns, max));
}
