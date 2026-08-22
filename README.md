# lockreview

[![npm version](https://img.shields.io/npm/v/lockreview?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/lockreview)
[![CI](https://github.com/vineetdev02/lockreview/actions/workflows/ci.yml/badge.svg)](https://github.com/vineetdev02/lockreview/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/lockreview?color=5fa04e&logo=node.js&logoColor=white)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/lockreview?color=blue)](./LICENSE)

**Read your lockfile diff like a human.** A 4000-line `package-lock.json` diff, turned into what actually changed — and the handful of lines worth a second look.

Nobody reviews a lockfile. GitHub shows four thousand lines of JSON, the reviewer types LGTM, and a dependency you have never heard of arrives with a `postinstall` script. That is not carelessness — the diff is genuinely unreadable, so the only rational move is to skip it.

`lockreview` reads it for you. It works on npm, pnpm and yarn, needs no signup and no server, and never installs anything.

```
npx lockreview
```

## What you get

```
lockreview package-lock.json  bdba132~1 → bdba132  · npm v3

  +3 added   -4 removed   ~107 changed   715 → 707 installed packages
  7 major   61 minor   36 patch   ·   install size -22.3 MB (113/114 known)

Worth a look
  !  range-parser@1.2.1 → 1.3.0
     2 new accounts can publish this package: blakeembrey, ulisesgascon
     Maintainers were dougwilson, jonathanong, jongleberry, tjholowaychuk; now
     blakeembrey, dougwilson, jonathanong, jongleberry, tjholowaychuk, ulisesgascon.
  ·  4 packages
     no longer affected by known advisories
     js-yaml, ws, brace-expansion, fast-uri
  ·  meow
     now installed at 2 different versions (was 1)
     13.2.0, 14.1.0

Changed  107 packages
  major   @simple-libs/stream-utils          1.2.0 → 2.0.0  (dev)
  major   @types/node                        25.9.1 → 26.0.1  (dev)
  major   conventional-changelog-angular     8.3.1 → 9.2.0  (dev)
  major   meow                               13.2.0 → 14.1.0  (dev)
  minor   @commitlint/cli                    21.0.2 → 21.2.0  (dev)
  … 87 more (--all)

Added  3 packages
  @conventional-changelog/template@1.2.0 (dev), @humanfs/types@0.15.0 (dev),
  @peculiar/utils@2.0.3 (dev)

Removed  4 packages
  array-ify@1.0.0 (dev), compare-func@2.0.0 (dev), dot-prop@5.3.0 (dev), is-obj@2.0.0 (dev)
```

That is a real commit from `axios`. The interesting line is the one a human would never have found: `range-parser` changed hands between the two versions this branch spans.

## What it checks

Everything below is derived from the lockfile itself plus two public, unauthenticated sources: the npm registry and [OSV.dev](https://osv.dev).

| | Finding | Why it matters |
| :-: | --- | --- |
| 🔴 | An install script appears where there was none | The package now executes code during `npm install`, including on every CI machine |
| 🔴 | A release published by someone who did not maintain the previous version | The shape of most npm account takeovers |
| 🔴 | The download host changed | A dependency now comes from somewhere else |
| 🔴 | A licence changed to a non-permissive one | AGPL, BUSL, SSPL and friends, arriving quietly |
| 🟡 | A new account can publish the package | More people can now ship code into your build |
| 🟡 | A known advisory the branch introduces | Only what this change adds, not pre-existing debt |
| 🟡 | A newly added dependency runs install scripts | Worth knowing before it lands |
| 🟡 | A version moved backwards | Usually an accidental revert from a stale branch |
| 🟡 | A deprecated version, or a missing integrity hash | |
| 🟡 | A dependency installed straight from GitHub or a git URL | Not a registry, not immutable |
| ⚪ | Advisories the branch *fixes* | The good news, which no other tool tells you |
| ⚪ | Packages that gained duplicate copies | Where install size quietly goes |

**What it deliberately does not do.** It is a report, not a firewall. It cannot see what a package does at runtime, it will not catch a malicious version that nobody has reported yet, and passing `lockreview` is not a security guarantee. It reads public metadata and tells you what changed. When a check has no data — an offline run, a registry timeout, a lockfile format that does not record install scripts — it says nothing rather than reporting "clean".

Two more things it refuses to do, because a noisy tool gets muted: a private registry is not treated as suspicious, and npm Trusted Publishing (`GitHub Actions` as the publisher) is treated as the hardening measure it is, not as an ownership change. When one event touches many packages, it is reported once with a count.

## In CI

The zero-configuration version. No permissions, no token, no comment — the report lands on the workflow summary page:

```yaml
- run: npx lockreview --markdown >> "$GITHUB_STEP_SUMMARY"
```

The full version, which posts the report on the pull request and keeps a single comment up to date:

```yaml
name: lockreview

on:
  pull_request:
    paths:
      - "**/package-lock.json"
      - "**/pnpm-lock.yaml"
      - "**/yarn.lock"

permissions:
  contents: read
  pull-requests: write

jobs:
  lockreview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # lockreview needs the base branch to compare against
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx lockreview --markdown > lockreview.md
      - run: gh pr comment "$PR" --body-file lockreview.md --edit-last --create-if-none
        env:
          GH_TOKEN: ${{ github.token }}
          PR: ${{ github.event.number }}
```

To fail the check instead of only reporting:

```yaml
      - run: npx lockreview --check --fail-on warn
```

On GitHub Actions `lockreview` picks up `GITHUB_BASE_REF` on its own, so no `--base` is needed.

## Usage

```
lockreview [base] [head] [options]
```

With no arguments it answers "what did this branch do to the lockfile?" — comparing against the branch you forked from, or against `HEAD` when the lockfile has uncommitted changes.

```bash
lockreview                              # this branch versus its base
lockreview main                         # against a branch, like `git diff main`
lockreview v1.2.0 v1.3.0                # between two tags
lockreview before.json after.json       # two files, no git required
lockreview --json | jq '.signals'       # for scripts
```

| Option | |
| --- | --- |
| `--base <ref>` | Compare against this ref instead of the detected base |
| `--lockfile <path>` | Lockfile to read (default: the one in this project) |
| `--markdown` | GitHub-flavoured markdown, for a pull request comment |
| `--json` | Machine-readable output, with a stable schema |
| `--all` | List every change instead of the most significant ones |
| `--check` | Exit 1 when a finding is at or above `--fail-on` |
| `--fail-on <level>` | `high`, `warn` or `info` (default: `high`) |
| `--ignore <rules>` | Rules `--check` should not fail on, comma-separated |
| `--offline` | Skip registry and advisory lookups |
| `--registry <url>` | npm registry (default: `$npm_config_registry`) |
| `--timeout <secs>` | Budget for all network lookups (default: 20) |
| `--no-color` | Disable colour |

**Exit codes.** `0` clean · `1` findings, with `--check` · `2` bad usage · `3` could not run.

### Ignoring a rule

A gate you cannot argue with is a gate somebody deletes. If your team has decided install scripts are acceptable, say so once instead of dropping `--check`:

```bash
lockreview --check --ignore install-script
lockreview --check --fail-on warn --ignore install-script,duplicates
```

Ignoring is whole-rule rather than per-package, because a team that accepts install scripts has made one decision — re-listing every package that has one is how an allowlist rots into a rubber stamp.

An ignored finding is still printed. It stops failing the build, and the report gains a line saying how many were let through and under which rule, so the escape hatch stays visible to whoever reads the pull request. A rule name that does not exist is a usage error, not a silent no-op.

The rule ids are `deprecated`, `downgrade`, `duplicates`, `install-script`, `integrity`, `license`, `maintainer`, `source`, `vulnerability` and `vulnerability-fixed`. They also appear as `rule` on every signal in `--json`.

## Supported lockfiles

| | |
| --- | --- |
| npm | `package-lock.json` and `npm-shrinkwrap.json`, lockfileVersion 1, 2 and 3 |
| pnpm | `pnpm-lock.yaml`, lockfileVersion 5, 6 and 9 |
| yarn | `yarn.lock`, Classic (v1) and Berry (v2+) |

npm lockfiles record the most: install scripts and licences come straight out of the file. For pnpm and yarn that information comes from the registry instead, so those checks need a network run.

Bun and Deno lockfiles are not supported yet.

## What leaves your machine

With network lookups enabled, `lockreview` requests:

- one small manifest per changed package version from the npm registry — the same public documents `npm install` reads, about 2–8 KB each;
- one batched query to `api.osv.dev` listing the package names and versions the diff touches.

Nothing else is sent, nothing is uploaded, and there is no account. `--offline` turns both off and everything derived purely from the lockfile still works.

## Requirements

Node 20 or newer. One dependency (`yaml`). `git` only when comparing refs.

## Related

[`critpath`](https://github.com/vineetdev02/critpath) — find out why your CI is slow. Waterfall, critical path and queue time for GitHub Actions, same terminal-first, no-signup approach.

## License

MIT
