# AGENTS.md — PromptSoul Agent Guide

PromptSoul is a local, self-hosted Next.js AI NPC prototype. The Node backend returns a short character reply plus an emotion label; the browser maps that emotion to a Live2D motion. Its motion workshop can also turn a natural-language prompt into a strictly constrained motion specification.

Read this file and `README.md` before changing the project. Preserve completed behavior instead of rebuilding it.

## Architecture

- `app/`, `components/`: Next.js App Router UI and Node Route Handlers.
- `assets/styles.css`, `assets/app.js`: responsive Live2D rendering, interaction, chat/emotion mapping, browser audio playback and runtime lip sync. The legacy runtime is intentionally loaded by `components/legacy-runtime.tsx` to preserve the proven renderer.
- `npc.config.json`: public character copy, suggestions, persona and model attribution.
- `lib/server/provider-*`: OpenAI-compatible Chat Completions client and environment-only settings.
- `lib/server/chat-service.ts`, `lib/server/aituber-chat.ts`: deterministic demo replies plus the AITuber Chat adapter and provider response parsing.
- `lib/server/aivis-*.ts`: local AivisSpeech voice discovery, synthesis, health checks and bounded audio cache.
- `lib/shared/browser-tts.ts`: Japanese streaming segmentation plus the single Web Audio playback, recording and RMS lip-sync manager.
- `lib/server/motion-*`: safe prompt-motion compiler, authoring, generation and independent validation.
- `lib/server/model-*`: model import, safe ZIP handling, Hiyori setup and model analysis.
- `scripts/`: Node/TypeScript CLI entry points. The project has no Python dependency.

The chat API returns `{reply, emotion, mode}`. Allowed emotions are `happy`, `wink`, `nod`, `thinking`, `surprised`, `shy`, `shakehead`, and `neutral`.

The TTS API accepts only validated text, voice selectors and supported synthesis options, then returns WAV bytes from the loopback AivisSpeech Engine. The browser may call only same-origin `/api/tts`; it must never receive the Engine address. TTS failure must never break text chat or motion selection. Lip sync may update runtime mouth parameters only and must never persist model or motion changes.

The preferred generated group is always `PromptSoul`. `Action` is only a read/play compatibility fallback in the browser.

## API Key boundary

- The settings UI must not accept a model API Key. LLM credentials come from server environment variables only.
- LLM keys are read only from the Node server environment. Never write them to process overrides, React state, browser storage, cookies, files, config, logs, responses or Git.
- Public provider/status endpoints may expose mode, source, model and API base, but never the key.
- Keep environment variables (`NPC_API_KEY` or `OPENAI_API_KEY`) as the recommended production configuration.
- Chat, motion and TTS mutations must remain loopback-only, same-origin JSON requests. Do not expose this development server directly to the public internet.

## Typical model workflow

When the user asks to add motions to a model, work autonomously:

1. Locate a supplied ZIP/folder, or search `local-assets/` and the repository for `*.model3.json`. Ask only if no model can be found.
2. Import it with `npm run setup:model -- <zip-or-folder>`. This creates a working copy under `models/` and an ignored `model.config.json`. For the official Hiyori demo, first read the linked Live2D terms and run `npm run setup:demo -- --accept-license`.
3. Always run `npm run analyze:model` before designing motions for a new model.
4. Create or extend `motion-defs/<model-stem>.ts` using that model’s actual parameters. `motion-defs/hiyori_pro_t11.ts` is a format example, not a parameter template.
5. Run `npm run motions:generate`.
6. Fix issues until `npm run motions:validate` passes.
7. Run `npm run verify:browser` and visually inspect real rendered poses.
8. Start `npm run dev` and hand over <http://127.0.0.1:8765>.

## Repository layout

```text
app/                           UI and Node Route Handlers
components/                    React components
assets/                        Live2D browser runtime and CSS
lib/server/                    Server-only provider/chat/model/motion logic
scripts/                       TypeScript CLI entry points
tests-node/                    node:test suites
tools/verify_browser.sh        Chrome screenshot verification (Node server; no Python)
motion-defs/<model>.ts         Model-specific base motion definitions
motion-defs/generated/         Ignored validated AI specifications
npc.config.json                Public character/UI configuration
model.config.json              Ignored generated active-model pointer
local-assets/ , models/        Ignored licensed/generated model data
tmp-verify/                    Ignored browser screenshots
```

Everything under `models/` is generated. Never hand-edit `.motion3.json` or `model3.json`: edit the matching TypeScript definition and regenerate, or use the workshop, which persists a validated spec under `motion-defs/generated/`.

## Motion workshop safety boundary

- The browser sends only `{prompt}` to `/api/motions/generate`. The API Key, model path, raw parameter IDs, curves and raw provider response stay server-side.
- The provider sees opaque controls plus semantic display names and normalized values. The compiler maps them back to the current model profile.
- Treat provider output as data only. Never add `eval`, generated JavaScript/TypeScript, provider-selected paths, shell execution or subprocesses to authoring.
- Accept only the documented JSON schema. Reject unknown fields, duplicate controls, booleans/non-finite numbers, unknown controls, physics outputs, `PartOpacity`, values outside `[-1, 1]`, excessive curves/keyframes, invalid timing, and curves that do not start and finish at the base pose.
- The server owns `promptsoul_ai_<hash>` IDs and every output path. Generated files may only live in the active model’s `motion/` directory and may only be registered in `PromptSoul`.
- Keep the non-blocking generation lock, cross-process lock, atomic writes and model-revision recheck. Never silently delete another generated action at the per-model limit.
- Deletion is explicit and may target only a persisted public `promptsoul_ai_<12hex>` action in the active model. Validate its saved definition, runtime path and single `PromptSoul` registration under the same locks; never expose deletion for built-in PromptSoul actions or model-owned groups.
- An unsupported request returns `motion_not_feasible`; never force an arm, rotation or expression the model cannot express naturally.

## Model-independent design rules

- Never edit rigs or meshes in Cubism Editor; use only existing parameters.
- Stay within ranges observed in existing motions. `npm run analyze:model` prints them and the validator enforces them.
- Every curve must begin and end at the estimated base pose. Bases differ by model; for example Hiyori’s `MouthForm` rests at 1.
- Never animate physics output parameters directly. Move head/body inputs and let physics respond.
- Avoid `PartOpacity` switching; it creates unnatural pops.
- Register only into `PromptSoul`. Never replace or edit `Action`, `Idle`, `Tap` or any other original group.
- Use non-looping actions and conservative fade-in/out values around 0.2–0.5 s.
- If a hand/arm parameter cannot be understood from existing motions, skip the large gesture and express the intent with face/head/body.
- Models without source motions cannot provide reliable observed ranges; stay conservative and verify every result visually.
- Do not keep an unnatural motion. Explain the limitation and propose a feasible alternative.

## Hiyori-specific lessons (examples, not defaults)

- Smiling-arc eyes require `EyeOpen=0` together with `EyeSmile=1`.
- Hiyori’s resting `MouthForm` is 1; the surprised “o” shape is around -1.5.
- Yaw reads subtly; a visible head shake often needs roughly ±20.
- Idle motions park the arms around `ArmLA/RA=-10`, so action arm curves must preserve continuity.

Rediscover equivalent quirks from each new model’s own source motions. Never copy these values blindly.

## Browser debug hooks

| Query | Effect |
|---|---|
| `?play=PromptSoul:0` | Auto-play a motion after load |
| `&freeze=1.2` | Pin the motion pose at the specified second |
| `?uitest=1` | Run synthetic drag/zoom interaction checks |
| `?model=<path>` | Load an explicit model instead of `model.config.json` |

`tools/verify_browser.sh` already handles real-time playback and WebGL/SwiftShader flags. A base-pose-only screenshot means playback failed; inspect every output image for artifacts and unnatural fading.

## UI and license constraints

- Preserve responsive desktop/mobile behavior. Never introduce horizontal overflow.
- Keep text inputs at least 16px on mobile to avoid iOS auto-zoom and interactive targets at least 44×44px.
- Do not modify Hiyori’s character design.
- Screenshots and demos using Hiyori must visibly retain `Hiyori Momose ©Live2D` and the required Live2D attribution.
- `models/`, `local-assets/`, `model.config.json` and generated motion definitions are licensed/local artifacts and must never be committed.

## Definition of Done

Run all of the following after implementation:

```bash
npm run typecheck
npm test
npm run motions:generate
npm run motions:validate
node --check assets/app.js
npm run build
git diff --check
```

For visual changes or motion work, also run `npm run verify:browser` or perform equivalent desktop and 390×844 browser checks. Confirm existing model groups are untouched and the only generated group is `PromptSoul`.
