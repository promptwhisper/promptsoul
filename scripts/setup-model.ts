#!/usr/bin/env node

import { setupModel } from "../lib/server/model-setup.ts";

function usage(): string {
  return [
    "Usage:",
    "  node scripts/setup-model.ts",
    "  node scripts/setup-model.ts <folder|zip>",
    "",
    "Without a source path, models are auto-detected under local-assets/.",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
  } else if (args.length > 1) {
    console.error(usage());
    process.exitCode = 2;
  } else {
    try {
      const result = await setupModel({ source: args[0] });
      if (result.extractedDirectory) {
        console.log(`unzipped:  ${args[0]} -> ${result.extractedDirectory}`);
      }
      console.log(`copied:    ${result.sourceDirectory} -> ${result.targetDirectory}`);
      console.log(`registered: model.config.json (model3: ${result.model3})`);
      console.log("next:      npm run analyze:model to inspect the parameters");
    } catch (error) {
      console.error(`ERROR: ${error instanceof Error ? error.message : "model setup failed"}`);
      process.exitCode = 1;
    }
  }
}

void main();
