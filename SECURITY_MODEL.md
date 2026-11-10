# Cue security model

## System overview and trust boundaries

Cue runs its own Pi Durable host in the desktop app or Docker.

Trust boundaries:

1. Web pages, files, search results, connector results, and Bot messages enter model context as untrusted content.
2. Ordinary Bots cannot use Main Bot operations unless the host authorizes them.
3. Tool results pass through secret redaction before model requests.
4. The renderer reaches the host through the authenticated owned HTTP server and restricted Electron IPC.
5. Bot HTML widgets run in sandboxed iframes. Bot browser pages use isolated Electron partitions.

## Components

- `ds-bot/src/engine/`: Pi Durable adapter and owned host
- `ds-bot/src/host/`: team behavior, tools, permissions, privacy, and secrets
- `ds-bot/src/server/owned-server.js`: authenticated HTTP boundary
- `ds-bot/src/client/` and `app/ui/`: interface
- `app/src/`: Electron main process, IPC, browser views, updates, and computer use
- `docker/`: standalone owned host

## Entry points and who reaches them

- User chat input
- Untrusted content read by a Bot
- Owned-host HTTP endpoints
- Electron IPC from the Cue window
- Connected MCP servers, mail accounts, and chat platforms

## Assets

1. Provider keys, connector tokens, and Bot secrets
2. Files on the user's computer
3. Browser cookies, conversations, and memory

## Attacker profiles

The primary threat is prompt injection that tries to read secrets, exceed folder or permission limits, gain Main Bot rights, or trigger an external action without approval.

## Existing controls

- Main Bot and group-admin checks
- Per-Bot permission presets and approval gates
- Private Bot folder, memory, and sharing rules
- Scoped secrets and outbound redaction
- HTTPS requirements for remote connectors
- Sandboxed widgets and browser views
- IPC sender checks
- One-time launch links, HTTP-only cookies, and `Host` and `Origin` checks

## Accepted risk

Bots can read, write, run commands, and use the network within the permissions the user grants. Docker treats the container and its mounted folders as the execution boundary. Computer use is available only in the desktop app and requires operating-system permissions.

## Open questions

- Should a secret scoped to one Bot be hidden from Main Bots?
- Which Docker reverse-proxy setups should receive first-party deployment examples?
