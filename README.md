# @wave-engineering/mcp-logger

Structured JSON-line logger for Wave-Engineering MCP servers. Writes one JSON
object per line to `stderr` — MCP servers reserve `stdout` for protocol traffic —
and optionally appends the same line to a file.

Zero runtime dependencies.

## Installing — you need a token, and there is a wrong way to supply it

This package is published to **GitHub Packages** with `internal` visibility.
**There is no anonymous pull.** Without credentials you get:

```
$ bun install
error: GET https://npm.pkg.github.com/@wave-engineering%2fmcp-logger - 401
error: @wave-engineering/mcp-logger@1.1.0 failed to resolve
```

### Do this — put the token in `~/.npmrc`

User-level, outside any repository, so it cannot be committed. Requires a token
with `read:packages`.

```bash
umask 077
printf '@wave-engineering:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$GH_TOKEN" >> ~/.npmrc
chmod 600 ~/.npmrc     # see below — this line is NOT redundant
```

**Why `chmod` as well as `umask`.** `umask` applies when a file is *created*. If
you already have a `~/.npmrc` — most people do, and it may have been created by
another tool at `644` — appending to it leaves its existing mode untouched, and
you have just written a live credential into a world-readable file. Measured:

```
umask 077 + create           → 600
umask 077 + append to 644    → 644     ← unchanged; the token is world-readable
```

Verify:

```bash
stat -c %a ~/.npmrc          # → 600
```

### Do NOT do this — the repository's `.npmrc`

Every consumer repo contains a **tracked** `.npmrc`:

```
@wave-engineering:registry=https://npm.pkg.github.com
```

When the 401 appears, this file is the obvious place to look. It already names
this exact registry and is missing only a token, so appending one line looks
like the fix.

**That file is tracked. Appending a token there commits a live credential.**

Confirm you have not, before committing anything:

```bash
git diff --quiet .npmrc && echo "repo .npmrc unchanged"
```

### And why your CI does the thing you must not

Your own workflows already append a token to the repo `.npmrc` — every consumer
repo does, in both `ci.yml` and `release.yml`:

```yaml
- run: echo "//npm.pkg.github.com/:_authToken=${{ secrets.GITHUB_TOKEN }}" >> .npmrc
```

That is correct **only** because a GitHub Actions runner is ephemeral: the
filesystem is destroyed with the job, and nothing is ever committed from it.

It is not a template for a developer machine — and it is very likely the first
thing you will find when you search your repo for how this auth is configured,
because there are a dozen of these lines across the consumer workflows and none
anywhere else. **It is precedent for the runner, not for you.** The same command
that is correct in CI writes a permanent credential into a tracked file locally.

## Usage

```ts
import { createLogger } from "@wave-engineering/mcp-logger";

const log = createLogger("watcher");

log.info("api_call", { endpoint: "/users/@me", status: 200 });
log.warn("poll", { channels: 7 }, "rate limit approaching");
log.error("forward", { to: "grunt-oaw-1" }, String(err));
```

Levels are `debug`, `info`, `warn`, `error`. The threshold is `LOG_LEVEL`
(default `info`); set `LOG_FILE` to also append to a file (`~` is expanded, and
parent directories are created).

## The envelope

```json
{"ts":"2026-07-19T20:16:34.426Z","server":"watcher","level":"info","event":"api_call","pid":3401293,"instance":"20wgd-bm0aqn","status":200}
```

`ts`, `server`, `level`, `event`, `pid`, and `instance` are owned by the logger
and **cannot be overwritten by caller fields** — a field of the same name is
dropped and its name recorded in `reserved_conflict`, so the collision is
visible in the line rather than silent.

`pid` and `instance` identify the process that **emitted** the line, and nothing
else. `instance` exists because pids recycle: a restarted process can reuse a
dead one's pid and become indistinguishable from it hours apart in the same log.
To log about a *different* process, use a distinct key such as `child_pid` — the
envelope deliberately cannot express another process's identity in these fields,
which is what makes `pid` trustworthy for attribution.

## For maintainers

Release procedure, and the things the release automation does **not** enforce,
are in [`docs/RELEASE.md`](docs/RELEASE.md).
