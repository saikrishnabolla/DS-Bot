# Contributing to Cue

## Rules

1. Use the owned Pi Durable host through `ds-bot/src/engine/`.
2. Do not patch dependencies or use their private files.
3. Do not commit keys, tokens, cookies, logs with personal data, or user data folders.
4. Add third-party code only when its license is compatible with Apache 2.0. Record it in `NOTICE`.
5. Use temporary folders and mock services in tests.

## Workflow

Open feature and fix pull requests into `dev`. Use `main` only for releases and hotfixes. Do not rebase a pushed branch or force-push.

Link the issue in the pull request. State the user-visible change and the checks you ran. Read the relevant file in `docs/plans/` before changing decided behavior.

## Set up

Core:

```sh
cd ds-bot
npm ci
npm run build
npm test
npm run lint
```

Desktop app:

```sh
cd app
npm ci
npm run build
npm test
```

Docker:

```sh
docker compose up --build
```

## Layout

- `ds-bot/src/engine/`: Pi Durable adapter and owned host
- `ds-bot/src/host/`: Bot and team behavior
- `ds-bot/src/client/`: shared interface code
- `ds-bot/src/server/`: owned HTTP boundary
- `ds-bot/test/`: core tests
- `app/`: Electron app and desktop UI
- `docker/`: standalone host image

## Test a change

Run the closest test file while editing. Before opening a pull request, run the full core and app suites if the change crosses both areas. Build the desktop app after interface changes. Build the Docker image after Docker or server-boundary changes.

## Write a change

Follow the code around the change. Keep functions small and names plain. Comment hidden constraints, not obvious code. Keep English and Chinese user-facing text in sync.

## Report a problem

Include the Cue version, operating system, model provider, steps to reproduce, expected result, actual result, and a redacted log when available. Never include keys, tokens, cookies, or private conversation content.

## License

Contributions are licensed under [Apache License 2.0](LICENSE).
