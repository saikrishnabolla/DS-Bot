# Cue desktop app

The Electron app runs Cue through its owned Pi Durable host. It packages the React UI from `ui/` and starts the host in a child process.

## Run

Use Node.js 24.

```sh
npm install
npm run build
npm start
```

The app keeps running when its window closes. Use the tray menu to open it again or quit.

## Host

`src/main.mjs` owns the Electron window, tray, updates, file pickers, browser views, and host process. `src/host.mjs` starts `OwnedHost` from `ds-bot/host`. The host serves `ui/dist` and the `api/bot` HTTP, WebSocket, and event-stream endpoints on a loopback port.

Model providers and keys are configured in the Models page or through the environment variables supported by the owned host.

## Data

The default data folder is `~/.ds-bot`. Bot workspaces default to `~/Cue`.

Set these variables for an isolated run:

```sh
DS_BOT_HOME=/tmp/ds-bot-data \
DS_BOT_WORKSPACE=/tmp/ds-bot-workspace \
npm start
```

`DS_BOT_SHELL_DATA` changes Electron's shell data folder. Tests and package checks use it so they do not touch an installed app.

## Checks

```sh
npm test
npm run build
npm run check-lifecycle
```

`npm test` includes the Electron main-process tests and the standalone UI tests. `check-lifecycle` opens a real Electron window and checks hide, reopen, and quit behavior.

## Package

Build packages on the target platform and architecture.

```sh
npm run pack
npm run check-packed
npm run dist
```

`check-packed` runs a copy outside the checkout. It checks that the owned host and built UI are present, starts the app on temporary data, calls the state endpoint, hides and reopens the window, and quits cleanly.

## Attribution

Some desktop UI and process code was adapted from third-party projects under their original licenses. See [`../NOTICE`](../NOTICE).
