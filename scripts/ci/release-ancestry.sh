#!/usr/bin/env bash
#
# release-ancestry.sh — refuse to publish a commit that is not reachable from
# the default branch.
#
# WHY THIS EXISTS: the Release workflow fires on any `v*` tag, and a tag can
# point at ANY commit — including one on a branch that was never merged. Tagging
# the wrong commit, or tagging before merging, would otherwise publish that tree
# to every consumer with a green workflow and a plausible version number.
#
# THIS IS A GUARD AGAINST MISTAKES, NOT AGAINST INTENT. Read the next paragraph
# before citing it as a security control.
#
# WHAT THIS DOES NOT COVER — the limits belong next to the mechanism:
#
#   - IT CANNOT CONSTRAIN WHOEVER PUSHES THE TAG, and this is the largest limit
#     by far. On a push event GitHub loads the workflow FROM THE PUSHED REF, so
#     the same tag push this is meant to stop also supplies release.yml and this
#     script. Deleting the step, or making this file exit 0, publishes the branch
#     with no guard and a green run. A check that ships inside the artefact it
#     judges cannot bind the person choosing that artefact.
#     The actual boundary is a repo-side tag protection ruleset on `v*` plus
#     branch protection on the default branch. Both live in repository settings,
#     outside any ref. See docs/RELEASE.md.
#
#   - It proves the commit is ON the default branch, not that it was REVIEWED.
#     A direct push to the default branch satisfies this check completely.
#
#   - It trusts the caller for the branch name. Passing the wrong one makes the
#     check meaningless rather than loud.
#
#   - It says nothing about WHAT changed — only where the commit lives.

set -euo pipefail

default_branch="${1:-main}"
ref="${2:-HEAD}"

if ! sha="$(git rev-parse --verify --quiet "${ref}^{commit}")"; then
  echo "release-ancestry: cannot resolve ref '${ref}'" >&2
  exit 2
fi

remote_ref="origin/${default_branch}"
if ! git rev-parse --verify --quiet "${remote_ref}^{commit}" >/dev/null; then
  # Exit 2, not 1: "could not check" must never be mistaken for "checked and
  # approved". In CI this almost always means actions/checkout defaulted to a
  # shallow clone and the default branch was never fetched.
  echo "release-ancestry: cannot resolve ${remote_ref}" >&2
  echo "  the default branch must be fetched before this can be checked" >&2
  echo "  (in CI: actions/checkout needs fetch-depth: 0)" >&2
  exit 2
fi

# `--is-ancestor` exits 0 for true, 1 for false, and non-zero-but-not-1 on
# ERROR (corrupt object, grafted or shallow history). A bare `if` collapses
# every non-zero into the false branch, which would report a broken repository
# as "not on main" and send someone to re-merge an already-merged branch. That
# is the same conflation of "could not check" with a verdict that the exit-2
# path above exists to prevent — in the opposite direction.
rc=0
git merge-base --is-ancestor "$sha" "$remote_ref" || rc=$?
case "$rc" in
  0)
    echo "release-ancestry: ${sha:0:12} is reachable from ${remote_ref}"
    exit 0
    ;;
  1)
    : # genuinely not an ancestor — fall through to the refusal below
    ;;
  *)
    echo "release-ancestry: could not determine ancestry (git exit ${rc})" >&2
    echo "  this is a broken check, NOT a refusal — the repository may be" >&2
    echo "  shallow, grafted, or corrupt" >&2
    exit 2
    ;;
esac

echo "release-ancestry: REFUSING TO PUBLISH — tagged commit is not on ${default_branch}" >&2
echo "  tagged commit: ${sha}" >&2
echo "  checked against: ${remote_ref}" >&2
echo >&2
echo "Publishing this would ship code that never landed on the default branch." >&2
echo "Merge it first, then tag the merge commit." >&2
exit 1
