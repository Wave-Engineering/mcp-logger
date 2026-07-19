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

# Files a consumer actually needs: the entry point, its types, and the manifest.
# npm always includes package.json; README/LICENSE would be added automatically
# if they existed, and should be added HERE if they are ever created.
expected="index.ts
package.json
types.ts"

# npm's stderr is deliberately NOT discarded: `npm pack` failing for a real
# reason (bad manifest, missing file) would otherwise surface in the release
# path as an unexplained non-zero exit with nothing to diagnose it from.
pack_json="$(npm pack --dry-run --json)"
actual="$(printf '%s' "$pack_json" | jq -r '.[0].files[].path' | sort)"

if [[ "$actual" != "$expected" ]]; then
  echo "verify-tarball: tarball contents are not what a consumer should receive" >&2
  echo "--- expected ---" >&2
  echo "$expected" >&2
  echo "--- actual ---" >&2
  echo "$actual" >&2
  echo >&2
  echo "Check the \"files\" allowlist in package.json." >&2
  exit 1
fi

echo "verify-tarball: tarball contains exactly the expected files"
while IFS= read -r packed_file; do
  echo "  ${packed_file}"
done <<< "$actual"
