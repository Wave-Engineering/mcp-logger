#!/usr/bin/env bash
#
# verify-tarball.sh — assert the published tarball contains only what a consumer
# imports, by packing it and reading the result.
#
# WHY BEHAVIOUR AND NOT CONFIG: asserting that package.json has the right `files`
# array proves the config is what we wrote, not that npm packs what we expect.
# The two diverge — `files` interacts with .gitignore, .npmignore, and npm's
# always-include list. A tarball nobody inspects is indistinguishable from a
# correct one, so this inspects it.
#
# WHAT THIS DOES NOT COVER: it checks file NAMES, not contents. It cannot tell
# you the published index.ts is the one you tested — that is what the version
# guard and the gate ahead of it are for.

set -euo pipefail

require=0
[[ "${1:-}" == "--require" ]] && require=1

if ! command -v npm >/dev/null 2>&1; then
  if [[ "$require" -eq 1 ]]; then
    echo "verify-tarball: npm not found and --require was given" >&2
    exit 2
  fi
  # Loud, and named SKIPPED rather than reported as a pass. A skip that reads
  # like a pass is how a check that never ran gets counted as one that did.
  echo "verify-tarball: SKIPPED — npm not found (pass --require to make this fatal)" >&2
  exit 0
fi

# Same refusal as release-guard.sh applies to jq: a check that cannot parse the
# pack output must say so rather than produce an empty list and compare it.
# Without this the failure is still closed (pipefail), but it surfaces as a bare
# non-zero exit with no explanation.
if ! command -v jq >/dev/null 2>&1; then
  echo "verify-tarball: jq not found — cannot read the pack manifest" >&2
  exit 2
fi

# Files a consumer actually needs: the entry point, its types, the manifest, and
# the README that renders on the package page.
#
# `files` in package.json does NOT control all of these. npm ALWAYS includes
# package.json, README, LICENSE and CHANGELOG regardless of the allowlist — so
# creating any of those changes the tarball without touching `files` at all.
# That is how this list went stale: a README was added and this check failed,
# correctly, on a change that never edited the allowlist it points at.
#
# If you add LICENSE or CHANGELOG, add them here too. The check will tell you.
#
# ORDER IS C-COLLATION, not dictionary order, and that is deliberate. Comparing
# a sorted list against a fixed string makes the comparison depend on the sort
# LOCALE: en_US.UTF-8 folds case and yields index/package/README/types, while
# the C locale sorts by byte and puts README first. This check previously passed
# on a developer machine and failed in CI on byte-identical, correct input.
# Both sides are pinned to LC_ALL=C below so the result cannot depend on where
# it runs.
expected="README.md
index.ts
package.json
types.ts"

# npm's stderr is deliberately NOT discarded: `npm pack` failing for a real
# reason (bad manifest, missing file) would otherwise surface in the release
# path as an unexplained non-zero exit with nothing to diagnose it from.
pack_json="$(npm pack --dry-run --json)"
actual="$(printf '%s' "$pack_json" | jq -r '.[0].files[].path' | LC_ALL=C sort)"

if [[ "$actual" != "$expected" ]]; then
  echo "verify-tarball: tarball contents are not what a consumer should receive" >&2
  echo "--- expected ---" >&2
  echo "$expected" >&2
  echo "--- actual ---" >&2
  echo "$actual" >&2
  echo >&2
  echo "Two things can cause this, and only one is the allowlist:" >&2
  echo "  1. the \"files\" allowlist in package.json changed" >&2
  echo "  2. a file npm ALWAYS packs was added or removed — README, LICENSE," >&2
  echo "     CHANGELOG, package.json — which \"files\" does not govern at all" >&2
  echo "If the new contents are correct, update \$expected in this script." >&2
  exit 1
fi

echo "verify-tarball: tarball contains exactly the expected files"
while IFS= read -r packed_file; do
  echo "  ${packed_file}"
done <<< "$actual"
