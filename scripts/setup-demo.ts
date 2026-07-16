#!/usr/bin/env node

import {
  FREE_MATERIAL_LICENSE,
  LicenseAcceptanceError,
  SAMPLE_DATA_TERMS,
  setupHiyoriDemo,
} from "../lib/server/model-demo.ts";

function usage(): string {
  return [
    "Usage: node scripts/setup-demo.ts --accept-license",
    "",
    "Before accepting, read:",
    `  ${FREE_MATERIAL_LICENSE}`,
    `  ${SAMPLE_DATA_TERMS}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
  } else if (args.some((argument) => argument !== "--accept-license")) {
    console.error(usage());
    process.exitCode = 2;
  } else {
    try {
      const result = await setupHiyoriDemo({ acceptLicense: args.includes("--accept-license") });
      if (result.alreadyConfigured) {
        console.log("Hiyori demo is already configured; nothing to do.");
      } else {
        if (result.reusedDownload) {
          console.log("Reusing previously downloaded official Hiyori runtime data.");
        }
        console.log("Hiyori demo configured. Next: npm run motions:generate");
      }
    } catch (error) {
      if (error instanceof LicenseAcceptanceError) {
        console.error("License acceptance is required before downloading Hiyori.");
        console.error(`Read: ${FREE_MATERIAL_LICENSE}`);
        console.error(`Read: ${SAMPLE_DATA_TERMS}`);
        console.error("Re-run with --accept-license if you agree.");
        process.exitCode = error.exitCode;
      } else {
        console.error(`ERROR: ${error instanceof Error ? error.message : "demo setup failed"}`);
        process.exitCode = 1;
      }
    }
  }
}

void main();
