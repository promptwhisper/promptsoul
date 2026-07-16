import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

function discoverProjectRoot(): string {
  const starts = [resolve(process.cwd())];
  if (process.argv[1]) starts.push(dirname(resolve(process.argv[1])));
  for (const start of starts) {
    let current = start;
    while (true) {
      if (existsSync(join(current, "AGENTS.md")) && existsSync(join(current, "tools"))) {
        return current;
      }
      const parent = dirname(current);
      if (parent === current || current === parse(current).root) break;
      current = parent;
    }
  }
  return resolve(process.cwd());
}

export const DEFAULT_PROJECT_ROOT = discoverProjectRoot();

export function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isPathWithin(basePath: string, candidatePath: string): boolean {
  const child = relative(resolve(basePath), resolve(candidatePath));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

export function expandHome(inputPath: string): string {
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/")) return join(homedir(), inputPath.slice(2));
  return inputPath;
}

export async function readJsonFile<T = unknown>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function findFilesBySuffix(
  basePath: string,
  suffix: string,
  maxFiles = 50_000,
): Promise<string[]> {
  const base = resolve(basePath);
  const found: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const child = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        found.push(child);
        if (found.length > maxFiles) {
          throw new Error(`too many ${suffix} files under ${base}`);
        }
      }
    }
  }

  await visit(base);
  return found.sort(comparePaths);
}

export async function copyDirectoryWithoutLinks(sourcePath: string, targetPath: string): Promise<void> {
  const source = resolve(sourcePath);
  const target = resolve(targetPath);
  const sourceStats = await lstat(source);
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
    throw new Error("model source must be a regular directory");
  }
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`symbolic links are not allowed in model sources: ${from}`);
    }
    if (entry.isDirectory()) {
      await copyDirectoryWithoutLinks(from, to);
    } else if (entry.isFile()) {
      await copyFile(from, to);
    } else {
      throw new Error(`special files are not allowed in model sources: ${from}`);
    }
  }
}
