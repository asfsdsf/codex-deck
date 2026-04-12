## Local Mode

Build and run the local app:

```bash
pnpm install
pnpm build
pnpm start
```

Or use watch mode:

```bash
pnpm dev
```

## Server Mode

This is the current remote flow:

- the server starts with:
  - setup tokens for CLIs
  - one admin password for `/admin`
- each CLI starts with:
  - one setup token
  - one remote username
  - one remote password
- the browser logs in with the same remote username/password as the target CLI
- the server does not receive the raw remote username or raw remote password
- the server only relays encrypted browser/CLI traffic

### 1. Build Once

```bash
pnpm install
pnpm build
docker build -t codexdeck-server -f Dockerfile.server .
```

### 2. Start The Remote Server

Recommended default: `CODEXDECK_REMOTE_BROWSER_AUTH_PERSISTENCE=remember`

Why:

- refresh works without logging in again
- browser restart also keeps you logged in
- most convenient for personal devices

Docker example:

```bash
docker run --rm \
  --name codexdeck-server-3005 \
  -p 3005:3005 \
  -e CODEXDECK_REMOTE_ADMIN_PASSWORD='admin-password' \
  -e CODEXDECK_REMOTE_BROWSER_AUTH_PERSISTENCE='remember' \
  -e CODEXDECK_SERVER_LOG_LEVEL='warn' \
  -e PUBLIC_URL='http://localhost:3005' \
  -v codexdeck-data:/data \
  codexdeck-server
```

Notes:

- `CODEXDECK_REMOTE_ADMIN_PASSWORD` is the admin login password for `/admin`
- `CODEXDECK_REMOTE_SETUP_TOKENS` optionally seeds initial CLI setup tokens for a fresh server data directory
- `CODEXDECK_SERVER_LOG_LEVEL` controls server log verbosity (`warn` default; set `info` or `debug` when needed)
- internal token-signing and server-encryption secrets are generated automatically and persisted under `/data/server-secrets.json`
- `session` is supported instead of `remember` if you want browser restart to require login again

### 3. Open The Admin Page

Open:

```text
http://localhost:3005/admin
```

Log in with:

- admin password: the value from `CODEXDECK_REMOTE_ADMIN_PASSWORD`

After login, you can:

- rotate the admin password
- create setup tokens
- rename setup tokens
- enable or disable setup tokens
- regenerate setup tokens
- delete setup tokens

You can create setup tokens directly in `/admin`, or optionally seed them up front with `CODEXDECK_REMOTE_SETUP_TOKENS`.

### 4. Start A CLI

Each CLI must use:

- one setup token that exists on the server
- one remote username
- one remote password

Example:

```bash
pnpm start -p 12011 --no-open --dir /tmp/codex-deck-cli-a \
  --remote-server-url http://localhost:3005 \
  --remote-setup-token 'token-a' \
  --remote-username 'alice' \
  --remote-password 'alice-password'
```

Environment-variable form:

```bash
export CODEXDECK_REMOTE_SERVER_URL='http://localhost:3005'
export CODEXDECK_REMOTE_SETUP_TOKEN='token-a'
export CODEXDECK_REMOTE_USERNAME='alice'
export CODEXDECK_REMOTE_PASSWORD='alice-password'

pnpm start -p 12011 --no-open --dir /tmp/codex-deck-cli-a
```

Notes:

- the remote username must be unique on the server
- rerunning the same CLI with the same machine id and a valid setup token can rotate the remote username/password for that machine
- that rebind keeps the same remote account data, but previously issued browser/CLI sessions are logged out
- if a remote username is already bound to a different machine, CLI startup still fails

### 5. Open The Web App

Open:

```text
http://localhost:3005/
```

Log in with the same:

- remote username
- remote password

that you used for the target CLI.

With `CODEXDECK_REMOTE_BROWSER_AUTH_PERSISTENCE=session`:

- page refresh keeps you logged in
- browser restart asks you to log in again

With `CODEXDECK_REMOTE_BROWSER_AUTH_PERSISTENCE=remember`:

- page refresh keeps you logged in
- browser restart also keeps you logged in

### Optional: Remote latency debug logs

You can turn on per-hop timing logs for remote relay debugging.

- server + CLI relay logs:

```bash
export CODEXDECK_REMOTE_RPC_TIMING_LOG=1
```

- browser relay logs:
  - enable **Browser remote latency logs** on the remote login screen
  - or toggle **Log On/Off** from the left sidebar when connected
  - optionally append `?remoteLatencyLog=1` to the web app URL to enable by query param

### 6. Expected Security Properties

For the remote username/password used by the browser and CLI:

- the server should not see the raw username
- the server should not see the raw password
- the server should not see plaintext browser/CLI conversation data

The server can still see routing metadata such as:

- machine id
- activity timestamps
- opaque login handle
- ciphertext relay payloads

### Stop Guide

If you used Docker:

```bash
docker stop codexdeck-server
```

If you used a local CLI terminal, stop it with `Ctrl+C`.
