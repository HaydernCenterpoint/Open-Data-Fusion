import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(
  await readFile(join(repositoryRoot, "config", "dependency-license-policy.json"), "utf8"),
);

const allowed = new Set(policy.allowedLicenses);
const exceptions = new Map(Object.entries(policy.metadataExceptions));
const inspectedPaths = new Set();
const packages = new Map();
const failures = [];

function declaredLicense(manifest) {
  if (typeof manifest.license === "string" && manifest.license.trim()) return manifest.license.trim();
  if (Array.isArray(manifest.licenses)) {
    const values = manifest.licenses
      .map((value) => typeof value === "string" ? value : value?.type)
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim());
    if (values.length > 0) return values.join(" OR ");
  }
  return null;
}

function expressionAllowed(expression) {
  const identifiers = expression
    .replace(/[()]/g, " ")
    .split(/\s+(?:AND|OR|WITH)\s+/i)
    .map((value) => value.trim())
    .filter(Boolean);
  return identifiers.length > 0 && identifiers.every((identifier) => allowed.has(identifier));
}

async function inspectPackage(packageDirectory) {
  let canonicalPath;
  try {
    canonicalPath = await realpath(packageDirectory);
  } catch {
    return;
  }
  if (inspectedPaths.has(canonicalPath)) return;
  inspectedPaths.add(canonicalPath);

  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(canonicalPath, "package.json"), "utf8"));
  } catch {
    return;
  }
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") return;

  const packageKey = `${manifest.name}@${manifest.version}`;
  let license = declaredLicense(manifest);
  let evidence = "package.json";
  if (!license && exceptions.has(packageKey)) {
    const exception = exceptions.get(packageKey);
    license = exception.license;
    evidence = exception.evidence;
  }
  packages.set(packageKey, { license, evidence });

  if (!license) failures.push(`${packageKey}: missing license metadata and no reviewed exception`);
  else if (!expressionAllowed(license)) failures.push(`${packageKey}: license '${license}' is outside the allowlist`);

  await walkNodeModules(join(canonicalPath, "node_modules"));
}

async function walkNodeModules(nodeModulesDirectory) {
  let entries;
  try {
    entries = await readdir(nodeModulesDirectory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".bin") continue;
    const entryPath = join(nodeModulesDirectory, entry.name);
    if (entry.name.startsWith("@")) {
      let scopedEntries;
      try {
        scopedEntries = await readdir(entryPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const scopedEntry of scopedEntries) {
        if (scopedEntry.isDirectory() || scopedEntry.isSymbolicLink()) {
          await inspectPackage(join(entryPath, scopedEntry.name));
        }
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      await inspectPackage(entryPath);
    }
  }
}

await walkNodeModules(join(repositoryRoot, "node_modules"));

if (packages.size === 0) {
  console.error("No installed dependency packages were found. Run npm ci first.");
  process.exitCode = 1;
} else if (failures.length > 0) {
  console.error("Dependency license policy failed:\n" + failures.sort().map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  const reviewedExceptions = [...packages.entries()].filter(([, value]) => value.evidence !== "package.json");
  console.log(`Dependency license policy passed for ${packages.size} unique package versions.`);
  if (reviewedExceptions.length > 0) {
    console.log("Reviewed metadata exceptions:");
    for (const [packageKey, value] of reviewedExceptions) {
      console.log(`- ${packageKey}: ${value.license} (${value.evidence})`);
    }
  }
}
