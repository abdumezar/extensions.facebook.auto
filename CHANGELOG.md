# Changelog

All notable changes to Nashir are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - Unreleased

First public release.

### Added

- Arabic-first dashboard and popup for posting to Facebook groups, with an English interface as well.
- Campaigns that post to many groups, with per-group results.
- Group list sync, loaded in resumable batches so very large lists complete.
- Audience extraction, lead radar and an engagement loop.
- Call governor with pacing, per-feature caps, cooldowns and a run state, so activity stays within safe limits.
- A Facebook call budget card on the Logs page showing recent call counts and, during a cooldown, the rule that matched.

### Notes

- A fresh install starts with empty data.
- Released under GPL-3.0-only.
