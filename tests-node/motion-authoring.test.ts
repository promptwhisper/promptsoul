import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  authorMotion,
  buildAuthoringMessages,
  deleteAuthoredMotion,
  listAuthoredMotions,
  loadModelProfile,
  MAX_AUTHORED_MOTIONS,
  MotionConflictError,
  MotionLimitError,
  MotionNotFoundError,
  MotionNotFeasibleError,
  MotionSpecError,
  opaqueMotionRevision,
  parseMotionSpec,
  reapplySavedMotions,
} from '../lib/server/motion-authoring';

function curve(parameter: string, values: number[], target = 'Parameter') {
  const segments: number[] = [0, values[0]];
  for (let index = 1; index < values.length; index += 1) {
    segments.push(0, index / (values.length - 1), values[index]);
  }
  return { Target: target, Id: parameter, Segments: segments };
}

interface Fixture {
  root: string;
  runtime: string;
  model3Path: string;
  originalModel3: Record<string, unknown>;
  motionId: string;
  document(): Record<string, unknown>;
  cleanup(): void;
}

function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'promptsoul-motion-node-'));
  const runtime = path.join(root, 'models', 'avatar');
  mkdirSync(path.join(runtime, 'motion'), { recursive: true });
  mkdirSync(path.join(root, 'motion-defs'));
  writeFileSync(path.join(root, 'model.config.json'), JSON.stringify({
    name: 'avatar',
    model3: 'models/avatar/avatar.model3.json',
  }));
  const originalModel3 = {
    Version: 3,
    FileReferences: { Motions: {
      Idle: [{ File: 'motion/idle.motion3.json', Tag: 'keep' }],
      Action: [{ File: 'motion/action.motion3.json' }],
      PromptSoul: [{
        File: 'motion/builtin.motion3.json',
        Name: 'Built-in',
        FadeInTime: 0.5,
        FadeOutTime: 0.5,
      }],
    } },
    Unrelated: { keep: [1, 2, 3] },
  };
  const model3Path = path.join(runtime, 'avatar.model3.json');
  writeFileSync(model3Path, JSON.stringify(originalModel3));
  writeFileSync(path.join(runtime, 'avatar.cdi3.json'), JSON.stringify({ Parameters: [
    { Id: 'ParamAngleX', Name: 'Angle X' },
    { Id: 'ParamEyeOpen', Name: 'Eye Open' },
    { Id: 'ParamPhysics', Name: 'Hair Physics' },
    { Id: 'ParamOpacity', Name: 'Face Opacity' },
  ] }));
  writeFileSync(path.join(runtime, 'avatar.physics3.json'), JSON.stringify({
    PhysicsSettings: [{ Output: [{ Destination: { Id: 'ParamPhysics' } }] }],
  }));
  const reference = { Curves: [
    curve('ParamAngleX', [0, -10, 10, 0]),
    curve('ParamEyeOpen', [1, 0, 1]),
    curve('ParamPhysics', [0, -1, 1, 0]),
    curve('ParamOpacity', [0, 1, 0]),
    curve('PartFace', [1, 0, 1], 'PartOpacity'),
  ] };
  for (const filename of ['idle.motion3.json', 'action.motion3.json']) {
    writeFileSync(path.join(runtime, 'motion', filename), JSON.stringify(reference));
  }
  writeFileSync(path.join(runtime, 'motion', 'builtin.motion3.json'), JSON.stringify({
    Curves: [curve('ParamAngleX', [0, 999, 0])],
  }));
  const motionId = 'promptsoul_ai_deadbeef1234';
  const document = (): Record<string, unknown> => {
    const profile = loadModelProfile(root);
    const token = profile.controls.find((control) => control.displayName === 'Angle X')?.token;
    assert.ok(token);
    return {
      status: 'ok',
      id: motionId,
      name: 'Look around',
      duration: 1,
      fade_in: 0.3,
      fade_out: 0.4,
      curves: [{
        control: token,
        keyframes: [
          { time: 0, value: 0 },
          { time: 0.5, value: 0.5 },
          { time: 1, value: 0 },
        ],
      }],
    };
  };
  return {
    root,
    runtime,
    model3Path,
    originalModel3,
    motionId,
    document,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('provider prompt exposes opaque controls only', () => {
  const setup = fixture();
  try {
    const profile = loadModelProfile(setup.root);
    const rendered = JSON.stringify(buildAuthoringMessages('look left', profile, setup.motionId));
    assert.doesNotMatch(rendered, /ParamAngleX|ParamPhysics|Face Opacity/u);
    assert.doesNotMatch(rendered, new RegExp(setup.runtime.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.match(rendered, /deadbeef1234|Angle X/u);
    assert.match(rendered, /requested intensity|0\.65\.\.0\.9|full-body scale/u);
  } finally {
    setup.cleanup();
  }
});

test('authoring writes only PromptSoul and preserves model-owned groups', () => {
  const setup = fixture();
  try {
    const profile = loadModelProfile(setup.root);
    const result = authorMotion(JSON.stringify(setup.document()), setup.motionId, {
      root: setup.root,
      expectedRevision: profile.revision,
    });
    assert.equal(result.group, 'PromptSoul');
    assert.equal(result.name, setup.motionId);
    assert.equal(result.label, 'Look around');
    assert.match(result.revision, /^[0-9a-f]{12}$/u);
    const generatedPath = path.join(setup.runtime, 'motion', `${setup.motionId}.motion3.json`);
    const generated = JSON.parse(readFileSync(generatedPath, 'utf8')) as Record<string, unknown>;
    const generatedCurves = generated.Curves as Record<string, unknown>[];
    assert.equal(generatedCurves[0].Id, 'ParamAngleX');
    assert.equal((generatedCurves[0].Segments as number[]).at(-1), 0);
    const after = JSON.parse(readFileSync(setup.model3Path, 'utf8')) as typeof setup.originalModel3;
    const beforeGroups = (setup.originalModel3.FileReferences as { Motions: Record<string, unknown> }).Motions;
    const afterGroups = (after.FileReferences as { Motions: Record<string, unknown> }).Motions;
    assert.deepEqual(afterGroups.Idle, beforeGroups.Idle);
    assert.deepEqual(afterGroups.Action, beforeGroups.Action);
    assert.deepEqual(after.Unrelated, setup.originalModel3.Unrelated);
    assert.deepEqual((afterGroups.PromptSoul as unknown[])[0], (beforeGroups.PromptSoul as unknown[])[0]);
    const saved = path.join(setup.root, 'motion-defs', 'generated', 'avatar', `${setup.motionId}.json`);
    assert.match(readFileSync(saved, 'utf8'), /ParamAngleX/u);
  } finally {
    setup.cleanup();
  }
});

test('strict parser rejects duplicates, non-finite values, booleans, extra fields and bad endpoints', () => {
  const setup = fixture();
  try {
    const duplicate = `${JSON.stringify(setup.document()).slice(0, -1)},"name":"again"}`;
    assert.throws(() => parseMotionSpec(duplicate), MotionSpecError);
    assert.throws(() => parseMotionSpec('{"status":"ok","duration":NaN}'), MotionSpecError);
    for (const mutate of [
      (document: any) => { document.curves[0].keyframes[1].value = true; },
      (document: any) => { document.curves[0].keyframes[1].value = 1.01; },
      (document: any) => { document.parameter = 'ParamAngleX'; },
      (document: any) => { document.curves[0].keyframes.at(-1).value = 0.1; },
    ]) {
      const document = setup.document();
      mutate(document);
      assert.throws(() => parseMotionSpec(JSON.stringify(document)), MotionSpecError);
    }
    assert.throws(
      () => parseMotionSpec(JSON.stringify({ status: 'unsupported', reason: 'provider secret detail' })),
      (error: unknown) => error instanceof MotionNotFeasibleError && !error.message.includes('provider secret'),
    );
  } finally {
    setup.cleanup();
  }
});

test('profile excludes physics outputs, PartOpacity and opacity-looking controls', () => {
  const setup = fixture();
  try {
    const profile = loadModelProfile(setup.root);
    const parameterIds = new Set(profile.controls.map((control) => control.parameterId));
    assert.equal(parameterIds.has('ParamPhysics'), false);
    assert.equal(parameterIds.has('ParamOpacity'), false);
    assert.equal(profile.partOpacityIds.has('PartFace'), true);
  } finally {
    setup.cleanup();
  }
});

test('revision conflicts fail before writing and saved motions can be replayed', () => {
  const setup = fixture();
  try {
    const oldRevision = loadModelProfile(setup.root).revision;
    const changed = JSON.parse(readFileSync(setup.model3Path, 'utf8')) as Record<string, unknown>;
    changed.Changed = true;
    writeFileSync(setup.model3Path, JSON.stringify(changed));
    assert.throws(
      () => authorMotion(JSON.stringify(setup.document()), setup.motionId, {
        root: setup.root,
        expectedRevision: oldRevision,
      }),
      (error: unknown) => error instanceof MotionConflictError && error.code === 'model_changed',
    );
    delete changed.Changed;
    writeFileSync(setup.model3Path, JSON.stringify(changed));
    authorMotion(JSON.stringify(setup.document()), setup.motionId, { root: setup.root });
    assert.deepEqual(listAuthoredMotions(setup.root).map((motion) => motion.id), [setup.motionId]);
    const generated = path.join(setup.runtime, 'motion', `${setup.motionId}.motion3.json`);
    unlinkSync(generated);
    const model3 = JSON.parse(readFileSync(setup.model3Path, 'utf8')) as any;
    model3.FileReferences.Motions.PromptSoul = model3.FileReferences.Motions.PromptSoul.slice(0, 1);
    writeFileSync(setup.model3Path, JSON.stringify(model3));
    const replayed = reapplySavedMotions(setup.root);
    assert.equal(replayed[0].id, setup.motionId);
    assert.equal(readFileSync(generated).byteLength > 0, true);
  } finally {
    setup.cleanup();
  }
});

test('tampered saved specs and the per-model limit fail closed without deletion', () => {
  const setup = fixture();
  try {
    authorMotion(JSON.stringify(setup.document()), setup.motionId, { root: setup.root });
    const directory = path.join(setup.root, 'motion-defs', 'generated', 'avatar');
    const savedPath = path.join(directory, `${setup.motionId}.json`);
    const original = JSON.parse(readFileSync(savedPath, 'utf8')) as any;
    for (const mutate of [
      (document: any) => { document.curves[0].parameter = 'ParamUnknown'; },
      (document: any) => { document.curves[0].parameter = 'ParamPhysics'; },
      (document: any) => { document.curves[0].keyframes[1].value = 99; },
      (document: any) => { document.curves[0].keyframes.at(-1).value = 1; },
    ]) {
      const document = structuredClone(original);
      mutate(document);
      writeFileSync(savedPath, JSON.stringify(document));
      assert.throws(() => reapplySavedMotions(setup.root), MotionSpecError);
    }
    writeFileSync(savedPath, JSON.stringify(original));
    for (let index = 1; index < MAX_AUTHORED_MOTIONS; index += 1) {
      const motionId = `promptsoul_ai_${index.toString(16).padStart(12, '0')}`;
      const copy = structuredClone(original);
      copy.id = motionId;
      writeFileSync(path.join(directory, `${motionId}.json`), JSON.stringify(copy));
    }
    const existing = new Set(readdirSync(directory));
    const next = setup.document() as any;
    next.id = 'promptsoul_ai_cafebabe1234';
    assert.throws(
      () => authorMotion(JSON.stringify(next), next.id, { root: setup.root }),
      MotionLimitError,
    );
    assert.deepEqual(new Set(readdirSync(directory)), existing);
  } finally {
    setup.cleanup();
  }
});

test('deleting an authored motion removes only its persisted PromptSoul artifacts', () => {
  const setup = fixture();
  try {
    const authored = authorMotion(JSON.stringify(setup.document()), setup.motionId, { root: setup.root });
    const lockDirectory = path.join(setup.root, 'models', '.promptsoul-motion-authoring.lockdir');
    mkdirSync(lockDirectory);
    assert.throws(
      () => deleteAuthoredMotion(setup.motionId, {
        root: setup.root,
        expectedRevision: opaqueMotionRevision(authored.revision),
      }),
      MotionConflictError,
    );
    rmSync(lockDirectory, { recursive: true, force: true });
    const beforeStaleDelete = readFileSync(setup.model3Path);
    assert.throws(
      () => deleteAuthoredMotion(setup.motionId, {
        root: setup.root,
        expectedRevision: 'rev_0000000000000000',
      }),
      (error: unknown) => error instanceof MotionConflictError && error.code === 'model_changed',
    );
    assert.deepEqual(readFileSync(setup.model3Path), beforeStaleDelete);
    const result = deleteAuthoredMotion(setup.motionId, {
      root: setup.root,
      expectedRevision: opaqueMotionRevision(authored.revision),
    });
    assert.equal(result.motion.id, setup.motionId);
    assert.equal(result.motion.group, 'PromptSoul');
    assert.equal(result.motion.index, 1);
    assert.equal(result.motion.label, 'Look around');
    assert.match(result.revision, /^[0-9a-f]{12}$/u);

    const saved = path.join(
      setup.root,
      'motion-defs',
      'generated',
      'avatar',
      `${setup.motionId}.json`,
    );
    const runtime = path.join(setup.runtime, 'motion', `${setup.motionId}.motion3.json`);
    assert.equal(existsSync(saved), false);
    assert.equal(existsSync(runtime), false);

    const after = JSON.parse(readFileSync(setup.model3Path, 'utf8')) as typeof setup.originalModel3;
    const originalGroups = (setup.originalModel3.FileReferences as { Motions: Record<string, unknown> }).Motions;
    const afterGroups = (after.FileReferences as { Motions: Record<string, unknown> }).Motions;
    assert.deepEqual(afterGroups.Idle, originalGroups.Idle);
    assert.deepEqual(afterGroups.Action, originalGroups.Action);
    assert.deepEqual(afterGroups.PromptSoul, originalGroups.PromptSoul);
    assert.deepEqual(after.Unrelated, setup.originalModel3.Unrelated);
    assert.deepEqual(listAuthoredMotions(setup.root), []);
    assert.deepEqual(reapplySavedMotions(setup.root), []);
    assert.equal(existsSync(runtime), false);
  } finally {
    setup.cleanup();
  }
});

test('motion deletion rejects unknown, tampered, or model-owned targets without changing files', () => {
  const setup = fixture();
  try {
    assert.throws(
      () => deleteAuthoredMotion('promptsoul_ai_deadbeef123', {
        root: setup.root,
        expectedRevision: 'rev_0000000000000000',
      }),
      MotionSpecError,
    );
    assert.throws(
      () => deleteAuthoredMotion('promptsoul_ai_000000000000', {
        root: setup.root,
        expectedRevision: 'rev_0000000000000000',
      }),
      MotionNotFoundError,
    );

    let authored = authorMotion(JSON.stringify(setup.document()), setup.motionId, { root: setup.root });
    const runtime = path.join(setup.runtime, 'motion', `${setup.motionId}.motion3.json`);
    const saved = path.join(
      setup.root,
      'motion-defs',
      'generated',
      'avatar',
      `${setup.motionId}.json`,
    );
    const modelBeforeTamper = readFileSync(setup.model3Path);
    const specBeforeTamper = readFileSync(saved);
    writeFileSync(runtime, '{}');
    assert.throws(
      () => deleteAuthoredMotion(setup.motionId, {
        root: setup.root,
        expectedRevision: opaqueMotionRevision(authored.revision),
      }),
      MotionConflictError,
    );
    assert.deepEqual(readFileSync(setup.model3Path), modelBeforeTamper);
    assert.deepEqual(readFileSync(saved), specBeforeTamper);
    assert.equal(readFileSync(runtime, 'utf8'), '{}');

    authored = authorMotion(JSON.stringify(setup.document()), setup.motionId, { root: setup.root });
    const model = JSON.parse(readFileSync(setup.model3Path, 'utf8')) as any;
    model.FileReferences.Motions.Action.push({
      File: `motion/${setup.motionId}.motion3.json`,
      Name: 'must not delete',
    });
    writeFileSync(setup.model3Path, JSON.stringify(model));
    const protectedModel = readFileSync(setup.model3Path);
    const protectedSpec = readFileSync(saved);
    const protectedRuntime = readFileSync(runtime);
    assert.throws(
      () => deleteAuthoredMotion(setup.motionId, {
        root: setup.root,
        expectedRevision: opaqueMotionRevision(authored.revision),
      }),
      MotionConflictError,
    );
    assert.deepEqual(readFileSync(setup.model3Path), protectedModel);
    assert.deepEqual(readFileSync(saved), protectedSpec);
    assert.deepEqual(readFileSync(runtime), protectedRuntime);
  } finally {
    setup.cleanup();
  }
});
