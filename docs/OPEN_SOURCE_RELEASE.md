# Open-source release checklist

Use this checklist before making the repository public. It complements the automated checks; it does not replace legal review.

## Repository contents

- [ ] `npm run check:repo` passes.
- [ ] `git status --short` contains only the intended Next.js release changes.
- [ ] `git ls-files` contains `app/models/[...path]/route.ts` and `app/model.config.json/route.ts`.
- [ ] No `models/`, `local-assets/`, root `model.config.json`, generated motion definitions, `.env`, screenshots from `tmp-verify/`, model ZIPs or private prompts are tracked.
- [ ] A trusted secret scanner has checked the full Git history, not only the current working tree.
- [ ] The copyright holder line in `LICENSE` is correct and the upstream Yuki Shindo notice remains intact.
- [ ] Commit author/committer names and email addresses are suitable for public display.

## Quality and licenses

- [ ] `npm run verify` passes on Node 22 and the current Active LTS release.
- [ ] Model changes pass `npm run motions:generate`, `npm run motions:validate` and `npm run verify:browser` locally.
- [ ] Existing model groups are unchanged; generated actions exist only in `PromptSoul`.
- [ ] Screenshots containing Hiyori visibly include `Hiyori Momose ©Live2D` inside the image.
- [ ] `README.md`, `THIRD_PARTY_NOTICES.md` and the release notes describe all new third-party assets.
- [ ] The release workflow never downloads Hiyori or accepts Live2D terms on a contributor's behalf.

## GitHub settings

- [ ] Add the real repository URL to `package.json` as `repository`, `homepage` and `bugs` after the repository exists.
- [ ] Enable Issues, Dependency Graph, Dependabot alerts and Private Vulnerability Reporting.
- [ ] Enable secret scanning and push protection where available.
- [ ] Protect `main`: require CI, block force pushes and prefer reviewed pull requests.
- [ ] Configure squash merging and automatic branch deletion if desired.
- [ ] Use a PromptSoul brand image or a properly attributed Hiyori image for social preview.

Suggested description: `Local-first AI Live2D NPC with safe prompt-to-motion generation`

Suggested topics: `live2d`, `ai-npc`, `nextjs`, `typescript`, `openai-compatible`, `self-hosted`
