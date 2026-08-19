import assert from 'node:assert/strict';
import test from 'node:test';

import { type ModelProfile } from '../lib/server/motion-authoring';
import {
  MAX_REALTIME_LINE_BYTES,
  MAX_REALTIME_SEGMENT_TEXT_CHARS,
  parseRealtimeSegmentLine,
  RealtimeCueProtocolError,
  RealtimeSegmentAssembler,
  partOpacityAddress,
} from '../lib/server/realtime-cue';

function profile(): ModelProfile {
  return {
    root: '/fixture',
    runtime: '/fixture/models/avatar',
    model3Path: '/fixture/models/avatar/avatar.model3.json',
    modelStem: 'avatar',
    controls: [{
      token: 'c01',
      parameterId: 'ParamAngleX',
      displayName: 'Angle X',
      minimum: -20,
      maximum: 30,
      base: 10,
    }],
    availableIds: new Set(['ParamAngleX']),
    physicsOutputs: new Set(),
    partOpacityIds: new Set(),
    safeRanges: new Map([['ParamAngleX', [-20, 30] as const]]),
    basePose: new Map([['ParamAngleX', 10]]),
    referenceMotionCount: 1,
    revision: 'fixture-revision',
  };
}

function segmentDocument(): any {
  return {
    type: 'segment',
    seq: 0,
    text: '你好',
    fallback: 'thinking',
    cues: [{
      id: 'cue_0',
      at: 0,
      span: 0.8,
      curves: [{
        control: 'c01',
        keys: [[0, 0], [0.5, -1], [0.75, 1], [1, 0]],
      }],
    }],
  };
}

test('a strict segment resolves opaque controls into safe parameter offsets', () => {
  const segment = parseRealtimeSegmentLine(JSON.stringify(segmentDocument()), profile());

  assert.deepEqual(segment, {
    type: 'segment',
    seq: 0,
    text: '你好',
    fallback: 'thinking',
    modelRevision: 'fixture-revision',
    cuesRejected: false,
    cues: [{
      id: 'cue_0',
      at: 0,
      span: 0.8,
      curves: [{
        parameterId: 'ParamAngleX',
        minimum: -20,
        maximum: 30,
        base: 10,
        keys: [[0, 0], [0.5, -30], [0.75, 20], [1, 0]],
      }],
    }],
  });
});

test('full-action mode accepts 40 coordinated curves with up to 64 keys', () => {
  const controls = Array.from({ length: 40 }, (_, index) => ({
    token: `c${String(index + 1).padStart(2, '0')}`,
    parameterId: index === 0 ? 'ParamAngleX' : `ParamArm${index}`,
    displayName: index === 0 ? 'Head X' : `Arm ${index}`,
    minimum: -1,
    maximum: 1,
    base: 0,
  }));
  const fullProfile: ModelProfile = {
    ...profile(),
    controls,
    availableIds: new Set(controls.map((control) => control.parameterId)),
  };
  const keys = Array.from({ length: 64 }, (_, index): [number, number] => [
    index / 63,
    index === 0 || index === 63 ? 0 : (index % 2 ? 0.8 : -0.8),
  ]);
  const document = segmentDocument();
  document.cues[0].curves = controls.map((control) => ({ control: control.token, keys }));
  const accepted = parseRealtimeSegmentLine(JSON.stringify(document), fullProfile);
  assert.equal(accepted.cuesRejected, false);
  assert.equal(accepted.cues[0]?.curves.length, 40);
  assert.equal(accepted.cues[0]?.curves[0]?.keys.length, 64);

  document.cues[0].curves.push({ control: 'c01', keys });
  const rejected = parseRealtimeSegmentLine(JSON.stringify(document), fullProfile);
  assert.equal(rejected.cuesRejected, true);
});

test('a DSH cue may coordinate a discovered PartOpacity layer without making it a primary gesture', () => {
  const base = profile();
  const withParts: ModelProfile = {
    ...base,
    partOpacityControls: [{
      token: 'p01', partId: 'PartArmA', displayName: 'Coordinated visibility layer 1',
      minimum: 0, maximum: 1, base: 0,
    }],
  };
  const document = segmentDocument();
  document.cues[0].curves.push({
    control: 'p01', keys: [[0, 0], [0.5, 1], [1, 0]],
  });
  const parsed = parseRealtimeSegmentLine(JSON.stringify(document), withParts, {
    silhouetteTargetAmplitude: 0.8,
  });
  assert.equal(parsed.cuesRejected, false);
  assert.deepEqual(parsed.cues[0]?.curves.at(-1), {
    parameterId: partOpacityAddress('PartArmA'),
    minimum: 0,
    maximum: 1,
    base: 0,
    keys: [[0, 0], [0.5, 1], [1, 0]],
  });
});

test('a pose group rejects ghost-limb crossfades and requires a synchronized decisive switch', () => {
  const base = profile();
  const withArmPose: ModelProfile = {
    ...base,
    partOpacityControls: [
      {
        token: 'p01', partId: 'PartArmA', displayName: 'Coordinated visibility layer 1',
        minimum: 0, maximum: 1, base: 1,
      },
      {
        token: 'p02', partId: 'PartArmB', displayName: 'Coordinated visibility layer 2',
        minimum: 0, maximum: 1, base: 0,
      },
    ],
    partOpacityGroups: [['PartArmA', 'PartArmB']],
  };
  const incomplete = segmentDocument();
  incomplete.cues[0].curves.push({
    control: 'p01', keys: [[0, 0], [0.5, -1], [1, 0]],
  });
  assert.equal(parseRealtimeSegmentLine(JSON.stringify(incomplete), withArmPose).cuesRejected, true);

  const translucent = structuredClone(incomplete);
  translucent.cues[0].curves = [
    ...translucent.cues[0].curves.slice(0, 1),
    { control: 'p01', keys: [[0, 0], [0.5, -0.7], [1, 0]] },
    { control: 'p02', keys: [[0, 0], [0.5, 0.7], [1, 0]] },
  ];
  assert.equal(parseRealtimeSegmentLine(JSON.stringify(translucent), withArmPose).cuesRejected, true);

  const decisive = structuredClone(translucent);
  decisive.cues[0].curves = [
    ...decisive.cues[0].curves.slice(0, 1),
    { control: 'p01', keys: [[0, 0], [0.2, -1], [0.8, -1], [1, 0]] },
    { control: 'p02', keys: [[0, 0], [0.2, 1], [0.8, 1], [1, 0]] },
  ];
  const accepted = parseRealtimeSegmentLine(JSON.stringify(decisive), withArmPose);
  assert.equal(accepted.cuesRejected, false);
  assert.deepEqual(accepted.cues[0]?.curves.slice(-2).map((curve) => curve.parameterId), [
    partOpacityAddress('PartArmA'),
    partOpacityAddress('PartArmB'),
  ]);

  const flash = structuredClone(decisive);
  flash.cues[0].curves = [
    ...flash.cues[0].curves.slice(0, 1),
    { control: 'p01', keys: [[0, 0], [0.45, -1], [0.55, -1], [1, 0]] },
    { control: 'p02', keys: [[0, 0], [0.45, 1], [0.55, 1], [1, 0]] },
  ];
  assert.equal(parseRealtimeSegmentLine(JSON.stringify(flash), withArmPose).cuesRejected, true);
});

test('explicit movement validation accepts only DSH-authored curves that already meet amplitude and timing', () => {
  const baseProfile = profile();
  const movementProfile: ModelProfile = {
    ...baseProfile,
    controls: [
      ...baseProfile.controls,
      {
        token: 'c02',
        parameterId: 'ParamHairAhoge',
        displayName: 'Hair strand sway',
        minimum: -10,
        maximum: 10,
        base: 0,
      },
    ],
    availableIds: new Set([...baseProfile.availableIds, 'ParamHairAhoge']),
  };
  const secondaryOnly = segmentDocument();
  secondaryOnly.cues[0].curves[0] = {
    control: 'c02',
    keys: [[0, 0], [0.5, 1], [1, 0]],
  };
  const acceptedWithoutGate = parseRealtimeSegmentLine(
    JSON.stringify(secondaryOnly),
    movementProfile,
  );
  assert.equal(acceptedWithoutGate.cuesRejected, false);

  const rejectedSecondary = parseRealtimeSegmentLine(
    JSON.stringify(secondaryOnly),
    movementProfile,
    { silhouetteTargetAmplitude: 0.72 },
  );
  assert.equal(rejectedSecondary.cuesRejected, true);
  assert.deepEqual(rejectedSecondary.cues, []);

  const weakHead = segmentDocument();
  weakHead.cues[0].curves[0].keys = [[0, 0], [0.5, 0.19], [1, 0]];
  const rejectedWeakHead = parseRealtimeSegmentLine(
    JSON.stringify(weakHead),
    movementProfile,
    { silhouetteTargetAmplitude: 0.72 },
  );
  assert.equal(rejectedWeakHead.cuesRejected, true);

  const wrongTiming = segmentDocument();
  wrongTiming.cues[0].at = 0.4;
  wrongTiming.cues[0].span = 0.5;
  wrongTiming.cues[0].curves[0].keys = [[0, 0], [0.5, 0.8], [1, 0]];
  const rejectedWrongTiming = parseRealtimeSegmentLine(
    JSON.stringify(wrongTiming),
    movementProfile,
    { silhouetteTargetAmplitude: 0.72 },
  );
  assert.equal(rejectedWrongTiming.cuesRejected, true);

  const alreadyStrong = segmentDocument();
  alreadyStrong.cues[0].at = 0.1;
  alreadyStrong.cues[0].span = 0.8;
  alreadyStrong.cues[0].curves[0].keys = [[0, 0], [0.5, 0.8], [1, 0]];
  const acceptedStrongHead = parseRealtimeSegmentLine(
    JSON.stringify(alreadyStrong),
    movementProfile,
    { silhouetteTargetAmplitude: 0.72 },
  );
  assert.equal(acceptedStrongHead.cues[0]?.at, 0.1);
  assert.equal(acceptedStrongHead.cues[0]?.span, 0.8);
  assert.equal(acceptedStrongHead.cues[0]?.curves[0]?.keys[1]?.[1], 16);

  const empty = segmentDocument();
  empty.cues = [];
  const rejectedEmpty = parseRealtimeSegmentLine(
    JSON.stringify(empty),
    movementProfile,
    { silhouetteTargetAmplitude: 0.72 },
  );
  assert.equal(rejectedEmpty.cuesRejected, true);
});

test('head-shake validation preserves complete DSH-authored yaw and roll curves without replacing them', () => {
  const baseProfile = profile();
  const shakeProfile: ModelProfile = {
    ...baseProfile,
    controls: [
      ...baseProfile.controls,
      { token: 'roll', parameterId: 'ParamAngleZ', displayName: 'Angle Z', minimum: -30, maximum: 30, base: 0 },
      { token: 'body-roll', parameterId: 'ParamBodyAngleZ', displayName: 'Body Z', minimum: -10, maximum: 10, base: 0 },
    ],
    availableIds: new Set([...baseProfile.availableIds, 'ParamAngleZ', 'ParamBodyAngleZ']),
  };
  const document = segmentDocument();
  document.cues[0].at = 0.1;
  document.cues[0].span = 0.85;
  document.cues[0].curves = [
    {
      control: 'c01',
      keys: [[0, 0], [0.14, -0.85], [0.28, 0.85], [0.42, -0.85], [0.56, 0.85], [0.7, -0.85], [0.84, 0.85], [1, 0]],
    },
    { control: 'roll', keys: [[0, 0], [0.5, 0.65], [1, 0]] },
  ];
  const segment = parseRealtimeSegmentLine(JSON.stringify(document), shakeProfile, {
    silhouetteTargetAmplitude: 0.85,
    headShakeCycles: 3,
  });
  assert.equal(segment.cuesRejected, false);
  assert.equal(segment.cues[0]?.at, 0.1);
  assert.equal(segment.cues[0]?.span, 0.85);
  assert.deepEqual(segment.cues[0]?.curves[0]?.keys, [
    [0, 0],
    [0.14, -25.5],
    [0.28, 17],
    [0.42, -25.5],
    [0.56, 17],
    [0.7, -25.5],
    [0.84, 17],
    [1, 0],
  ]);
  assert.deepEqual(segment.cues[0]?.curves.map((curve) => curve.parameterId), [
    'ParamAngleX',
    'ParamAngleZ',
  ]);
  assert.equal(segment.cues[0]?.curves[1]?.keys[1]?.[1], 19.5);

  const incomplete = structuredClone(document);
  incomplete.cues[0].curves = [{
    control: 'c01',
    keys: [[0, 0], [0.5, 0.85], [1, 0]],
  }];
  const rejected = parseRealtimeSegmentLine(JSON.stringify(incomplete), shakeProfile, {
    silhouetteTargetAmplitude: 0.85,
    headShakeCycles: 3,
  });
  assert.equal(rejected.cuesRejected, true);
  assert.deepEqual(rejected.cues, []);
});

test('invalid cue data preserves speech and rejects the complete cue set', () => {
  const invalidDocuments: any[] = [];
  const add = (mutate: (document: any) => void): void => {
    const document = segmentDocument();
    mutate(document);
    invalidDocuments.push(document);
  };
  add((document) => { document.cues = new Array(4).fill(document.cues[0]); });
  add((document) => { document.cues[0].at = -0.01; });
  add((document) => { document.cues[0].span = 1.01; });
  add((document) => { document.cues[0].at = 0.3; document.cues[0].span = 0.8; });
  add((document) => { document.cues[0].curves = []; });
  add((document) => { document.cues[0].curves = new Array(7).fill(document.cues[0].curves[0]); });
  add((document) => { document.cues[0].curves.push(structuredClone(document.cues[0].curves[0])); });
  add((document) => { document.cues[0].curves[0].control = 'c99'; });
  add((document) => { document.cues[0].curves[0].keys = [[0, 0], [1, 0]]; });
  add((document) => { document.cues[0].curves[0].keys = new Array(9).fill([0, 0]); });
  add((document) => { document.cues[0].curves[0].keys[1][0] = 1.1; });
  add((document) => { document.cues[0].curves[0].keys[1][1] = -1.1; });
  add((document) => { document.cues[0].curves[0].keys[1][0] = 0; });
  add((document) => { document.cues[0].curves[0].keys[1][1] = 0; document.cues[0].curves[0].keys[2][1] = 0; });
  add((document) => { document.cues[0].curves[0].keys[0] = [0.01, 0]; });
  add((document) => { document.cues[0].curves[0].keys.at(-1)[1] = 0.01; });
  add((document) => { document.cues[0].curves[0].extra = true; });

  for (const document of invalidDocuments) {
    const parsed = parseRealtimeSegmentLine(JSON.stringify(document), profile());
    assert.equal(parsed.text, '你好');
    assert.equal(parsed.fallback, 'thinking');
    assert.equal(parsed.cuesRejected, true);
    assert.deepEqual(parsed.cues, []);
  }

  const lipSync = parseRealtimeSegmentLine(
    JSON.stringify(segmentDocument()),
    profile(),
    { lipSyncParameterIds: new Set(['ParamAngleX']) },
  );
  assert.equal(lipSync.cuesRejected, true);
  assert.deepEqual(lipSync.cues, []);
});

test('one-sided controls reflect a dead normalized sign into their usable range', () => {
  const maximumFixture = profile();
  const baseAtMaximum: ModelProfile = {
    ...maximumFixture,
    controls: [{
      ...maximumFixture.controls[0],
      minimum: 0,
      maximum: 1,
      base: 1,
    }],
  };
  const positive = segmentDocument();
  positive.cues[0].curves[0].keys = [[0, 0], [0.5, 1], [1, 0]];
  const positiveResult = parseRealtimeSegmentLine(JSON.stringify(positive), baseAtMaximum);
  assert.equal(positiveResult.cuesRejected, false);
  assert.deepEqual(positiveResult.cues[0].curves[0].keys, [[0, 0], [0.5, -1], [1, 0]]);

  const minimumFixture = profile();
  const baseAtMinimum: ModelProfile = {
    ...minimumFixture,
    controls: [{
      ...minimumFixture.controls[0],
      minimum: -1,
      maximum: 1,
      base: -1,
    }],
  };
  const negative = segmentDocument();
  negative.cues[0].curves[0].keys = [[0, 0], [0.5, -0.5], [1, 0]];
  const negativeResult = parseRealtimeSegmentLine(JSON.stringify(negative), baseAtMinimum);
  assert.equal(negativeResult.cuesRejected, false);
  assert.deepEqual(negativeResult.cues[0].curves[0].keys, [[0, 0], [0.5, 1], [1, 0]]);

  const fixedFixture = profile();
  const fixed: ModelProfile = {
    ...fixedFixture,
    controls: [{
      ...fixedFixture.controls[0],
      minimum: 1,
      maximum: 1,
      base: 1,
    }],
  };
  const fixedResult = parseRealtimeSegmentLine(JSON.stringify(positive), fixed);
  assert.equal(fixedResult.cuesRejected, true);
  assert.deepEqual(fixedResult.cues, []);
  assert.equal(fixedResult.text, positive.text);
});

test('compiler rejects physics, opacity, and lip-sync controls even when a profile exposes them', () => {
  const unsafeProfile = profile();
  const unsafeControls = [
    {
      token: 'c02',
      parameterId: 'ParamPhysicsOutput',
      displayName: 'Physics output',
      minimum: -1,
      maximum: 1,
      base: 0,
    },
    {
      token: 'c03',
      parameterId: 'PartOpacity01',
      displayName: 'Opacity',
      minimum: 0,
      maximum: 1,
      base: 1,
    },
    {
      token: 'c04',
      parameterId: 'ParamMouthOpenY',
      displayName: 'Mouth open',
      minimum: 0,
      maximum: 1,
      base: 0,
    },
  ];
  const exposed = {
    ...unsafeProfile,
    controls: [...unsafeProfile.controls, ...unsafeControls],
    availableIds: new Set([
      ...unsafeProfile.availableIds,
      'ParamPhysicsOutput',
      'PartOpacity01',
      'ParamMouthOpenY',
    ]),
    physicsOutputs: new Set(['ParamPhysicsOutput']),
    partOpacityIds: new Set(['PartOpacity01']),
  };

  for (const control of unsafeControls) {
    const segment = parseRealtimeSegmentLine(JSON.stringify({
      type: 'segment',
      seq: 0,
      text: '安全降级。',
      fallback: 'neutral',
      cues: [{
        id: control.token,
        at: 0,
        span: 1,
        curves: [{ control: control.token, keys: [[0, 0], [0.5, 1], [1, 0]] }],
      }],
    }), exposed, { lipSyncParameterIds: ['ParamMouthOpenY'] });
    assert.equal(segment.cuesRejected, true);
    assert.deepEqual(segment.cues, []);
    assert.equal(segment.text, '安全降级。');
  }
});

test('zero-length cues and blank speech are rejected at the server boundary', () => {
  const blank = JSON.stringify({
    type: 'segment', seq: 0, text: '   ', fallback: 'neutral', cues: [],
  });
  assert.throws(() => parseRealtimeSegmentLine(blank, profile()), /envelope is invalid/u);

  const zeroSpan = JSON.stringify({
    type: 'segment',
    seq: 0,
    text: '保留这句话。',
    fallback: 'thinking',
    cues: [{
      id: 'zero',
      at: 0,
      span: 0,
      curves: [{ control: 'c01', keys: [[0, 0], [0.5, 0.5], [1, 0]] }],
    }],
  });
  const segment = parseRealtimeSegmentLine(zeroSpan, profile());
  assert.equal(segment.cuesRejected, true);
  assert.deepEqual(segment.cues, []);

  const oversizedText = segmentDocument();
  oversizedText.text = 'x'.repeat(MAX_REALTIME_SEGMENT_TEXT_CHARS + 1);
  assert.throws(
    () => parseRealtimeSegmentLine(JSON.stringify(oversizedText), profile()),
    /envelope is invalid/u,
  );

  const nfkcExpansion = segmentDocument();
  nfkcExpansion.text = '㍍'.repeat(126);
  assert.equal([...nfkcExpansion.text].length, 126);
  assert.ok([...nfkcExpansion.text.normalize('NFKC')].length > MAX_REALTIME_SEGMENT_TEXT_CHARS);
  assert.throws(
    () => parseRealtimeSegmentLine(JSON.stringify(nfkcExpansion), profile()),
    /envelope is invalid/u,
  );
});

test('assembler decodes arbitrary UTF-8 chunks and flushes a final line without LF', () => {
  const first = segmentDocument();
  first.text = '你😀';
  const second = segmentDocument();
  second.seq = 1;
  second.text = '好';
  const bytes = new TextEncoder().encode(`${JSON.stringify(first)}\n${JSON.stringify(second)}`);
  const splitInsideUnicode = bytes.indexOf(0xe4) + 1;
  assert.ok(splitInsideUnicode > 0);

  const assembler = new RealtimeSegmentAssembler(profile());
  assert.deepEqual(assembler.push(bytes.subarray(0, splitInsideUnicode)), []);
  const completed = assembler.push(bytes.subarray(splitInsideUnicode));
  assert.deepEqual(completed.map((segment) => [segment.seq, segment.text]), [[0, '你😀']]);
  assert.deepEqual(assembler.finish().map((segment) => [segment.seq, segment.text]), [[1, '好']]);
});

test('strict line parsing rejects malformed envelopes and duplicate keys', () => {
  const extra = segmentDocument();
  extra.reasoning = 'private';
  const badFallback = segmentDocument();
  badFallback.fallback = 'angry';
  const duplicate = JSON.stringify(segmentDocument()).replace('"seq":0', '"seq":0,"seq":1');
  const nestedDuplicate = JSON.stringify(segmentDocument()).replace(
    '"control":"c01"',
    '"control":"c01","control":"c01"',
  );

  for (const line of [
    JSON.stringify(extra),
    JSON.stringify(badFallback),
    duplicate,
    nestedDuplicate,
    '{"type":"segment"',
    ' '.repeat(MAX_REALTIME_LINE_BYTES + 1),
    new Uint8Array([0xff]),
  ]) {
    assert.throws(
      () => parseRealtimeSegmentLine(line, profile()),
      (error: unknown) => error instanceof RealtimeCueProtocolError,
    );
  }
});

test('assembler enforces contiguous sequence and per-turn segment limits', () => {
  const outOfOrder = new RealtimeSegmentAssembler(profile());
  const seqOne = segmentDocument();
  seqOne.seq = 1;
  assert.throws(
    () => outOfOrder.push(`${JSON.stringify(seqOne)}\n`),
    (error: unknown) => error instanceof RealtimeCueProtocolError && error.code === 'sequence_error',
  );

  const tooMany = new RealtimeSegmentAssembler(profile());
  for (let seq = 0; seq < 24; seq += 1) {
    const document = segmentDocument();
    document.seq = seq;
    document.text = 'x';
    assert.equal(tooMany.push(`${JSON.stringify(document)}\n`).length, 1);
  }
  const twentyFifth = segmentDocument();
  twentyFifth.seq = 24;
  assert.throws(
    () => tooMany.push(`${JSON.stringify(twentyFifth)}\n`),
    (error: unknown) => error instanceof RealtimeCueProtocolError && error.code === 'segment_limit',
  );
});

test('assembler counts Unicode code points across the complete turn', () => {
  const assembler = new RealtimeSegmentAssembler(profile());
  for (let seq = 0; seq < 8; seq += 1) {
    const full = segmentDocument();
    full.seq = seq;
    full.text = seq === 7 ? `${'x'.repeat(499)}😀` : 'x'.repeat(500);
    assert.equal(assembler.push(`${JSON.stringify(full)}\n`).length, 1);
  }

  const overflow = segmentDocument();
  overflow.seq = 8;
  overflow.text = 'x';
  assert.throws(
    () => assembler.push(`${JSON.stringify(overflow)}\n`),
    (error: unknown) => error instanceof RealtimeCueProtocolError && error.code === 'text_limit',
  );
});

test('assembler rejects a truncated final line', () => {
  const assembler = new RealtimeSegmentAssembler(profile());
  assert.deepEqual(assembler.push('{"type":"segment"'), []);
  assert.throws(
    () => assembler.finish(),
    (error: unknown) => error instanceof RealtimeCueProtocolError && error.code === 'invalid_ndjson',
  );
});
