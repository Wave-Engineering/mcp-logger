import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "ci", "release-ancestry.sh");

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString()}`);
  }
  return p.stdout.toString().trim();
}

function commit(dir: string, name: string): string {
  writeFileSync(join(dir, name), name);
  git(dir, "add", ".");
  git(dir, "commit", "-m", name);
  return git(dir, "rev-parse", "HEAD");
}

/**
 * Build a throwaway repo. `origin/main` is faked with update-ref rather than a
 * real remote — the script only reads the remote-tracking ref, and a network
 * round-trip would buy nothing.
 */
function withRepo(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "release-ancestry-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(dir: string, ...args: string[]) {
  const p = Bun.spawnSync([SCRIPT, ...args], { cwd: dir });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

describe("release-ancestry.sh (#5)", () => {
  test("passes when the tagged commit is on the default branch", () =>
    withRepo((dir) => {
      // Positive control. A check that refused everything would satisfy both
      // failure cases below while making every legitimate release impossible.
      const sha = commit(dir, "a.txt");
      git(dir, "update-ref", "refs/remotes/origin/main", sha);
      const r = run(dir, "main");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("reachable from origin/main");
    }));

  test("passes for an ancestor commit, not just the tip", () =>
    withRepo((dir) => {
      // Tagging an older commit that IS on main is legitimate — a patch release
      // cut from history. Rejecting it would be a false positive.
      const first = commit(dir, "a.txt");
      const second = commit(dir, "b.txt");
      git(dir, "update-ref", "refs/remotes/origin/main", second);
      const r = run(dir, "main", first);
      expect(r.code).toBe(0);
    }));

  test("refuses a commit that never landed on the default branch", () =>
    withRepo((dir) => {
      // The hole this closes: tag an unmerged branch, publish unreviewed code
      // to every consumer, green workflow, plausible version.
      const base = commit(dir, "a.txt");
      git(dir, "update-ref", "refs/remotes/origin/main", base);
      git(dir, "checkout", "-q", "-b", "sneaky");
      commit(dir, "evil.txt");
      const r = run(dir, "main");
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("REFUSING TO PUBLISH");
      expect(r.stderr).toContain("never landed on the default branch");
    }));

  test("honours the default-branch argument instead of hardcoding main", () =>
    withRepo((dir) => {
      // Without this, a script that ignored $1 and hardcoded origin/main would
      // pass every other test in this file.
      const sha = commit(dir, "a.txt");
      git(dir, "update-ref", "refs/remotes/origin/release-2x", sha);
      const r = run(dir, "release-2x");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("origin/release-2x");
    }));

  test("peels an annotated tag to its commit", () =>
    withRepo((dir) => {
      // The trigger for this workflow is a tag push, and annotated tags resolve
      // to a tag object rather than a commit. The `^{commit}` peel handles it;
      // nothing pinned that until now.
      const sha = commit(dir, "a.txt");
      git(dir, "update-ref", "refs/remotes/origin/main", sha);
      git(dir, "tag", "-a", "v1.0.0", "-m", "annotated");
      const r = run(dir, "main", "v1.0.0");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("reachable from origin/main");
    }));

  test("exits distinctly when the tagged ref itself cannot be resolved", () =>
    withRepo((dir) => {
      // Deleting the ref-resolution guard leaves every other test green while
      // silently turning "could not resolve" into "checked and refused" under
      // set -e. Exit 2 vs exit 1 is the whole distinction.
      const sha = commit(dir, "a.txt");
      git(dir, "update-ref", "refs/remotes/origin/main", sha);
      const r = run(dir, "main", "refs/tags/does-not-exist");
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("cannot resolve ref");
    }));

  test("exits distinctly when the default branch cannot be resolved", () =>
    withRepo((dir) => {
      // Exit 2, not 1. A shallow clone that never fetched main must not be
      // reported as "checked and refused" — nor, worse, silently pass.
      commit(dir, "a.txt");
      const r = run(dir, "main");
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("cannot resolve origin/main");
      expect(r.stderr).toContain("fetch-depth: 0");
    }));
});
