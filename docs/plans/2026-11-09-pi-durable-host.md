# Owned Pi Durable host

- Date: 2026-11-09
- Replaces: the DeepSeek Harness runtime in the desktop app

## Decision

The desktop app will run an owned host on Pi Durable 1.5.0. The app keeps its React interface and its current `POST api/bot` and `GET api/bot/feed` contract.

Pi types stay behind one runtime module. Product code uses DS Bot concepts: Bots, rooms, conversation parts, approvals, schedules, capabilities, memory and browser identities.

Pi Pocket and durable-pi are reference implementations. They are not runtime dependencies.

## Shape

```text
Electron shell
  -> DS Bot React interface
  -> api/bot and api/bot/feed
  -> DS Bot host
  -> Pi Durable harness
  -> Pi AI models and Pi MCP clients
  -> SQLite
```

The host is the only writer to the SQLite database. It opens every extension and observer before it resumes unfinished work. Shutdown closes the HTTP server, observers, MCP clients, model credentials and the harness in that order.

## Contracts

- The API keeps its existing request and response shapes.
- Every message has a stable request ID. Retrying the same request cannot add the message twice.
- A Bot, room member and archived conversation part each have a stable binding to one Pi conversation.
- The feed projects committed Pi state into the existing `hello`, `revision`, `live`, `message` and `stream` events.
- Tools that can repeat safely declare safe replay. Other tools return an interrupted result after a crash.
- Approvals and schedules are durable tasks. Restarting the host cannot approve a call or deliver a scheduled message twice.
- Credentials and secret values never enter transcripts, feeds or team state.

## Migration order

1. Prove Pi Durable opens under the app's Host process and recovers one conversation.
2. Move private chat, streaming, interruption and history to Pi.
3. Move models, provider credentials and usage.
4. Move team tools, approvals, questions and Bot-to-Bot delivery.
5. Move groups, goals, memory, learning and schedules.
6. Move MCP capabilities, connectors, browser control, computer control, IM and local agents.
7. Remove DeepSeek Harness packages and profile dependencies from the desktop runtime. Keep the one-way import for existing users and the optional DSH plugin adapter.

## Completion

The migration is complete when all existing API operations have compatibility tests, the desktop app uses its own interface, and crash recovery passes for model calls, tools, queued messages, approvals and schedules. The desktop package and owned engine must not import `@deepseek-ai`; the optional plugin adapter may load it only when DS Bot runs inside DSH.
