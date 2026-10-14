# Changelog

## [Unreleased]

## [1.2.0] - 2026-10-13

### Added

- A review request for the bot from the trigger user is a mention. The workflow subscribes to `pull_request_target` `review_requested` and forwards it when the requested reviewer is the bot. The router reads the pull request's review-request timeline from GitHub and accepts the newest request from the trigger user for the bot. A team request is not forwarded. A repeated request is a new delivery. New drop reason: `no_review_request`.

## [1.1.0] - 2026-10-12

### Added

- `scripts/route-event.mjs` decides which events to handle. Fixtures cover the seven event types and the reject cases.
- Handler config at `~/.config/mentions/config.json`, with one job file per thread and a seen ledger.
- `templates/routine-prompt.md` and a Grok Bot setup path in the README.
- `scripts/install.sh --update` replaces an existing workflow. `--comment-as` and `--config` set the bot account and the config path.
- Marketplace fields on the manifest, including a logo, repository, homepage, tags, and Grok Bot minimum version 0.49.0. Cursor can install the plugin.
- CI runs on pushes to `main` and on pull requests, on Ubuntu and macOS.
- `SECURITY.md`, `docs/ARCHITECTURE.md`, and `AGENTS.md`.

### Changed

- The default secret prefix is `MENTION`.
- The reply agent posts its own progress and final comment. The dispatcher does not run a heartbeat.
- Install instructions include a marketplace track, a local checkout, and a clone that creates the plugin directory.
- The manifest author and the license copyright are the repository owner.

### Fixed

- Mention checks use a boundary, so `@bot` does not match `@bot2`. Logins and handles compare without case.
- Edited review comments and discussion comments are forwarded, same as other text edits.
- A header name without a key still fails. A full Authorization line still works. The webhook response body is not printed.
- Fork reviews with empty secrets exit 0 with a notice.
- The installer rejects a trigger user who is also the bot.

### Security

- The handler fetches the comment from GitHub and does not execute the webhook body. The ledger and the reply thread come from that fetched object. Equivalent pull request event names share one delivery. Discussion comments accept GitHub's GraphQL field names.
- A lost pull request response keeps the branch when GitHub already opened the pull request.
- Reviews use `submitted_at` when GitHub does not send `updated_at`. Fork pull request bodies are forwarded. Fork reviews are not.
- Context from other people is marked untrusted. Merges and pushes to the default branch need an explicit verb from the trigger user.
- Comment text is passed in files, not inside shell quotes.

## [1.0.0] - 2026-10-12

### Added

- Initial release of the mentions plugin.
- Parameterized mention-forward workflow for issues, issue comments, pull requests, reviews, review comments, discussions, and discussion comments.
- The forwarder accepts a full Authorization header line. Setup can set secrets from environment variables.
- Setup skill and `scripts/install.sh`, with dry-run, pull-request install, and failure rollback.
- Handler skill for acknowledgements, same-thread steering, and parallel threads.
- CI runs shellcheck, actionlint, `scripts/test.sh`, and manifest validation.
