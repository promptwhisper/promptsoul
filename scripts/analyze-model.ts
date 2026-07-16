#!/usr/bin/env node

import { analyzeModel, formatModelAnalysis } from "../lib/server/model-analysis.ts";

function usage(): string {
  return [
    "Usage: node scripts/analyze-model.ts [runtime directory]",
    "",
    "Without an argument, the runtime is resolved from model.config.json.",
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
      const analysis = await analyzeModel(undefined, args[0]);
      process.stdout.write(formatModelAnalysis(analysis));
    } catch (error) {
      console.error(`ERROR: ${error instanceof Error ? error.message : "model analysis failed"}`);
      process.exitCode = 1;
    }
  }
}

void main();
