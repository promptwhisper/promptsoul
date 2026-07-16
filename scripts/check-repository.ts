#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const requiredFiles = [
  "LICENSE",
  "README.md",
  "README.en.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
  "THIRD_PARTY_NOTICES.md",
  ".editorconfig",
  ".gitattributes",
  ".github/workflows/ci.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/private-contact.yml",
  "app/models/[...path]/route.ts",
  "app/model.config.json/route.ts",
] as const;
const forbiddenRoots = [
  "models/",
  "local-assets/",
  "motion-defs/generated/",
  "tmp-verify/",
] as const;
const forbiddenAssetSuffixes = [
  ".moc3",
  ".model3.json",
  ".motion3.json",
  ".zip",
] as const;
const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".sh",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const textBasenames = new Set([
  ".editorconfig",
  ".env.example",
  ".gitattributes",
  ".gitignore",
  ".nvmrc",
  "LICENSE",
]);
const secretPatterns = [
  /sk-[A-Za-z0-9_-]{20,}/u,
  /gh[pousr]_[A-Za-z0-9]{20,}/u,
  /AIza[0-9A-Za-z_-]{20,}/u,
  /AKIA[0-9A-Z]{16}/u,
  /xox[baprs]-[A-Za-z0-9-]{10,}/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
] as const;

function publishableFiles(): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  );
  return output.split("\0").filter(Boolean).map((filename) => filename.replaceAll("\\", "/"));
}

const files = publishableFiles();
const fileSet = new Set(files);
const problems: string[] = [];

const packageDocument = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  private?: unknown;
  license?: unknown;
  scripts?: Record<string, unknown>;
};
if (packageDocument.private !== true) {
  problems.push("package.json must remain private to prevent accidental npm publication");
}
if (packageDocument.license !== "MIT") {
  problems.push("package.json must declare the repository MIT license");
}
if (String(packageDocument.scripts?.["setup:demo"] ?? "").includes("--accept-license")) {
  problems.push("setup:demo must require the user to pass --accept-license explicitly");
}

for (const required of requiredFiles) {
  if (!fileSet.has(required) || !existsSync(path.join(root, required))) {
    problems.push(`required public file is missing: ${required}`);
  }
}

for (const filename of files) {
  const normalizedFilename = filename.toLowerCase();
  if (
    filename === "model.config.json" ||
    forbiddenRoots.some((prefix) => filename.startsWith(prefix)) ||
    forbiddenAssetSuffixes.some((suffix) => normalizedFilename.endsWith(suffix)) ||
    (/^\.env(?:\.|$)/u.test(filename) && filename !== ".env.example")
  ) {
    problems.push(`local, generated, or secret file would be published: ${filename}`);
    continue;
  }

  const absolute = path.join(root, filename);
  if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
    problems.push(`publishable file must not be a symbolic link: ${filename}`);
    continue;
  }
  if (
    !existsSync(absolute) ||
    (!textExtensions.has(path.extname(filename).toLowerCase()) && !textBasenames.has(filename))
  ) continue;
  if (lstatSync(absolute).size > 2 * 1024 * 1024) continue;
  const content = readFileSync(absolute, "utf8");
  if (content.includes("\r")) {
    problems.push(`publishable text file must use LF line endings: ${filename}`);
  }
  if (content && !content.endsWith("\n")) {
    problems.push(`publishable text file is missing a final newline: ${filename}`);
  }
  if (path.extname(filename).toLowerCase() !== ".md" && content.split("\n").some((line) => /[\t ]+$/u.test(line))) {
    problems.push(`publishable text file contains trailing whitespace: ${filename}`);
  }
  if (secretPatterns.some((pattern) => pattern.test(content))) {
    problems.push(`possible credential in publishable text file: ${filename}`);
  }
}

if (problems.length) {
  console.error("Repository hygiene check failed:");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`Repository hygiene check passed (${files.length} publishable files inspected).`);
}
