# Cue core

`ds-bot/` contains Cue's shared product code, Pi Durable adapter, owned host, and owned HTTP server.

## Features

- Durable Bots, group chats, goals, handoffs, and memory
- Per-Bot models, folders, permissions, privacy, and secrets
- Browser, connectors, mail, MCP, schedules, and local agents
- Web search and Office tools
- Shared interface modules used by the desktop app

## Run checks

```sh
npm ci
npm run build
npm test
npm run lint
```

`npm run build` generates the Office bundle. The interface is built by `app/` with Vite.

## Owned host

`OwnedHost.open()` starts Cue on Pi Durable:

```js
import { OwnedHost } from 'ds-bot/host'

const cue = await OwnedHost.open({
  dataDir: '/path/to/data',
  workspacePath: '/path/to/workspace',
  uiDir: '/path/to/ui/dist',
})

console.log(cue.launchUrl)
```

Call `await cue.close()` during shutdown.

## Models

Cue stores provider configuration under the selected data folder. DeepSeek is supported as a model provider and does not require a separate agent host.

## Web search

The search tool chooses a route from the active model provider and configured credentials. Search failures return a normal tool error without exposing provider keys.

## Browser and computer use

The desktop app owns local browser views and computer use. The headless Docker host does not load the computer-use driver.

## Data

The owned host stores team state, conversations, memory, provider settings, attachments, and secrets under `dataDir`. Work files stay under `workspacePath`.

Back up both folders while Cue is stopped.

## Layout

- `index.js`: shared runtime entry
- `src/engine/`: Pi Durable adapter and owned host
- `src/host/`: Bot and team behavior
- `src/client/`: shared interface modules
- `src/server/`: owned HTTP server
- `src/office/`: Office tools
- `test/`: unit and integration tests

## License

[Apache License 2.0](LICENSE). See the repository `NOTICE` file for third-party notices.
