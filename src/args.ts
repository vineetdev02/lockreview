export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

export class UsageError extends Error {}

/**
 * Minimal argv parser: `--flag`, `--no-flag`, `--key value`, `--key=value`,
 * plus single-dash aliases. Unknown flags are rejected so typos surface
 * immediately instead of being silently ignored.
 */
export function parseArgs(argv: string[], known: Record<string, "string" | "boolean">): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    const [rawName, inlineValue] = splitOnce(token.replace(/^--?/, ""), "=");
    let name = rawName;
    let negated = false;

    if (!(name in known) && name.startsWith("no-") && known[name.slice(3)] === "boolean") {
      name = name.slice(3);
      negated = true;
    }

    const kind = known[name];
    if (!kind) throw new UsageError(`Unknown option "${token}". Run \`lockdiff --help\`.`);

    if (kind === "boolean") {
      if (inlineValue !== undefined) throw new UsageError(`Option "--${name}" does not take a value.`);
      flags.set(name, !negated);
      continue;
    }

    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`Option "--${name}" needs a value.`);
    }
    if (inlineValue === undefined) index += 1;
    flags.set(name, value);
  }

  return { positionals, flags };
}

export function getString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function getBool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

export function getNumber(args: ParsedArgs, name: string): number | undefined {
  const value = getString(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new UsageError(`Option "--${name}" expects a number, got "${value}".`);
  return parsed;
}

function splitOnce(text: string, separator: string): [string, string | undefined] {
  const index = text.indexOf(separator);
  if (index === -1) return [text, undefined];
  return [text.slice(0, index), text.slice(index + 1)];
}
