#!/usr/bin/env bash
#
# release-guard.sh — refuse to publish when the git tag disagrees with the
# version in package.json.
#
# WHY THIS EXISTS: `npm publish` reads the version from package.json and ignores
# the tag completely. Tagging v1.2.0 on a tree that declares 1.1.0 publishes
# 1.1.0 and reports SUCCESS — the wrong version ships, the job is green, and the
# tag is a lie that nothing downstream can detect. No other step compares the
# two, so without this guard the mistake is invisible until someone installs it.
#
# WHAT THIS DOES NOT COVER — the limits belong here, next to the mechanism,
# because this is where someone cutting a release is standing. See docs/RELEASE.md.
#   - It does not check whether that version is ALREADY published. npm rejects a
#     duplicate, but late and with a registry error rather than this message.
#   - It does not make consumers pick the release up. They pin by integrity hash
#     in their lockfiles; a caret range alone will not move them.
#   - It does not judge whether the version number is SEMANTICALLY right for the
#     change. It compares two strings. Choosing major vs minor is a human call.

set -euo pipefail

tag_ref="${1:-}"
if [[ -z "$tag_ref" ]]; then
  echo "release-guard: no tag argument given" >&2
  echo "usage: release-guard.sh <tag>    e.g. v1.1.0 or refs/tags/v1.1.0" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  # Refusing rather than falling back to a grep/sed parse: a guard that
  # misreads the version is worse than one that admits it cannot run.
  echo "release-guard: jq not found — refusing to guess the package version" >&2
  exit 2
fi

# Accept either the bare tag (v1.1.0) or a full ref (refs/tags/v1.1.0).
tag="${tag_ref#refs/tags/}"
tag_version="${tag#v}"

pkg_version="$(jq -r '.version // empty' package.json)"
if [[ -z "$pkg_version" ]]; then
  echo "release-guard: could not read .version from package.json" >&2
  exit 2
fi

if [[ "$tag_version" != "$pkg_version" ]]; then
  echo "release-guard: REFUSING TO PUBLISH — tag and package.json disagree" >&2
  echo "  tag:          ${tag}  (version ${tag_version})" >&2
  echo "  package.json: ${pkg_version}" >&2
  echo >&2
  echo "npm publish ignores the tag and would publish ${pkg_version}." >&2
  echo "Correct whichever is wrong and re-tag. Do not override this." >&2
  exit 1
fi

echo "release-guard: tag ${tag} matches package.json version ${pkg_version}"
