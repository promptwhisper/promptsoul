# CLAUDE.md

The shared AI-agent guide is [AGENTS.md](AGENTS.md). Read it and `README.md` before working.

Key constraints:

- The app is a Next.js/Node monolith and has no Python dependency.
- Everything under `models/` is generated; never edit it directly. Edit `motion-defs/<model>.ts`, then run the TypeScript motion tools.
- Analyze every replacement model before designing motions; never copy Hiyori parameters blindly.
- New motions belong only to `PromptSoul`; preserve all original model groups.
- A key entered in the UI must remain in Node process memory only—never browser storage, files, logs, responses or Git.
- Run the complete Definition of Done from `AGENTS.md`, including browser visual checks when relevant.
