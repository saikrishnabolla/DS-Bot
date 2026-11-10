# The vision of Cue

## What Cue is

Cue is a personal assistant made of durable Bots. Each Bot has a stable role, memory, working folder, and conversation history. Bots can work alone or in groups and can hand work to each other.

## Product form

Cue owns its Pi Durable host and interface. The desktop app is the main product. Docker runs the same host without desktop-only features such as computer use and local browser control.

## Core requirements

1. Bots keep their identity and history across restarts.
2. One Bot can handle ordinary work without forcing the user to manage context.
3. Group work has clear ownership and visible progress.
4. Main Bot rights are separate from ordinary Bot rights.
5. Memory, folders, permissions, and secrets have explicit scopes.
6. Users can inspect and interrupt work.
7. Model providers and local agents can change without changing the team model.
8. External actions require the right permission or approval.
9. Data stays under the user's control.
10. The owned host remains testable without the desktop app.

## Principles for trade-offs

- Prefer one reliable workflow over several partial ones.
- Keep host, desktop, and provider boundaries explicit.
- Preserve user data and observable behavior during migrations.
- Remove compatibility code when Cue no longer supports its host or format.

## Who sets the direction

The maintainer decides product direction. Design changes belong in `docs/plans/` before implementation.
