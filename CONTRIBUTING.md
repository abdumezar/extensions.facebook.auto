# Contributing to Nashir

Thanks for helping. Nashir (ناشِر) is a free, Arabic-first Chrome extension for posting to Facebook groups. Bug reports, fixes, translations and documentation are all welcome.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- Small fixes: open a pull request directly.
- New features or larger changes: open an issue first so the approach can be agreed before you spend time on it.
- Security problems: do not open a public issue. See [SECURITY.md](SECURITY.md).

## Setup

You need Node.js 22 or newer and pnpm 10.

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts the Vite dev build. To try it in Chrome, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and select the extension build output folder (`packages/extension/dist`).

The repository is a pnpm monorepo:

| Path | Contents |
| --- | --- |
| `packages/extension` | The Chrome MV3 extension: background, dashboard, popup, content scripts and engine |
| `packages/shared` | Types, messaging contracts and the Facebook recipe shared by the extension |

## Checks

Run all three before you open a pull request. CI runs the same commands.

```bash
pnpm typecheck
pnpm test
pnpm build
```

To run a single test file:

```bash
pnpm --filter @nashir/extension exec vitest run path/to/file.test.ts
pnpm --filter @nashir/shared exec vitest run path/to/file.test.ts
```

Write the failing test first, then the code that makes it pass. Tests must be deterministic and use synthetic data only: no real names, profile URLs, phone numbers, group names or captured responses.

## Facebook calls must go through GovernedHttp

Every request to Facebook goes through `GovernedHttp` (`packages/extension/src/engine/GovernedHttp.ts`). It applies the call governor: pacing, caps, cooldowns and back-off. This is what keeps the extension from hammering Facebook and getting accounts restricted.

When you add a new Facebook call:

- Send it through `GovernedHttp`. Do not call `fetch` for Facebook yourself.
- Give the operation a clear name, so it is counted in the **Facebook call budget** card on the Logs page and listed in the **Facebook operations** card.
- Do not raise or bypass the existing safety limits (daily and per-batch caps, spacing between actions, cooldown state, `SafetyPolicy`) without discussing it in an issue first. Changes that make the extension more aggressive will not be accepted.

## Capturing a doc_id safely

Facebook identifies each GraphQL operation by a numeric `doc_id`, and it changes now and then. The current values live in `packages/shared/src/recipe/fbRecipe.ts`. When one breaks, you may need to read the new one from a real session.

1. Open the DevTools Network tab on facebook.com and perform the action once.
2. Find the `graphql` request for it and note the operation's friendly name and the `doc_id` value in the request form data.
3. Copy only the number into `fbRecipe.ts`, with the operation name next to it.

Never commit HAR files, screenshots of the Network tab, cookies, tokens, or any response body. A recording of a logged-in session contains session secrets and the personal data of people who never agreed to be in this repository. Delete the recording after you read the number. `*.har` is ignored by git, but check what you stage anyway.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/), for example `feat(engine): retry a refused group page after the cooldown`, `fix(groups): load large group lists in batches`, `docs: explain how to capture a doc_id`.
- One logical change per commit and per pull request.
- Match the style of the surrounding code, including comment density.
- Do not add dependencies unless the change cannot reasonably be done without one, and say why in the pull request.
- Update `CHANGELOG.md` under `Unreleased` for anything a user would notice.
- Fill in the pull request template.

## Releases

Maintainers cut releases.

1. Update `version` in `packages/extension/package.json`. In `CHANGELOG.md`, move the `Unreleased` entries under a heading for the new version that carries the release date, for example `## [1.0.1] - 2026-12-01`.
2. Merge to `main`. To rehearse first, run the **Release** workflow by hand from the Actions tab: it does everything except publish and does not check the tag.
3. Push a tag named `v` plus that version (for example `v1.0.1`) on a commit that is on `main`. The workflow fails if the tag does not match the version in `packages/extension/package.json`, if the commit is not on `main`, or if the changelog heading has no date.
4. The workflow tests, builds and packages the extension. Signing runs in the GitHub Environment `release` and waits for the repository owner's approval.
5. After approval, the workflow publishes the GitHub Release with the zip, its signature and a checksum file, and uses the changelog section as the release notes.

### Approving a release

Whoever can push a tag controls the release workflow, because the workflow file is read from the tagged commit. The approval of the `release` environment is the safeguard, so do not approve on autopilot. Before you approve:

1. The run was triggered by a tag push you made (or is a manual dry run on `main` that you started yourself — refuse a run started from any other ref), and its commit SHA equals the commit you reviewed on `main`.
2. This diff is empty, or you have reviewed it: `git diff <previous tag>..<sha> -- .github/workflows packages/extension/scripts/sign-release.mjs packages/extension/src/update/releaseKeys.json pnpm-lock.yaml`.
3. In the build job's log, the tag, on-`main`, release-build and pack checks passed, and the SHA-256 it printed for the zip equals the one the sign job checked.

A manual run of the **Release** workflow also asks for approval and also signs, with the real signing secret. That is how a dry run proves the secret matches `releaseKeys.json`. It publishes nothing and keeps no signed files.

In the repository settings, the `release` environment's deployment rules must allow the tag pattern `v*` and the branch `main`, and nothing else.

## Contribution terms

Nashir is released under the [GNU General Public License v3.0](LICENSE) (GPL-3.0-only). By submitting a contribution you confirm that you wrote it or have the right to submit it, and you agree that it is released under the same terms.
