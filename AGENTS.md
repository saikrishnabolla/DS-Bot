# AGENTS.md

Instructions for coding agents. Human contributors should read [CONTRIBUTING.md](CONTRIBUTING.md).

## What this project is

Cue is a team of long-lived Bots. `ds-bot/` contains the shared product code and the owned Pi Durable host. `app/` contains the Electron desktop app. `docker/` runs the same owned host without desktop-only features.

## Hard rules

1. Use Pi Durable through `ds-bot/src/engine/`. Do not patch installed dependencies or depend on private files.
2. Never write, print, or commit API keys, tokens, cookies, or user data.
3. Use original material. Licensed third-party code must be compatible with Apache 2.0 and listed in `NOTICE`.
4. Tests must use temporary folders and mock services. Never point a test at a user's Cue data.
5. Keep desktop-only code behind the Electron boundary. Docker and headless tests must not load Electron or the computer-use driver.

## Commands

Run core checks in `ds-bot/`:

```sh
npm ci
npm run build
npm test
npm run lint
```

Run desktop checks in `app/`:

```sh
npm ci
npm run build
npm test
```

## Branches, pull requests and issues

- Open feature and fix pull requests into `dev`. Use `main` only for releases and hotfixes.
- Do not rebase a pushed branch or force-push.
- Link the issue and state the user-visible change in the pull request template.
- Read the relevant file in `docs/plans/` before changing decided behavior.
- Do not close an issue without evidence.

## Layout

- `ds-bot/src/engine/`: Pi Durable adapter and owned host
- `ds-bot/src/host/`: Bot, group, memory, tool, connector, and permission behavior
- `ds-bot/src/client/`: shared interface code
- `ds-bot/src/server/`: owned HTTP boundary
- `ds-bot/test/`: core tests
- `app/`: Electron shell and desktop UI
- `docker/`: standalone headless host

## Style

Keep functions small and names plain. Comment hidden constraints, not obvious code. Keep English and Chinese user-facing docs in sync.
