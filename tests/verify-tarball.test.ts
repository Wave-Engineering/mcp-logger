import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "ci", "verify-tarball.sh");

const HAVE_NPM = Bun.spawnSync(["sh", "-c", "command -v npm"]).exitCode === 0;

/**
 * Build a throwaway package and run the checker against it.
 *
 * `filesField` mirrors the real `files` allowlist. Omitting it reproduces the
 * pre-fix state, where npm packs everything it can see.
 */
function runAgainstPackage(filesField: string[] | null): {
  code: number | null;
  stdout: string;
  stderr: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "verify-tarball-"));
  try {
    const pkg: Record<string, unknown> = {
      name: "@wave-engineering/mcp-logger",
      version: "0.0.0-test",
    };
    if (filesField) pkg.files = filesField;
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(dir, "index.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "types.ts"), "export type T = 1;\n");
    // The stowaway: exactly the class of file that must not reach a consumer.
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "tests", "leaked.test.ts"), "// should not ship\n");

    const p = Bun.spawnSync([SCRIPT], { cwd: dir });
    return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!HAVE_NPM)("verify-tarball.sh (#5)", () => {
  test("passes when the allowlist confines the tarball", () => {
    // Positive control. Without it, the failure case below would be satisfied
    // by a script that refuses everything — which would block every release
    // while looking like a working check.
    const r = runAgainstPackage(["index.ts", "types.ts"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("exactly the expected files");
  });

  test("fails when a test file would ship to consumers", () => {
    // The regression this exists for. Before the allowlist, a real pack
    // included both test suites and every CI script — and nothing noticed,
    // because a tarball nobody inspects looks exactly like a correct one.
    const r = runAgainstPackage(null);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not what a consumer should receive");
    // The diff must name the offender, or an operator has to go pack it by hand
    // to find out what changed.
    expect(r.stderr).toContain("leaked.test.ts");
  });
});
