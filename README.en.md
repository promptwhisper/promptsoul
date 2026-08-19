<p align="center">
  <img src="./docs/images/promptsoul-banner.svg" width="100%" alt="PromptSoul — local-first AI Live2D NPC">
</p>

# PromptSoul

[简体中文](README.md) · English · [日本語](README.ja.md)

PromptSoul is a local-first Next.js AI Live2D NPC: it streams character replies, maps emotions to motions, generates safe model-specific actions from prompts, and can speak through local AivisSpeech with real-audio lip sync.

<sub>Demo character: Hiyori Momose ©Live2D. Model data is not included in this repository.</sub>

> This content uses sample data owned and copyrighted by Live2D Inc. The sample data are utilized in accordance with terms and conditions set by Live2D Inc. This content itself is created at the author’s sole discretion.

Main capabilities include streaming chat and emotion motions, optional DSH realtime cues, safe prompt-to-motion generation, local voice and lip sync, responsive Live2D controls, and safe model import and validation.

## Quick start

Requirements: Node.js 22.19+, npm, a modern browser, and network access. Python is not required.

Before downloading Hiyori, read the [Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html) and [Cubism Sample Data Terms of Use](https://www.live2d.com/en/learn/sample/model-terms/). Run the setup command only if you accept both.

```bash
npm ci
npm run setup:demo -- --accept-license
npm run motions:generate
npm run motions:validate
npm run dev
```

Open <http://127.0.0.1:8765>.

Without an API Key, chat uses deterministic local replies. Without AivisSpeech, text chat, Live2D, and motions still work; only voice is unavailable.

For production on a trusted self-hosted machine, run `npm run build` and then `npm start`. PromptSoul needs persistent local model and cache files, so Edge and ephemeral Serverless runtimes are not supported.

## Configure the AI Provider

PromptSoul supports OpenAI-compatible Chat Completions providers. LLM credentials are read only by the Node server and are never sent to the browser.

```bash
export NPC_API_KEY="your-api-key"
export NPC_API_BASE="https://api.openai.com/v1"
export NPC_MODEL="your-provider-model"
npm run dev
```

`NPC_API_KEY` takes precedence over `OPENAI_API_KEY`. The default model is `gpt-5.6-luna`; replace it if unsupported, then restart the server. The Motion Workshop also needs a provider. Chat and prompts are sent to it, but model files, raw parameter IDs, curves, and local paths are not.

## Optional DeepSeek Harness realtime chat

The default chat path is unchanged. To stream validated speech segments with temporary Live2D parameter cues, add these server-only values to `.env.local`:

```dotenv
CHAT_BACKEND=dsh-realtime
DEEPSEEK_API_KEY=your-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DSH_MODEL=deepseek-v4-flash
```

Each accepted NDJSON segment enters the existing TTS queue while its cue follows the same AudioContext clock. Cues stay in browser memory: they never write motion files, alter model groups, or replace the Motion Workshop. The Key and raw DSH events stay server-side, and the child runtime receives only an allowlisted environment. Remove `CHAT_BACKEND` to use the original Provider/demo path.

DSH receives the active controls' raw Cubism Parameter/PartOpacity IDs, ranges and base values, plus up to three complete, unmodified existing `.motion3.json` references selected for the request. A realtime cue may contain 40 curves with 64 keys each, enough to learn from all 35 curves in Hiyori `hiyori_m08` instead of reducing it to a small pose template. It does not receive `.moc3`, textures, or API keys. PartOpacity must be coordinated with a primary pose curve and is restored after playback.

## Optional local voice

Voice uses the local [AivisSpeech Engine](https://github.com/Aivis-Project/AivisSpeech-Engine) at `127.0.0.1:10101`. It requires no cloud TTS Key.

Install and start AivisSpeech, import a voice model with the required style, then copy the relevant values from `.env.example` into your existing `.env.local`:

```dotenv
TTS_PROVIDER=aivis
AIVIS_BASE_URL=http://127.0.0.1:10101
AIVIS_SPEAKER_UUID=5680ac39-43c9-487a-bc3e-018c0d29cc38
AIVIS_STYLE_NAME=あまあま
AIVIS_STYLE_ID=
```

Normally leave `AIVIS_STYLE_ID` empty. A model's internal Style ID (for example `1`) is not the global Style ID used by the Engine API. PromptSoul resolves and verifies the current global ID through `/speakers`.

Check the installed voice and generate a real WAV smoke test:

```bash
npm run tts:check
npm run tts:smoke
npm run dev
```

`tts:smoke` writes the ignored file `artifacts/tts-smoke.wav`. The Engine address stays server-side, and TTS failure does not interrupt chat or motions. See `.env.example` for optional settings. The local WAV cache may contain conversation audio; disable it with `TTS_CACHE_ENABLED=false` or stop PromptSoul and remove `.cache/aivis-tts/`. Never commit AIVMX models or generated audio, and follow each voice model's license.

## Prompt-to-motion generation

Enter an action in the Motion Workshop after configuring a provider and model. Results are constrained to supported parameters, validated, and registered only in `PromptSoul`; model-owned `Action`, `Idle`, and `Tap` groups are never overwritten. Unsupported requests return `motion_not_feasible`.

## Prompt wardrobe and saved outfits

PromptSoul can connect to [PromptSkin](https://github.com/promptwhisper/PromptSkin). The Prompt Wardrobe can generate an outfit from a text description, then switch instantly between the original texture and every previously generated outfit.

Start the PromptSkin backend (normally on `127.0.0.1:8000`) and add these server-only values to PromptSoul's `.env.local`:

```dotenv
PROMPTSKIN_API_BASE=http://127.0.0.1:8000
PROMPTSKIN_PROVIDER=openai
PROMPTSKIN_GENERATION_TIMEOUT_MS=720000
```

Configure the image API Key only in PromptSkin. Set `PROMPTSKIN_PROVIDER=mock` to test the complete local pipeline without an image API.

For generation, the PromptSoul server creates a temporary ZIP of the active model and sends it to PromptSkin. A result is accepted only when its `.model3.json`, `.moc3`, texture references, and texture dimensions match the active model. PromptSoul stores and swaps PNG textures only; UVs, rigging, physics, parameters, and motions stay unchanged. Saved outfits live under the Git-ignored `local-assets/wardrobe/`. The wardrobe is automatically disabled for Hiyori because its character design must not be modified.

An existing PromptSkin export can be added to the same preset list:

```bash
npm run wardrobe:import -- /path/to/promptskin-export.zip --name "Dark academy"
# Add --activate to wear it immediately after import.
```

When PromptSkin uses a cloud image provider, outfit prompts and editable textures are sent to that provider. Upload only models and artwork you are authorized to modify and process.

## Use another Live2D model

The ZIP or directory should use Cubism 4 format and contain a `*.model3.json` with all referenced resources. Confirm actual compatibility with `npm run verify:browser`.

```bash
npm run setup:model -- /path/to/model-folder-or.zip
npm run analyze:model
# Review the analysis, then create or edit motion-defs/<model-name>.ts
npm run motions:generate
npm run motions:validate
npm run verify:browser
npm run dev
```

Update the character details and `modelAttribution` in `npc.config.json` so the UI and every screenshot retain the attribution required by the model's license.

## Verification

```bash
npm run verify
git diff --check
# Also run these for model, motion, or visual changes:
npm run motions:generate
npm run motions:validate
npm run verify:browser
```

`verify:browser` requires Chrome, Bash, `curl`, and `seq`. Set `CHROME=/path/to/chrome` when needed, and inspect both desktop and mobile output.

## Security and local files

- Keep LLM Keys in server environment variables. Never commit `.env.local`, expose this unauthenticated local server publicly, or put Keys in browser code, logs, screenshots, or model files.
- Do not commit `models/`, `local-assets/`, `model.config.json`, AIVMX/WAV/video/cache files, or licensed assets. Generated motions may use existing parameters and write only to `PromptSoul`.

See [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [AGENTS.md](AGENTS.md) before reporting issues or contributing changes.

## License and upstream

Code and documentation that the copyright holders are entitled to license are available under the [MIT License](LICENSE). This does not license Hiyori, Live2D Cubism Core, AivisSpeech, AIVMX voice models, user models, or other third-party assets. Hiyori's design must not be modified; screenshots and demos must visibly retain `Hiyori Momose ©Live2D` and the required statement.

Live2D Cubism Core remains subject to the [Live2D Proprietary Software License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html). AivisSpeech is not bundled and is distributed upstream under [GNU LGPL v3](https://github.com/Aivis-Project/AivisSpeech-Engine/blob/master/LICENSE); each voice model may use a different license. DeepSeek Harness packages are pinned to `0.1.0-rc.6`; their MIT license does not cover DeepSeek API or model services. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details.

PromptSoul extends [shinshin86/live2d-add-motion-sample-web-ui](https://github.com/shinshin86/live2d-add-motion-sample-web-ui). Its upstream MIT copyright notice is retained in this repository.
