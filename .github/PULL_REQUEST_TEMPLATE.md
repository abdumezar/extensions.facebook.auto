## What and why

<!-- What does this change, and why? Link the issue it closes, e.g. "Closes #123". -->

## How it was checked

<!-- Tests you added or ran, and anything you tried by hand in Chrome. -->

## Checklist

- [ ] `pnpm typecheck`, `pnpm test` and `pnpm build` pass
- [ ] A failing test came first (for code changes), and tests use synthetic data only
- [ ] Any new Facebook call goes through `GovernedHttp` and is counted in the Facebook call budget card on the Logs page
- [ ] No safety limit is raised or bypassed
- [ ] No HAR files, cookies, tokens, real names or profile URLs are included
- [ ] `CHANGELOG.md` is updated under `Unreleased` for user-visible changes
- [ ] Commit messages follow Conventional Commits
- [ ] I agree my contribution is released under GPL-3.0-only
