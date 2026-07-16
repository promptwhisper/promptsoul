import type {
  CurveBuilder,
  MotionBuilder,
  MotionDefinitionModule,
  MotionDocument,
  MotionManifestEntry,
} from '../lib/server/motion-generator';

/** Model-specific Hiyori definitions. Values come from this model's observed motions. */
export const define: MotionDefinitionModule['define'] = (curve: CurveBuilder, motion: MotionBuilder) => {
  const motions: Record<string, MotionDocument> = {};
  let duration: number;

  duration = 3;
  motions.hiyori_happy = motion(duration, [
    curve('ParamAngleY', [[0, 0], [0.4, 12], [0.8, -8], [1.2, 10], [1.6, -6], [2.2, 4], [duration, 0]]),
    curve('ParamAngleZ', [[0, 0], [0.6, -8], [1.4, 8], [2.2, -3], [duration, 0]]),
    curve('ParamBodyAngleY', [[0, 0], [0.4, 6], [0.8, -3], [1.2, 6], [1.6, -2], [2.2, 3], [duration, 0]]),
    curve('ParamBodyAngleZ', [[0, 0], [0.7, -5], [1.5, 5], [2.3, -2], [duration, 0]]),
    curve('ParamEyeLSmile', [[0, 0], [0.3, 1], [2.4, 1], [duration, 0]]),
    curve('ParamEyeRSmile', [[0, 0], [0.3, 1], [2.4, 1], [duration, 0]]),
    curve('ParamEyeLOpen', [[0, 1], [0.3, 0], [2.4, 0], [duration, 1]]),
    curve('ParamEyeROpen', [[0, 1], [0.3, 0], [2.4, 0], [duration, 1]]),
    curve('ParamBrowLY', [[0, 0], [0.3, 0.6], [2.4, 0.6], [duration, 0]]),
    curve('ParamBrowRY', [[0, 0], [0.3, 0.6], [2.4, 0.6], [duration, 0]]),
    curve('ParamCheek', [[0, 0], [0.3, 0.8], [2.4, 0.8], [duration, 0]]),
    curve('ParamMouthForm', [[0, 1], [duration, 1]]),
    curve('ParamMouthOpenY', [[0, 0], [0.35, 0.8], [0.9, 0.4], [1.3, 0.7], [2, 0.5], [2.6, 0], [duration, 0]]),
    curve('ParamShoulder', [[0, 0], [0.4, 0.8], [0.9, 0.2], [1.3, 0.7], [2, 0.3], [2.6, 0], [duration, 0]]),
    curve('ParamHairAhoge', [[0, 0], [0.5, 6], [1.1, -5], [1.7, 4], [2.3, -2], [duration, 0]]),
  ]);

  duration = 2;
  motions.hiyori_wink = motion(duration, [
    curve('ParamEyeROpen', [[0, 1], [0.3, 0], [1.2, 0], [1.5, 1], [duration, 1]]),
    curve('ParamEyeRSmile', [[0, 0], [0.3, 1], [1.2, 1], [1.5, 0], [duration, 0]]),
    curve('ParamEyeLOpen', [[0, 1], [duration, 1]]),
    curve('ParamBrowRY', [[0, 0], [0.3, -0.3], [1.2, -0.3], [1.6, 0], [duration, 0]]),
    curve('ParamAngleX', [[0, 0], [0.35, 6], [1.3, 6], [duration, 0]]),
    curve('ParamAngleZ', [[0, 0], [0.35, -12], [1.3, -12], [duration, 0]]),
    curve('ParamBodyAngleZ', [[0, 0], [0.4, -4], [1.3, -4], [duration, 0]]),
    curve('ParamMouthForm', [[0, 1], [duration, 1]]),
    curve('ParamMouthOpenY', [[0, 0], [0.35, 0.5], [1.2, 0.3], [1.7, 0], [duration, 0]]),
  ]);

  duration = 2.2;
  motions.hiyori_nod = motion(duration, [
    curve('ParamAngleY', [[0, 0], [0.35, -22], [0.7, -4], [1, -18], [1.5, 0], [duration, 0]]),
    curve('ParamBodyAngleY', [[0, 0], [0.4, -3], [1.1, -2], [1.6, 0], [duration, 0]]),
    curve('ParamEyeLOpen', [[0, 1], [0.35, 0.55], [0.7, 0.9], [1, 0.6], [1.5, 1], [duration, 1]]),
    curve('ParamEyeROpen', [[0, 1], [0.35, 0.55], [0.7, 0.9], [1, 0.6], [1.5, 1], [duration, 1]]),
    curve('ParamBrowLY', [[0, 0], [0.35, 0.3], [1.5, 0], [duration, 0]]),
    curve('ParamBrowRY', [[0, 0], [0.35, 0.3], [1.5, 0], [duration, 0]]),
    curve('ParamMouthForm', [[0, 1], [duration, 1]]),
  ]);

  duration = 4;
  motions.hiyori_thinking = motion(duration, [
    curve('ParamAngleX', [[0, 0], [0.8, -12], [3.2, -12], [duration, 0]]),
    curve('ParamAngleY', [[0, 0], [0.8, 6], [3.2, 6], [duration, 0]]),
    curve('ParamAngleZ', [[0, 0], [0.8, 14], [3.2, 14], [duration, 0]]),
    curve('ParamEyeBallX', [[0, 0], [0.7, -0.8], [2, -0.8], [2.4, -0.5], [3.2, -0.8], [duration, 0]]),
    curve('ParamEyeBallY', [[0, 0], [0.7, 0.7], [3.2, 0.7], [duration, 0]]),
    curve('ParamEyeLOpen', [[0, 1], [0.8, 0.75], [3.2, 0.75], [duration, 1]]),
    curve('ParamEyeROpen', [[0, 1], [0.8, 0.75], [3.2, 0.75], [duration, 1]]),
    curve('ParamBrowLY', [[0, 0], [0.8, -0.3], [3.2, -0.3], [duration, 0]]),
    curve('ParamBrowRY', [[0, 0], [0.8, -0.3], [3.2, -0.3], [duration, 0]]),
    curve('ParamBrowLForm', [[0, 0], [0.8, -0.7], [3.2, -0.7], [duration, 0]]),
    curve('ParamBrowRForm', [[0, 0], [0.8, -0.7], [3.2, -0.7], [duration, 0]]),
    curve('ParamBrowLAngle', [[0, 0], [0.8, -0.5], [3.2, -0.5], [duration, 0]]),
    curve('ParamBrowRAngle', [[0, 0], [0.8, -0.5], [3.2, -0.5], [duration, 0]]),
    curve('ParamMouthForm', [[0, 1], [0.8, -1.2], [3.2, -1.2], [duration, 1]]),
    curve('ParamMouthOpenY', [[0, 0], [duration, 0]]),
    curve('ParamBodyAngleZ', [[0, 0], [0.9, 6], [3.2, 6], [duration, 0]]),
  ]);

  duration = 2.5;
  motions.hiyori_surprised = motion(duration, [
    curve('ParamEyeLOpen', [[0, 1], [0.15, 1.2], [1.4, 1.2], [2, 1], [duration, 1]]),
    curve('ParamEyeROpen', [[0, 1], [0.15, 1.2], [1.4, 1.2], [2, 1], [duration, 1]]),
    curve('ParamBrowLY', [[0, 0], [0.15, 1], [1.4, 1], [2, 0], [duration, 0]]),
    curve('ParamBrowRY', [[0, 0], [0.15, 1], [1.4, 1], [2, 0], [duration, 0]]),
    curve('ParamBrowLForm', [[0, 0], [0.15, 0.3], [1.4, 0.3], [2, 0], [duration, 0]]),
    curve('ParamBrowRForm', [[0, 0], [0.15, 0.2], [1.4, 0.2], [2, 0], [duration, 0]]),
    curve('ParamMouthForm', [[0, 1], [0.15, -1.5], [1.4, -1.5], [2.1, 1], [duration, 1]]),
    curve('ParamMouthOpenY', [[0, 0], [0.15, 0.9], [1.4, 0.8], [2.1, 0], [duration, 0]]),
    curve('ParamAngleY', [[0, 0], [0.15, 18], [0.5, 12], [1.4, 12], [2.1, 0], [duration, 0]]),
    curve('ParamBodyAngleY', [[0, 0], [0.18, 8], [1.4, 6], [2.2, 0], [duration, 0]]),
    curve('ParamShoulder', [[0, 0], [0.15, 1], [1.4, 0.8], [2.1, 0], [duration, 0]]),
    curve('ParamHairAhoge', [[0, 0], [0.2, 8], [0.6, -6], [1, 4], [1.5, 0], [duration, 0]]),
  ]);

  duration = 4;
  motions.hiyori_shy = motion(duration, [
    curve('ParamCheek', [[0, 0], [0.6, 1], [3.4, 1], [duration, 0]]),
    curve('ParamAngleX', [[0, 0], [0.8, 10], [2, 6], [3.3, 9], [duration, 0]]),
    curve('ParamAngleY', [[0, 0], [0.7, -14], [3.3, -12], [duration, 0]]),
    curve('ParamAngleZ', [[0, 0], [0.9, 7], [2.2, 4], [3.3, 7], [duration, 0]]),
    curve('ParamEyeBallX', [[0, 0], [0.7, 0.6], [2, 0.4], [3.3, 0.6], [duration, 0]]),
    curve('ParamEyeBallY', [[0, 0], [0.7, -0.6], [3.3, -0.5], [duration, 0]]),
    curve('ParamEyeLOpen', [[0, 1], [0.7, 0.65], [3.3, 0.65], [duration, 1]]),
    curve('ParamEyeROpen', [[0, 1], [0.7, 0.65], [3.3, 0.65], [duration, 1]]),
    curve('ParamEyeLSmile', [[0, 0], [0.7, 0.5], [3.3, 0.5], [duration, 0]]),
    curve('ParamEyeRSmile', [[0, 0], [0.7, 0.5], [3.3, 0.5], [duration, 0]]),
    curve('ParamBrowLY', [[0, 0], [0.7, -0.2], [3.3, -0.2], [duration, 0]]),
    curve('ParamBrowRY', [[0, 0], [0.7, -0.2], [3.3, -0.2], [duration, 0]]),
    curve('ParamBrowLForm', [[0, 0], [0.7, -0.6], [3.3, -0.6], [duration, 0]]),
    curve('ParamBrowRForm', [[0, 0], [0.7, -0.6], [3.3, -0.6], [duration, 0]]),
    curve('ParamMouthForm', [[0, 1], [0.7, 0.3], [3.3, 0.3], [duration, 1]]),
    curve('ParamMouthOpenY', [[0, 0], [0.7, 0.15], [3.3, 0.1], [duration, 0]]),
    curve('ParamBodyAngleZ', [[0, 0], [1, -6], [2.2, -3], [3.4, -6], [duration, 0]]),
    curve('ParamShoulder', [[0, 0], [0.7, 0.5], [3.3, 0.5], [duration, 0]]),
  ]);

  duration = 2.4;
  motions.hiyori_shakehead = motion(duration, [
    curve('ParamAngleX', [[0, 0], [0.3, -24], [0.7, 20], [1.1, -16], [1.5, 10], [1.9, 0], [duration, 0]]),
    curve('ParamBodyAngleX', [[0, 0], [0.35, -4], [0.75, 4], [1.15, -3], [1.55, 2], [2, 0], [duration, 0]]),
    curve('ParamEyeLOpen', [[0, 1], [0.3, 0.7], [1.5, 0.7], [1.9, 1], [duration, 1]]),
    curve('ParamEyeROpen', [[0, 1], [0.3, 0.7], [1.5, 0.7], [1.9, 1], [duration, 1]]),
    curve('ParamBrowLForm', [[0, 0], [0.3, -0.5], [1.6, -0.5], [2.1, 0], [duration, 0]]),
    curve('ParamBrowRForm', [[0, 0], [0.3, -0.5], [1.6, -0.5], [2.1, 0], [duration, 0]]),
    curve('ParamMouthForm', [[0, 1], [0.3, -0.8], [1.6, -0.8], [2.1, 1], [duration, 1]]),
  ]);

  const manifest: MotionManifestEntry[] = [
    ['hiyori_happy', '开心', 0.5, 0.5],
    ['hiyori_wink', '眨眼', 0.5, 0.5],
    ['hiyori_nod', '点头', 0.4, 0.5],
    ['hiyori_thinking', '思考', 0.5, 0.5],
    ['hiyori_surprised', '惊讶', 0.2, 0.5],
    ['hiyori_shy', '害羞', 0.5, 0.5],
    ['hiyori_shakehead', '摇头', 0.4, 0.5],
  ];
  return { motions, manifest };
};
