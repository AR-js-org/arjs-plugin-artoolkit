/**
 * @fileoverview Audits what `npm pack` would actually publish.
 *
 * `files` in package.json is not a glob list with obvious semantics - npm applies
 * gitignore-style precedence, always includes some files regardless of settings,
 * and silently ignores `.npmignore` rules for some of them. Reimplementing those
 * rules in a test means asserting against a model of npm rather than against npm,
 * and the model is what drifts. So this reads the manifest npm itself reports.
 *
 * Run via `npm run check:package`, which builds first. The audit function below is
 * pure and unit-tested separately; only `main()` touches the filesystem or npm.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, posix } from "node:path";

/** Paths npm publishes whatever `files` says, so their absence is not a defect. */
const ALWAYS_INCLUDED = ["package.json", "README.md", "LICENSE"];

/** The only directories a consumer has any use for: built code and its types. */
const PUBLISHABLE_ROOTS = ["dist", "types"];

/**
 * Compares a packed manifest against what the package promises and forbids.
 *
 * Pure: give it strings, get back findings. The point of keeping it separate from
 * `npm pack` is that the interesting cases - a narrow pattern that ships a
 * sibling but not the entry point, a negation that excludes declarations - are
 * awkward to produce for real and trivial to describe as a manifest.
 *
 * @param {object} input
 * @param {string[]} input.manifest - Paths npm reported, posix-style, no leading './'.
 * @param {string[]} input.entryPoints - Declared entry points (main, module, types, exports).
 * @param {string[]} input.runtimeFiles - Files the build emitted that the entry points need at run time.
 * @param {Record<string, string>} input.sourceMapReferences - Each shipped file's `sourceMappingURL`, by path.
 * @returns {{missingEntryPoints: string[], missingRuntimeFiles: string[], sourcemaps: string[], danglingSourceMapReferences: string[], unexpected: string[]}}
 */
export function auditManifest({
  manifest,
  entryPoints,
  runtimeFiles = [],
  sourceMapReferences = {},
  allowedRoots = ["dist", "types"],
}) {
  const shipped = new Set(manifest.map(normalise));

  const missingEntryPoints = unique(entryPoints.map(normalise)).filter(
    (path) => !shipped.has(path),
  );

  // Separate from the entry points on purpose. npm always publishes the file named
  // by `main`, so a wrong `files` does not surface there - but the chunks `main`
  // imports at run time are not covered by that guarantee. Narrowing `files` to
  // `dist/assets` would publish a `main` that fails to resolve its own worker on
  // the first import, with every entry-point assertion still green.
  const missingRuntimeFiles = unique(runtimeFiles.map(normalise)).filter(
    (path) => !shipped.has(path),
  );

  // Pins #12. Sourcemaps are ~430 kB here, and the `.npmignore` rules that used
  // to exclude them stop applying once `files` is set.
  const sourcemaps = [...shipped].filter((path) => path.endsWith(".map"));

  // Pins #55, the other half of #12: a shipped file must not point at a map the
  // tarball leaves out. Vite's dev server follows the reference and warns
  // "Failed to load source map" for each one. Inline `data:` maps carry their own.
  const danglingSourceMapReferences = Object.entries(sourceMapReferences)
    .map(([file, url]) => [normalise(file), url])
    .filter(([file, url]) => shipped.has(file) && !url.startsWith("data:"))
    .map(([file, url]) => [file, posix.join(posix.dirname(file), url)])
    .filter(([, map]) => !shipped.has(map))
    .map(([file, map]) => `${file} -> ${map}`);

  // Catches the #33 failure directly: a top-level entry that is neither an
  // allowlisted directory nor one of npm's unconditional inclusions.
  const unexpected = [...shipped].filter((path) => {
    if (ALWAYS_INCLUDED.includes(path)) return false;
    return !allowedRoots.includes(path.split("/")[0]);
  });

  return {
    missingEntryPoints,
    missingRuntimeFiles,
    sourcemaps,
    danglingSourceMapReferences,
    unexpected,
  };
}

/**
 * The JSON array from npm's stdout, ignoring anything printed before it.
 *
 * Required, not belt-and-braces. CI sets HUSKY=0, and husky then prints
 * `HUSKY=0 skip install` to stdout from the `prepare` script, immediately before
 * the JSON - which is what broke this check on its first CI run. `--ignore-scripts`
 * does not suppress it. npm also reserves the right to print notices there, so
 * slicing from the first `[` is robust to the class rather than to one case.
 */
function extractJson(stdout) {
  const start = stdout.indexOf("[");
  if (start === -1) {
    throw new Error(`No JSON array in npm's output:
${stdout}`);
  }
  return stdout.slice(start);
}

/** Strips a leading `./` and normalises separators, so comparisons are textual. */
function normalise(path) {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function unique(values) {
  return [...new Set(values)];
}

/** Every emitted `.js` under `dist/`, which is what the bundle needs at run time. */
function collectRuntimeFiles(root = "dist") {
  if (!existsSync(root)) return [];

  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = posix.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(
        ...collectRuntimeFiles(join(root, entry.name).replace(/\\/g, "/")),
      );
    } else if (entry.name.endsWith(".js")) {
      found.push(path);
    }
  }
  return found;
}

/** The `sourceMappingURL` of each shipped `.js` file that declares one, by path. */
function readSourceMapReferences(manifest) {
  const references = {};
  for (const path of manifest.filter((p) => p.endsWith(".js"))) {
    const match = readFileSync(path, "utf8").match(
      /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/,
    );
    if (match) references[path] = match[1];
  }
  return references;
}

function main() {
  const pkg = JSON.parse(
    execFileSync(
      process.execPath,
      ["-p", "JSON.stringify(require('./package.json'))"],
      {
        encoding: "utf8",
      },
    ),
  );

  if (!existsSync("dist") || !existsSync("types")) {
    console.error(
      "dist/ or types/ is missing. Run `npm run build && npm run build:types` first.",
    );
    process.exit(1);
  }

  // `--ignore-scripts` so pack does not re-run lifecycle scripts over the tree
  // built above. It does NOT fix the stdout contamination, which was measured:
  // `npm pack --dry-run --json --ignore-scripts` still prints husky's
  // `HUSKY=0 skip install` ahead of the `[`. `extractJson` is what handles that.
  const packed = JSON.parse(
    extractJson(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        encoding: "utf8",
        shell: process.platform === "win32",
      }),
    ),
  );

  const manifest = packed[0].files.map((file) => file.path);

  const entryPoints = [
    pkg.main,
    pkg.module,
    pkg.types,
    ...Object.values(pkg.exports?.["."] ?? {}),
  ].filter((value) => typeof value === "string");

  const result = auditManifest({
    manifest,
    entryPoints,
    runtimeFiles: collectRuntimeFiles(),
    sourceMapReferences: readSourceMapReferences(manifest),
    // Deliberately NOT derived from `pkg.files`. Deriving it would make this
    // check self-referential: adding `docs` to the allowlist would also add it to
    // what the check considers acceptable, so the #33 failure would pass. The two
    // directories a consumer has any use for are named here, and publishing a
    // third has to be an edit to this line.
    allowedRoots: PUBLISHABLE_ROOTS,
  });

  const problems = [
    [
      "Declared entry points missing from the tarball",
      result.missingEntryPoints,
    ],
    ["Runtime files missing from the tarball", result.missingRuntimeFiles],
    ["Sourcemaps in the tarball (see #12)", result.sourcemaps],
    [
      "Files referencing sourcemaps the tarball lacks (see #55)",
      result.danglingSourceMapReferences,
    ],
    ["Unexpected files in the tarball (see #33)", result.unexpected],
  ].filter(([, paths]) => paths.length > 0);

  if (problems.length === 0) {
    console.log(`Package contents OK - ${manifest.length} files.`);
    for (const path of manifest) console.log(`  ${path}`);
    return;
  }

  for (const [label, paths] of problems) {
    console.error(`\n${label}:`);
    for (const path of paths) console.error(`  ${path}`);
  }
  console.error(`\n${manifest.length} files in the tarball.`);
  process.exit(1);
}

// Only run when invoked directly, so importing this for tests does not pack.
if (process.argv[1] && process.argv[1].endsWith("check-package-contents.mjs")) {
  main();
}
