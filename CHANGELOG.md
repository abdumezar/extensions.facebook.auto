# Changelog

All notable changes to Nashir are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Building from source now needs Node.js 22.12 or newer.

## [1.0.0] - 2026-11-03

First public release.

### Added

- Arabic-first dashboard and popup for posting to Facebook groups, with an English interface as well.
- Campaigns that post to many groups, with per-group results and multiple accounts.
- Group list sync, loaded in resumable batches so very large lists complete, and a paginated Groups page.
- Leaving groups, one at a time or several at once.
- Audience extraction from a post (reactors and commenters, with contact details people typed themselves), CSV and JSON export, and a WhatsApp handoff.
- An engagement loop that reads your own posts back (opt-in: turn it on in the Audience page).
- Call governor with pacing, per-feature caps, cooldowns and a run state, so activity stays within safe limits.
- A Facebook call budget card on the Logs page showing recent call counts and, during a cooldown, the rule that matched.
- A Facebook operations card, and self-healing for Facebook's internal operation ids learned from your own Facebook tabs.
- One-click updates from GitHub Releases: link the extension folder once; every release is signature-checked before any file is written, with automatic rollback if a write fails.
- The session card shows your name and photo on first open and stays "Connected" for 12 hours after a successful check.

### Not yet available

These are built into the extension but wait on a Facebook operation that will arrive in an upcoming update. Until then the extension shows that they are not available yet.

- Lead Radar.
- Auto first comment, and Lead Radar replies.
- Group discovery and joining.
- Group member and page follower extraction.
- Link preview in posts.

### Notes

- A fresh install starts with empty data.
- Released under GPL-3.0-only.
