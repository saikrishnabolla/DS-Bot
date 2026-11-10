# Cue in Docker

The image runs Cue's Pi Durable host and web UI. It does not include the desktop-only computer-use driver.

## Start

From the repository root:

```sh
docker compose up -d --build
docker compose logs -f cue
```

Open the one-time URL printed in the log. The default port is `3080`.

## Configuration

Set model-provider keys in `docker-compose.yml` or an untracked `.env` file. `DEEPSEEK_API_KEY` is optional. Cue also supports the other providers listed in its Models page.

Set `CUE_PUBLIC_ORIGIN` to the exact browser origin when you change the host name, scheme, or port. For example:

```env
CUE_PORT=13080
CUE_PUBLIC_ORIGIN=http://my-server:13080
```

The container uses these paths:

- `/data`: Cue state and conversations
- `/workspace`: Bot work files

`PUID` and `PGID` set the owner used inside the container. They default to `1000`.

## Network

The launch link is single-use. After the first request, Cue uses an HTTP-only session cookie and checks the `Host` and `Origin` headers against `CUE_PUBLIC_ORIGIN`.

Do not publish Cue directly to the public internet. Put it behind an authenticated private network or reverse proxy.

## Update

```sh
git pull
docker compose up -d --build
```

The data and workspace mounts remain in place.
