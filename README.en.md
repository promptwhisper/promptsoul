# PromptSoul

[简体中文](README.md) · English · [日本語](README.ja.md)

PromptSoul is a local-first, self-hosted AI Live2D NPC prototype. A Next.js server returns a short character reply and an emotion label, the browser maps that emotion to a Live2D motion, and the Motion Workshop can compile a natural-language prompt into a strictly constrained action supported by the current model.

> The AI never edits meshes, rigging, or Cubism bindings. Generated actions may use only existing model parameters and may be registered only in the project-owned `PromptSoul` motion group.

![PromptSoul — AI Live2D NPC Lab](docs/images/promptsoul-banner.svg)

<sub>Demo character: Hiyori Momose ©Live2D. Model data is not included in this repository.</sub>

> This content uses sample data owned and copyrighted by Live2D Inc. The sample data are utilized in accordance with terms and conditions set by Live2D Inc. This content itself is created at the author’s sole discretion.

## Project status

PromptSoul is an experimental local development prototype. It has no accounts, tenant isolation, public-network authentication, or rate limiting. The server binds to `127.0.0.1`; do not expose it directly to the public internet.

## Quick start

Requirements: a supported Node.js 22+ release, npm, a modern browser, and network access. Python is not required. The page loads Live2D Cubism Core, PixiJS, and `pixi-live2d-display` from pinned CDN resources.

Before downloading the Hiyori demo, read the [Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html) and [Live2D Cubism Sample Data Terms of Use](https://www.live2d.com/en/learn/sample/model-terms/). Run the setup command only if you agree.

```bash
npm ci

# First use only: explicitly confirm that you accept the linked terms.
npm run setup:demo -- --accept-license
npm run motions:generate
npm run motions:validate

npm run dev
```

Open <http://127.0.0.1:8765>. Without an API Key, chat uses deterministic local demo replies while the Live2D renderer, existing actions, and interactions remain available. The Motion Workshop requires an AI Provider.

For a production build on a trusted self-hosted machine:

```bash
npm run build
npm start
```

PromptSoul reads and writes a local model working copy and keeps temporary Provider settings in process memory. It is not designed for Edge or ephemeral Serverless runtimes.

## AI Provider

The top-right settings panel accepts an OpenAI-compatible API base URL, model name, and API Key.

- The browser submits the Key once to the same-origin local Node server.
- The Key is kept only in Node process memory and is never written to browser storage, cookies, config files, logs, responses, or Git.
- Provider mutations require a same-origin JSON request on a loopback host.
- Remote Providers must use HTTPS; HTTP is accepted only for loopback services.
- Character persona, chat content, and motion prompts are sent to the Provider you configure.
- Live2D model files, raw parameter IDs, generated curves, and local paths are not sent to the Provider.

For long-running local deployments, export server environment variables from the launch shell:

```bash
export NPC_API_KEY="your API Key"
export NPC_API_BASE="https://api.openai.com/v1"
export NPC_MODEL="gpt-5.6-luna"
npm start
```

`NPC_API_KEY` takes precedence over `OPENAI_API_KEY`. Runtime settings entered in the UI take precedence until they are cleared or the process restarts.

`gpt-5.6-luna` is PromptSoul's current default Provider model name and is not available from every OpenAI-compatible service. Select a model actually supported by your Provider if it returns a model-not-found error.

## Prompt-to-motion generation

After a Provider and model are available, describe an action such as “look surprised, lean back, then nod and return to the starting pose.” The server:

1. derives safe parameter ranges, base poses, and physics outputs from the current model;
2. sends the Provider only opaque controls, semantic labels, and normalized values;
3. rejects unknown fields, arbitrary code, physics outputs, `PartOpacity`, out-of-range values, invalid keyframes, and curves that do not return to the base pose;
4. writes atomically and updates only the `PromptSoul` group;
5. reloads the model and previews the generated action.

Persisted AI actions use server-owned `promptsoul_ai_<hash>` IDs. Only those actions show a delete control. Built-in actions and model-owned groups such as `Action`, `Idle`, and `Tap` cannot be deleted from the UI.

If the current model cannot express a request naturally and safely, the API returns `motion_not_feasible` instead of forcing unsupported parameters.

## Using another Live2D model

The ZIP or directory must contain a Cubism 4 `*.model3.json` file and every referenced texture, `.moc3`, physics, and motion resource.

```bash
npm run setup:model -- /path/to/model-folder-or.zip
npm run analyze:model
```

Always inspect the analysis before creating `motion-defs/<model-name>.ts`. Hiyori parameter values are examples, not a template for another rig.

```bash
npm run motions:generate
npm run motions:validate
npm run verify:browser
npm run dev
```

Update `npc.config.json` and `modelAttribution` when replacing the character so every stage, screenshot, and demo retains the attribution required by that model's license.

## Repository layout

```text
app/                         Next.js pages and Node Route Handlers
components/                  React UI, including process-memory Provider settings
assets/                      Live2D browser runtime and responsive styles
lib/server/                  Provider, chat, model, and motion safety logic
scripts/                     Node/TypeScript command-line tools
tests-node/                  node:test suites
motion-defs/<model>.ts       Model-specific built-in motion definitions
motion-defs/generated/       Ignored local AI motion specifications
npc.config.json              Character, greeting, suggestions, and attribution
model.config.json            Ignored active-model pointer generated locally
local-assets/ , models/      Ignored licensed/generated model data
```

## Verification

Model-independent checks:

```bash
npm run verify
git diff --check
```

For model, motion, or visual changes, also run:

```bash
npm run motions:generate
npm run motions:validate
npm run verify:browser
```

Inspect real rendered poses and both desktop and 390×844 layouts. A base-pose-only screenshot means playback failed.

`npm run verify:browser` requires Chrome, Bash, `curl`, and `seq`, and is intended for macOS, Linux, or WSL. Set `CHROME=/path/to/chrome` when Chrome is not installed at the default macOS path.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request and follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately according to [SECURITY.md](SECURITY.md); never include a real API Key, private model, or restricted asset in a public report.

## License and upstream

Code and documentation that the copyright holders are entitled to license are available under the [MIT License](LICENSE). This does not license Hiyori, Live2D Cubism Core, user-supplied models, or other third-party assets. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the complete boundary.

PromptSoul extends [shinshin86/live2d-add-motion-sample-web-ui](https://github.com/shinshin86/live2d-add-motion-sample-web-ui), which demonstrated how to add motions to existing Live2D parameters through JSON without opening Cubism Editor. The upstream MIT copyright notice remains in this repository.
