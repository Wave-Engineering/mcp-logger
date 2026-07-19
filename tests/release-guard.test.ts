import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = join(import.meta.dir, "..", "scripts", "ci", "release-guard.sh");

/**
 * Run the guard against a throwaway package.json.
 *
 * The script reads `package.json` from its working directory, so each case gets
 * its own temp dir rather than mutating the real manifest.
 */
function runGuard(
  pkgVersion: string | null,
  args: string[],
): { code: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "release-guard-"));
  try {
    const pkg: Record<string, unknown> = { name: "@wave-engineering/mcp-logger" };
    if (pkgVersion !== null) pkg.version = pkgVersion;
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));

    const proc = Bun.spawnSync([GUARD, ...args], { cwd: dir });
    return {
      code: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("release-guard.sh (#5)", () => {
  test("passes when the tag matches package.json", () => {
    // Positive control, and the more important half of this suite: a guard that
    // refuses everything would satisfy every failure case below while making
    // releases impossible. Both directions or neither is meaningful.
    const r = runGuard("1.1.0", ["v1.1.0"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("matches package.json version 1.1.0");
  });

  test("accepts the full ref form GitHub Actions passes", () => {
    // github.ref_name is bare, but a workflow edit could pass github.ref. If
    // the guard silently failed to strip refs/tags/, it would reject every
    // legitimate release — a guard breaking the pipeline it protects.
    const r = runGuard("1.1.0", ["refs/tags/v1.1.0"]);
    expect(r.code).toBe(0);
  });

  test("refuses when the tag disagrees with package.json", () => {
    // The defect this exists for: npm ignores the tag, so this would otherwise
    // publish 1.1.0 under a v9.9.9 tag and report success.
    const r = runGuard("1.1.0", ["v9.9.9"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("REFUSING TO PUBLISH");
    // Both values must appear — an operator needs to know which one is wrong,
    // and an error that names neither sends them to read the workflow instead.
    expect(r.stderr).toContain("9.9.9");
    expect(r.stderr).toContain("1.1.0");
  });

  test("refuses a version-suffix near-miss rather than prefix-matching", () => {
    // 1.1.0 vs 1.1.0-rc.1 is exactly the pair a sloppy comparison lets through.
    const r = runGuard("1.1.0", ["v1.1.0-rc.1"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("REFUSING TO PUBLISH");
  });

  test("exits distinctly when given no tag at all", () => {
    // Exit 2, not 1: "the guard could not run" and "the guard says no" are
    // different outcomes and must not be conflated by a caller checking $?.
    const r = runGuard("1.1.0", []);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("usage:");
  });

  test("exits distinctly when package.json has no version", () => {
    const r = runGuard(null, ["v1.1.0"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("could not read .version");
  });
});
