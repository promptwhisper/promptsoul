import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = process.cwd();

test('motion delete UI targets only persisted PromptSoul AI motion IDs', () => {
  const source = readFileSync(path.join(root, 'assets', 'app.js'), 'utf8');
  const eligibility = source.match(
    /function getGeneratedMotionId[\s\S]*?\n  \}/u,
  )?.[0] ?? '';
  const deletion = source.match(
    /async function deleteGeneratedMotion[\s\S]*?\n  \}\n\n  function reloadPageForGeneratedMotion/u,
  )?.[0] ?? '';

  assert.match(source, /\^promptsoul_ai_\[0-9a-f\]\{12\}\$/u);
  assert.match(source, /\^rev_\[0-9a-f\]\{16\}\$/u);
  assert.match(eligibility, /group !== CUSTOM_GROUP_PRIORITY\[0\]/u);
  assert.match(source, /MOTION_DELETE_ENDPOINT = \(motionId\) => `\/api\/motions\/\$\{encodeURIComponent\(motionId\)\}`/u);
  assert.match(deletion, /window\.confirm\(/u);
  assert.match(deletion, /method: "DELETE"/u);
  assert.match(deletion, /"Content-Type": "application\/json"/u);
  assert.match(deletion, /body: JSON\.stringify\(\{ revision \}\)/u);
  assert.match(deletion, /initLive2D\(\{/u);
  assert.match(deletion, /loadMotionCapabilities\(\)/u);
});

test('motion delete control keeps an accessible mobile touch target', () => {
  const styles = readFileSync(path.join(root, 'assets', 'styles.css'), 'utf8');
  const deleteRule = styles.match(/\.motion-delete-button \{[\s\S]*?\n\}/u)?.[0] ?? '';

  assert.match(deleteRule, /width: 44px;/u);
  assert.match(deleteRule, /min-width: 44px;/u);
  assert.match(deleteRule, /height: 44px;/u);
  assert.match(deleteRule, /min-height: 44px;/u);
});
