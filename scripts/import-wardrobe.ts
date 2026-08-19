#!/usr/bin/env node

import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  installGeneratedWardrobe,
  selectWardrobePreset,
  WardrobeError,
} from "../lib/server/wardrobe-service";

interface Options {
  archive: string;
  name: string;
  activate: boolean;
}

function usage(): never {
  console.error("Usage: npm run wardrobe:import -- /path/to/promptskin.zip [--name \"Dark academy\"] [--activate]");
  process.exit(1);
}

function parseArguments(args: string[]): Options {
  let archive: string | null = null;
  let suppliedName: string | null = null;
  let activate = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--name") {
      const candidate = args[index + 1];
      if (!candidate || candidate.startsWith("--")) usage();
      suppliedName = candidate;
      index += 1;
    } else if (argument === "--activate") {
      activate = true;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (archive) {
      throw new Error("Only one PromptSkin archive can be imported at a time.");
    } else {
      archive = argument;
    }
  }
  if (!archive) usage();
  const name = (suppliedName || basename(archive).replace(/\.zip$/iu, ""))
    .replace(/\s+/gu, " ")
    .trim();
  if (name.length < 3 || name.length > 1_200) {
    throw new Error("Preset name must contain between 3 and 1200 characters.");
  }
  return { archive, name, activate };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const archivePath = resolve(options.archive);
  if (!existsSync(archivePath) || !archivePath.toLowerCase().endsWith(".zip")) {
    throw new Error("PromptSkin archive must be an existing .zip file.");
  }
  const physicalPath = await realpath(archivePath);
  if (!(await stat(physicalPath)).isFile()) {
    throw new Error("PromptSkin archive must be a regular file.");
  }
  const preset = await installGeneratedWardrobe(physicalPath, options.name, "import");
  if (options.activate) await selectWardrobePreset(preset.id);
  console.log(`Imported wardrobe preset ${preset.id}: ${preset.name}`);
  console.log(options.activate ? "The preset is active." : "Open Prompt Wardrobe to select it.");
}

main().catch((error: unknown) => {
  if (error instanceof WardrobeError) {
    console.error(`${error.code}: ${error.message}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
