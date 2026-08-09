#!/usr/bin/env node
import { createRequire } from "node:module";

import { getBool, hasFlag, parseArgs, UsageError } from "./args.js";
import { DIFF_FLAGS, diffCommand, EXIT, LockdiffError } from "./commands/diff.js";
import { GitError } from "./git.js";
import { LockParseError } from "./lock/types.js";
import { c, setColorEnabled } from "./render/ansi.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const GLOBAL_FLAGS = { help: "boolean", version: "boolean" } as const;

const HELP = `${c.bold("lockdiff")} — read your lockfile diff like a human

${c.bold("Usage")}
  lockdiff [base] [head] [options]

  With no arguments, lockdiff compares this branch against the branch it came
  from — or against HEAD when the lockfile has uncommitted changes.

${c.bold("Options")}
  --base <ref>        Compare against this ref instead of the detected base
  --lockfile <path>   Lockfile to read   (default: the one in this project)
  --markdown          GitHub-flavoured markdown, for a pull request comment
  --json              Machine-readable output
  --all               List every change instead of the most significant ones
  --check             Exit 1 when a finding is at or above --fail-on
  --fail-on <level>   high, warn or info                   (default: high)
  --offline           Skip registry and advisory lookups
  --registry <url>    npm registry        (default: $npm_config_registry)
  --timeout <secs>    Budget for all network lookups            (default: 20)
  --no-color          Disable colour
  --help, --version

${c.bold("Examples")}
  lockdiff                                  ${c.dim("# what did this branch change?")}
  lockdiff main                             ${c.dim("# against a branch")}
  lockdiff main feature/upgrade-vite
  lockdiff before.json after.json           ${c.dim("# two files")}
  lockdiff --markdown >> "$GITHUB_STEP_SUMMARY"
  lockdiff --check --fail-on warn           ${c.dim("# gate a pull request")}

${c.bold("Exit codes")}
  0 clean   1 findings (--check)   2 bad usage   3 could not run
`;

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { ...GLOBAL_FLAGS, ...DIFF_FLAGS });

  if (hasFlag(args, "color")) setColorEnabled(getBool(args, "color"));

  if (args.flags.get("version") === true) {
    process.stdout.write(`${version}\n`);
    return EXIT.ok;
  }
  if (args.flags.get("help") === true) {
    process.stdout.write(HELP);
    return EXIT.ok;
  }

  return diffCommand(args, version);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = EXIT.usage;
      return;
    }
    if (error instanceof LockdiffError || error instanceof LockParseError) {
      process.stderr.write(`${c.red("lockdiff:")} ${error.message}\n`);
      process.exitCode = EXIT.failed;
      return;
    }
    if (error instanceof GitError) {
      process.stderr.write(`${c.red("git:")} ${error.message}\n`);
      process.exitCode = EXIT.failed;
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${c.red("Error:")} ${message}\n`);
    if (process.env.LOCKDIFF_DEBUG && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = EXIT.failed;
  });
