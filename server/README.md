# Codex-deck Server

Minimal backend for open-source end-to-end encrypted Claude Code clients.

## What is Codex-deck?

Codex-deck Server is the synchronization backbone for secure Claude Code clients. It enables multiple devices to share encrypted conversations while maintaining complete privacy - the server never sees your messages, only encrypted blobs it cannot read.

## Features

- 🔐 **Zero Knowledge** - The server stores encrypted data but has no ability to decrypt it
- 🎯 **Minimal Surface** - Only essential features for secure sync, nothing more
- 🕵️ **Privacy First** - No analytics, no tracking, no data mining
- 📖 **Open Source** - Transparent implementation you can audit and self-host
- 🔑 **Single Remote Login Per CLI** - Reusable setup tokens bootstrap CLIs, while browsers and CLIs share one username/password-derived remote identity per machine
- ⚡ **Real-time Sync** - WebSocket-based synchronization across all your devices
- 📱 **Multi-device** - Seamless session management across phones, tablets, and computers
- 🔔 **Push Notifications** - Notify when Claude Code finishes tasks or needs permissions (encrypted, we can't see the content)
- 🌐 **Distributed Ready** - Built to scale horizontally when needed

## How It Works

Your Claude Code clients generate encryption keys locally and use Codex-deck Server as a secure relay. Messages are end-to-end encrypted before leaving your device. The server's job is simple: store encrypted blobs and sync them between your devices in real-time.

## Hosting

**You don't need to self-host!** A hosted Codex-deck Server at `codexdeck-api.example.com` is just as secure as running your own. Since all data is end-to-end encrypted before it reaches the server, it cannot read your messages. The encryption happens on your device, and only you have the keys.

That said, Codex-deck Server is open source and self-hostable if you prefer running your own infrastructure. The security model is identical whether you use hosted infrastructure or your own.

## Self-Hosting with Docker

The standalone Docker image builds and serves the codex-deck remote web app together with the server in one container, with no required external dependencies (no Postgres, no Redis, no S3).

Run from the monorepo root:

```bash
docker build -t codexdeck-server -f Dockerfile.server .

docker run -p 3005:3005 \
  -e CODEXDECK_REMOTE_ADMIN_PASSWORD=<admin-password> \
  -e CODEXDECK_REMOTE_BROWSER_AUTH_PERSISTENCE=remember \
  -e PUBLIC_URL=http://your-server-host:3005 \
  -v codexdeck-data:/data \
  codexdeck-server
```

This uses:

- **PGlite** - embedded PostgreSQL (data stored in `/data/pglite`)
- **Local filesystem** - for file uploads (stored in `/data/files`)
- **In-memory event bus** - no Redis needed
- **Built web UI** - served at the same origin as the API/socket server

Data persists in the `codexdeck-data` Docker volume across container restarts.

After the server starts, open `http://your-server-host:3005/admin` and log in with `CODEXDECK_REMOTE_ADMIN_PASSWORD` to rotate the admin password or manage setup tokens from the web UI. If you prefer, you can still pre-seed initial tokens with `CODEXDECK_REMOTE_SETUP_TOKENS`.

Then start each local CLI with one setup token plus the username/password that the browser will also use for that CLI:

```bash
codex-deck \
  --remote-server-url http://your-server-host:3005 \
  --remote-setup-token <token-a> \
  --remote-username <cli-login-name> \
  --remote-password <cli-login-password>
```

Users then open `http://your-server-host:3005/` in a browser and log in with the same CLI username/password. The server only sees an opaque login handle plus password-derived proofs and ciphertext; it does not receive the raw remote username or password, and it cannot decrypt CLI/browser traffic.

### Environment Variables

| Variable                                    | Required | Default                 | Description                                                                     |
| ------------------------------------------- | -------- | ----------------------- | ------------------------------------------------------------------------------- |
| `CODEXDECK_REMOTE_ADMIN_PASSWORD`           | Yes      | -                       | Bootstrap admin password for `/admin`                                           |
| `CODEXDECK_REMOTE_SETUP_TOKENS`             | No       | -                       | Optional comma- or newline-separated CLI setup tokens to seed on first boot     |
| `CODEXDECK_REMOTE_BROWSER_AUTH_PERSISTENCE` | No       | `remember`              | `session` for refresh-only browser auth, `remember` for persistent login        |
| `PUBLIC_URL`                                | No       | `http://localhost:3005` | Public base URL for file URLs sent to clients                                   |
| `PORT`                                      | No       | `3005`                  | Server port                                                                     |
| `DATA_DIR`                                  | No       | `/data`                 | Base data directory                                                             |
| `PGLITE_DIR`                                | No       | `/data/pglite`          | PGlite database directory                                                       |
| `CODEXDECK_SERVER_LOG_LEVEL`                | No       | `warn`                  | Server log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`) |

Internal token-signing and server-encryption secrets are generated automatically on first boot and persisted in `DATA_DIR/server-secrets.json`.

For advanced deployments, you can override those internal secrets explicitly:

| Variable                             | Description                                            |
| ------------------------------------ | ------------------------------------------------------ |
| `CODEXDECK_TOKEN_SIGNING_SECRET`     | Overrides the generated token-signing secret           |
| `CODEXDECK_SERVER_ENCRYPTION_SECRET` | Overrides the generated server-owned encryption secret |

### Optional: External Services

To use external Postgres or Redis instead of the embedded defaults, set:

| Variable       | Description                                 |
| -------------- | ------------------------------------------- |
| `DATABASE_URL` | PostgreSQL connection URL (bypasses PGlite) |
| `REDIS_URL`    | Redis connection URL                        |
| `S3_HOST`      | S3/MinIO host (bypasses local file storage) |

## License

MIT - Use it, modify it, deploy it anywhere.
