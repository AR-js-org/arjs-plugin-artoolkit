import { describe, it, expect } from "vitest";
import pkg from "../package.json";

/**
 * What the published tarball contains is decided by `files` in package.json, and
 * it has gone wrong in both directions already:
 *
 * - `files` was present when #12 was written, then removed at some point. With no
 *   allowlist, npm falls back to `.npmignore`, which is a denylist and cannot
 *   anticipate a directory that does not exist yet. `docs/superpowers/` arrived
 *   with the artoolkit5-ts migration and was published - 94 kB of internal
 *   planning documents, alongside AGENTS.md and three build configs (#33).
 * - Restoring the allowlist then re-included the sourcemaps that #12 removed,
 *   because the `*.map` rules in `.npmignore` stop applying once `files` is set.
 *
 * Neither failure announced itself. These assertions are the announcement.
 */
describe("published package contents", () => {
  const files: string[] = pkg.files ?? [];

  it("declares an allowlist rather than relying on .npmignore", () => {
    // The specific risk: a denylist silently starts shipping each new top-level
    // directory. An allowlist silently ships nothing new, which is the failure
    // direction worth having.
    expect(files.length).toBeGreaterThan(0);
  });

  it("ships every declared entry point", () => {
    // The one thing an allowlist gets wrong: a new entry point that nobody
    // remembered to add. A consumer then installs a package whose `main` or
    // `types` points at a file that is not in the tarball.
    const entryPoints = [
      pkg.main,
      pkg.module,
      pkg.types,
      ...Object.values(pkg.exports?.["."] ?? {}),
    ].filter((value): value is string => typeof value === "string");

    expect(entryPoints.length).toBeGreaterThan(0);

    const allowedRoots = files
      .filter((pattern) => !pattern.startsWith("!"))
      .map((pattern) => pattern.split("/")[0]);

    for (const entryPoint of new Set(entryPoints)) {
      const root = entryPoint.replace(/^\.\//, "").split("/")[0];
      expect(allowedRoots, `${entryPoint} is not covered by "files"`).toContain(
        root,
      );
    }
  });

  it("excludes sourcemaps, which .npmignore can no longer do", () => {
    // Pins #12. Once `files` is set, npm stops honouring the `*.map` rules in
    // .npmignore, so the exclusion has to live here instead. Dropping this line
    // adds ~430 kB of .map files back to the tarball without any other symptom.
    expect(files).toContain("!**/*.map");
  });

  it("ships no directory that exists only for development", () => {
    // Each of these was in the tarball before #33. They are named explicitly
    // rather than inferred, so re-adding one to `files` has to be deliberate.
    const developmentOnly = [
      "docs",
      "src",
      "tests",
      "test",
      "dev",
      "examples",
      "coverage",
      ".github",
    ];

    for (const directory of developmentOnly) {
      expect(files, `"${directory}" must not be published`).not.toContain(
        directory,
      );
    }
  });
});
