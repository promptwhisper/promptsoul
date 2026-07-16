#!/usr/bin/env node

import { generateMotions } from '../lib/server/motion-generator';

async function main(): Promise<void> {
  try {
    await generateMotions({
      root: process.cwd(),
      runtime: process.argv[2],
      log: console.log,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown generation failure';
    console.error(`ERROR: ${message}`);
    process.exitCode = 1;
  }
}

void main();
