# Releasing `@wave-engineering/mcp-logger`

Releases publish to GitHub Packages (`npm.pkg.github.com`), which is where every
consumer already resolves this package from.

**The release is automated. The decision to release is not.** Pushing a `v*` tag
publishes; nothing else does.

## Procedure

1. **Land the change on `main`** through the normal issue → branch → PR → gate
   flow. `main` must be green.

2. **Set the version in `package.json`** in that same PR, not afterwards. The
   version is what actually gets published; the tag only triggers the job.

   Choosing the number is a human call — see *Choosing a version* below.

3. **Tag the merge commit and push the tag:**

   ```bash
   git checkout main && git pull
   git tag v1.1.0            # must match package.json exactly
   git push origin v1.1.0
   ```

4. **Watch the Release workflow.** In order, it will:
   1. refuse the tag if it disagrees with `package.json`,
   2. refuse the tag if its commit is not reachable from `main`,
   3. run the full gate,
   4. verify the tarball contents,
   5. publish.

   Steps 1 and 2 run before anything expensive, so a mistagged release fails in
   seconds rather than after a full build.

5. **Confirm the version is actually in the registry.** A green workflow is not
   proof of a successful publish:

   ```bash
   gh api /orgs/Wave-Engineering/packages/npm/mcp-logger/versions \
     --jq '.[] | "\(.name)  \(.created_at)"'
   ```

6. **Tell whoever sequences the consumer side.** Consumers do not pick this up
   on their own — see below.

## Choosing a version

Consumers depend on `^1.0.0`, so a minor bump is range-compatible and a major
bump is not.

- **Patch** — a fix with no observable change to the log envelope.
- **Minor** — new envelope fields, or behaviour changes that no current consumer
  can observe. Adding `pid`/`instance` was a minor: additive, and verified
  against every consumer call site before shipping.
- **Major** — a change that breaks a consumer *in practice*, not merely in
  theory. Reserve it for evidence, not caution: if a real consumer is affected,
  that is a major; if none is, a major signals breakage that does not exist.

## What this automation does NOT cover

Stated here because this is where someone cutting a release is standing.

- **Consumers do not update themselves.** Their lockfiles pin the tarball URL
  *and an integrity hash*, so a caret range alone will not move them. Each
  consumer needs an explicit `bun update @wave-engineering/mcp-logger` plus a
  lockfile commit. Publishing is not delivering.

- **Nothing verifies consumers still work.** The gate here runs *this* package's
  tests. No consumer test suite runs against the new version before or after
  publish. Cross-repo sequencing is a human responsibility.

- **The version guard compares strings, not meaning.** It catches a tag that
  disagrees with `package.json`. It cannot tell you `1.1.0` should have been
  `2.0.0`.

- **"On `main`" is not the same as "reviewed", and today it means less than
  that.** The ancestry guard proves the tagged commit is reachable from `main`;
  it cannot prove a human looked at it. Reachable-from-`main` is only meaningful
  if **both** hold: (a) `main` is branch-protected, so landing there implies
  review, and (b) `v*` tag *creation* is restricted, so the guard cannot simply
  be tagged around (see the next bullet).

  > **Status: `main` IS protected, and the guard's premise now holds.**
  >
  > Ruleset `19180388` — "protected main", target `branch`, active on
  > `~DEFAULT_BRANCH` — carries `deletion`, `non_fast_forward`, and
  > **`pull_request`**, with **zero bypass actors** (no admin override).
  >
  > Red-tested end to end rather than read from config: a direct API
  > fast-forward of `main` was rejected with
  > `422 Changes must be made through a pull request`, and `main` did not move.
  >
  > So reachable-from-`main` now means **"went through a PR"**. Earlier revisions
  > of this file correctly warned that it meant nothing; that warning is now
  > obsolete, and the ancestry guard is worth what it claims to be worth.

  **Checking this yourself — do not use the endpoint this file used to cite.**

  ```bash
  # WRONG: reports legacy branch protection only. Returns 404 on this repo
  # RIGHT NOW, with main fully protected and direct pushes provably rejected.
  gh api repos/Wave-Engineering/mcp-logger/branches/main/protection
  #   → 404 Branch not protected     ← MISLEADING, ruleset protection is invisible here

  # RIGHT:
  gh api repos/Wave-Engineering/mcp-logger/branches/main --jq .protected
  #   → true
  gh api repos/Wave-Engineering/mcp-logger/rules/branches/main --jq '[.[].type]'
  #   → ["deletion","non_fast_forward","pull_request"]
  ```

  The second command genuinely distinguishes protected from unprotected — it
  returns `[]` for a repo with no rules (verified against `mcp-server-wtf`,
  whose `main` is unprotected). That check was worth running: an earlier attempt
  used `mcp-server-discord` as the negative control, which turned out to be
  protected too and therefore proved nothing.

  A verification command that reports "not protected" for a protected repo is
  worse than none, because it will be believed.

- **None of the in-repo guards constrain a determined tagger, and this is the
  most important limit on this page.** On a tag push, GitHub runs the workflow
  *from the tagged commit* — so `release.yml` itself, both guards, and every
  script under `scripts/ci/` come from the very tree being judged. Someone who
  chooses the tree can edit or delete the checks in it. Every control described
  above is therefore a guard against **mistakes** — tagging before merging,
  tagging the wrong commit — not against intent.

  **The only thing that constrains who may publish is a repo-side tag ruleset
  restricting who may CREATE a `v*` tag**, which lives in repository settings,
  not in this repository's files. Branch protection on `main` does **not** cover
  tags.

  > **Status: a tag ruleset EXISTS, and it does NOT close this gap.**
  >
  > Ruleset `19180315` — "Protected release tags (v*)", target `tag`, active on
  > `refs/tags/v*` — carries exactly two rules: `deletion` and
  > `non_fast_forward`. Verified via
  > `gh api repos/Wave-Engineering/mcp-logger/rulesets/19180315`.
  >
  > **What it gives you:** published tags are immutable. A `v*` tag cannot be
  > deleted or force-moved, so a released version can never be silently
  > repointed at different code. That is a real and valuable property.
  >
  > **What it does NOT give you:** there is **no `creation` rule**. Anyone with
  > push access can still create a new `v*` tag on any commit — including a
  > local commit never pushed as a branch — and publish it to every consumer.
  > **The creation gap described above remains fully open.**
  >
  > Read the difference carefully: this ruleset governs what happens to a tag
  > *after* it exists, not who may bring one into existence. Seeing "a tag
  > ruleset is configured" and concluding the publish path is gated is exactly
  > the wrong inference. Closing the gap needs a `creation` rule with a
  > restricted bypass list. Escalated to BJ as repo governance.
  >
  > Verify with:
  > ```bash
  > gh api repos/Wave-Engineering/mcp-logger/rulesets/19180315 --jq '[.rules[].type]'
  > #   → ["deletion","non_fast_forward"]      ← no "creation": gap still open
  > ```
  >
  > **This gap is not closed by `main` being protected.** Branch protection
  > governs `refs/heads/*`; tags are `refs/tags/*` and are reached by a
  > different ruleset entirely. A tag can still be created on any commit,
  > including one that never went through a PR — the ancestry guard is what
  > catches that today, and per the paragraph above, only against mistakes.

- **Dependency scanning does not cover dev dependencies.** Trivy reports
  *production* dependencies from a bun lockfile, so `typescript` and
  `@types/bun` are outside it by construction. The exposure is small — they are
  build-time only, never shipped, and the `files` allowlist keeps them out of
  the tarball — but a green dependency check on this repo means "no vulnerable
  **runtime** dependencies", and this package currently has **no runtime
  dependencies at all**. Read a zero here as "nothing in scope was found",
  never as "everything was scanned".

- **No publish-time provenance, and it is not available here.** Provenance
  attestation is an **npmjs.com registry feature**. Publishing to
  `npm.pkg.github.com` gets no provenance regardless of repo visibility or
  `id-token` permissions — making this repo public would not unlock it.

- **Re-publishing the same version is not possible.** npm rejects duplicates, so
  a bad release is fixed by shipping a new version, not by replacing one. An org
  admin *can* delete a version from GitHub Packages, but treat that as incident
  recovery rather than routine: anything that already resolved the bad version
  has it in a lockfile.

- **Nothing checks the version is unpublished before running.** A duplicate tag
  fails at the registry with a 409 rather than at the guard, late and noisily.

## Credentials

The workflow authenticates with `secrets.GITHUB_TOKEN` and
`permissions: packages: write`. No org secret or personal token is involved.

This works because the package is already linked to this repository. If the link
is ever broken, or the package is recreated, the token may stop being sufficient
and a maintainer with `packages: write` on the org would need to re-link it.

Publishing from a workstation is **not** a supported fallback: local `.npmrc`
files carry the registry line but no auth token, so a hand-publish fails at the
push. If CI cannot publish, fix CI.

## History

- `1.0.0` — published 2026-04-12. A `v1.0.0` tag does exist, at `ec7e0ee`
  (the initial commit, reachable from `main`), so the tagging convention this
  workflow formalises was already being followed by hand. What was missing was
  the automation and any written record of the steps — the publish itself could
  not be reproduced from anything in the repository. Both guards added here
  would have passed that release unchanged, which is the intent: automate the
  convention, do not invent a new one.
