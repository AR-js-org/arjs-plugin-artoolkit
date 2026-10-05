import { describe, it, expect } from "vitest";
// @ts-ignore  plain .mjs, no declarations, and not worth generating them for a dev script
import { auditManifest } from "../dev/check-package-contents.mjs";
import pkg from "../package.json";

/**
 * What the published tarball contains has gone wrong in both directions already:
 *
 * - `files` was present when #12 was written, then removed. With no allowlist npm
 *   falls back to `.npmignore`, a denylist that cannot anticipate a directory that
 *   does not exist yet. `docs/superpowers/` arrived with the artoolkit5-ts
 *   migration and was published - 94 kB of internal planning documents (#33).
 * - Restoring the allowlist re-included the sourcemaps #12 removed, because the
 *   `*.map` rules in `.npmignore` stop applying once `files` is set.
 *
 * The authoritative check runs `npm pack --dry-run --json` and needs a build, so it
 * lives in `dev/check-package-contents.mjs` and runs in CI via `npm run
 * check:package`. What is tested here is that script's pure audit function, against
 * manifests describing the failures that are awkward to produce for real.
 *
 * An earlier version of this file compared only top-level directory names, which
 * accepted any pattern sharing a root with an entry point. The first case below is
 * the one that caught it.
 */
describe("auditManifest", () => {
  const entryPoints = ["dist/index.js", "types/index.d.ts"];

  it("reports an entry point whose directory ships a sibling but not it", () => {
    // The hole in the first version: `files: ["dist/assets"]` shares the root
    // `dist` with `dist/index.js`, so a root-name comparison passed while the
    // entry point was not in the tarball at all.
    const result = auditManifest({
      manifest: ["package.json", "dist/assets/worker.js", "types/index.d.ts"],
      entryPoints,
    });

    expect(result.missingEntryPoints).toEqual(["dist/index.js"]);
  });

  it("reports an entry point excluded by a negation", () => {
    // `files: ["dist", "types", "!**/*.d.ts"]` ships the directory and drops the
    // declarations. Nothing about the positive patterns reveals that.
    const result = auditManifest({
      manifest: ["package.json", "dist/index.js"],
      entryPoints,
    });

    expect(result.missingEntryPoints).toEqual(["types/index.d.ts"]);
  });

  it("reports runtime files missing even when every entry point is present", () => {
    // npm always publishes the file named by `main`, whatever `files` says, so a
    // wrong allowlist does not surface on the entry points. The chunks `main`
    // imports are not covered by that guarantee: this manifest would install and
    // then fail on first import, unable to resolve its own worker.
    const result = auditManifest({
      manifest: ["package.json", "dist/index.js", "types/index.d.ts"],
      entryPoints,
      runtimeFiles: ["dist/index.js", "dist/assets/worker.js"],
    });

    expect(result.missingEntryPoints).toEqual([]);
    expect(result.missingRuntimeFiles).toEqual(["dist/assets/worker.js"]);
  });

  it("reports sourcemaps", () => {
    const result = auditManifest({
      manifest: ["dist/index.js", "dist/index.js.map", "types/index.d.ts"],
      entryPoints,
    });

    expect(result.sourcemaps).toEqual(["dist/index.js.map"]);
  });

  it("reports files outside the allowlisted roots, but not npm's own inclusions", () => {
    const result = auditManifest({
      manifest: [
        "package.json",
        "README.md",
        "LICENSE",
        "dist/index.js",
        "types/index.d.ts",
        "AGENTS.md",
        "docs/superpowers/plans/plan.md",
        "vite.config.ts",
      ],
      entryPoints,
    });

    // package.json, README.md and LICENSE ship regardless of `files`, so flagging
    // them would make the check cry wolf on every run.
    expect(result.unexpected).toEqual([
      "AGENTS.md",
      "docs/superpowers/plans/plan.md",
      "vite.config.ts",
    ]);
  });

  it("passes a correct manifest", () => {
    const result = auditManifest({
      manifest: [
        "package.json",
        "README.md",
        "LICENSE",
        "dist/index.js",
        "dist/assets/worker.js",
        "types/index.d.ts",
      ],
      entryPoints,
      runtimeFiles: ["dist/index.js", "dist/assets/worker.js"],
    });

    expect(result).toEqual({
      missingEntryPoints: [],
      missingRuntimeFiles: [],
      sourcemaps: [],
      unexpected: [],
    });
  });

  it("compares paths regardless of a leading ./ or a backslash", () => {
    // `exports` entries are written './dist/index.js' while npm reports
    // 'dist/index.js', and Windows contributes backslashes. A false positive here
    // would be reported as a missing entry point, which is the kind of noise that
    // gets a check disabled.
    const result = auditManifest({
      manifest: ["dist\\index.js", "types/index.d.ts"],
      entryPoints: ["./dist/index.js", "./types/index.d.ts"],
    });

    expect(result.missingEntryPoints).toEqual([]);
  });
});

/**
 * Two assertions about the manifest itself, which need no build and so can live in
 * the unit suite. They are deliberately narrow: everything that depends on what npm
 * actually packs belongs in `npm run check:package`.
 */
describe("package.json packaging fields", () => {
  const files: string[] = pkg.files ?? [];

  it("declares an allowlist rather than relying on .npmignore", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("excludes sourcemaps, which .npmignore can no longer do", () => {
    // Pins #12: once `files` is set npm stops honouring the `*.map` rules there.
    expect(files).toContain("!**/*.map");
  });
});
