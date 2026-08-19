# Changelog

All notable changes to PromptSoul are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Next.js App Router UI and local Node Route Handlers.
- Environment-only OpenAI-compatible Provider settings that never expose model credentials to the browser.
- Deterministic no-key chat demo and emotion-driven Live2D playback.
- Local AivisSpeech synthesis with dynamic global Style ID discovery, bounded WAV caching and health APIs.
- Incremental chat reply events, Japanese speech segmentation, ordered Web Audio playback and real RMS lip sync.
- Optional DSH realtime chat backend that emits validated speech/action segments into an in-memory Live2D cue timeline.
- Strict incremental NDJSON parsing, opaque-control compilation, audio-clock cue scheduling, interruption isolation and realtime diagnostics.
- Unattended CDP frame recording with real AudioContext capture and audio/mouth evidence gates.
- Strict prompt-to-motion compiler, safe model import, independent validation and browser verification.
- Explicit deletion for persisted AI-generated `PromptSoul` actions.
- PromptSkin-powered prompt wardrobe with validated texture-only outfit generation, saved presets and live switching.

### Changed

- Replaced the Python runtime and tooling with TypeScript/Node.js.
- Preserved licensed model data and generated actions as ignored local artifacts.
- Removed the superseded cloud voice settings and `/api/voice` implementation; TTS now uses only local AivisSpeech through `/api/tts`.
- Prepared repository governance, CI, contribution, security and third-party licensing documentation for public release.
- Updated the Next.js patch release and vulnerable transitive build dependencies; `npm audit` now reports zero known vulnerabilities.
- Raised the minimum Node.js version to 22.19 and pinned the DSH SDK/runtime package family to `0.1.0-rc.6`.
- Kept realtime DSH cues ephemeral: chat does not create `.motion3.json` files, update model registrations or reload Live2D; the motion workshop remains the persisted asset-authoring path.
- Prevented one-sided model controls from compiling into accepted zero-motion realtime cues, with verified frame-write diagnostics and fallback on binding failure.
