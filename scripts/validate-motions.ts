#!/usr/bin/env node

import { validateMotions } from '../lib/server/motion-validator';

try {
  const result = validateMotions({ root: process.cwd(), runtime: process.argv[2] });
  for (const warning of result.warnings) console.warn(`WARN: ${warning}`);
  for (const summary of result.summaries) console.log(summary);
  console.log('---');
  if (result.ok) {
    console.log(`OK: all checks passed for ${result.checked.length} motions in the PromptSoul group`);
  } else {
    for (const error of result.errors) console.error(error);
    console.error(`NG: ${result.errors.length} violations`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`NG: ${error instanceof Error ? error.message : 'validation failed'}`);
  process.exitCode = 1;
}
