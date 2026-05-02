# @inc-realm/bridge

Small, inspectable local bridge for browser games that need local SSH keys,
challenge signing, SSH tunneling, and a token-protected localhost WebSocket.

It ships with Incarnate defaults, but the bridge core is game-configurable. Once
the package is installed, another game can use the same local bridge by passing a
`bridge.game.json` file and running the neutral `game-bridge` command.

## 30-Second Safety Read

Installing this package does not start a server, create a key, edit SSH config,
open a tunnel, or run a background daemon.

- No `preinstall`, `install`, or `postinstall` scripts.
- One runtime dependency: `ws`.
- No telemetry.
- No browser storage access.
- No shell startup file changes.
- No private monorepo dependency.
- Private keys never leave your machine.

The bridge does work only when you run a command. Those commands are deliberately
small and reviewable.

## What It Does

The bridge lets a hosted browser UI talk to a local game connection without
giving the browser direct access to SSH keys or a public game socket.

It can:

- create or reuse an OpenSSH Ed25519 key
- sign server challenge payloads with `ssh-keygen -Y sign`
- add an SSH host key through normal OpenSSH trust rules
- open an SSH local port forward
- expose a localhost WebSocket guarded by a random session token and optional
  browser origin check
- forward open-ended game command JSON to the game server

It does not decide whether a player can use a game command. Gameplay, SysOp,
god/editor, payment, and account authorization must stay on the game server.

## Install

```bash
npm install -g @inc-realm/bridge
```

This links two command names to the same CLI:

```bash
game-bridge
incarnate-bridge
```

Use `game-bridge` for reusable/non-Incarnate integrations. `incarnate-bridge`
is kept for Incarnate scripts and existing users.

## Player Use

For Incarnate:

```bash
incarnate-bridge key generate
incarnate-bridge host trust --ssh-host game.inc-realm.com
incarnate-bridge browser start --transport ssh --ssh-host game.inc-realm.com --account "" --character ""
```

For another game that provides a config file:

```bash
game-bridge key generate --game-config ./bridge.game.json
game-bridge browser start --game-config ./bridge.game.json --transport ssh --ssh-host game.example.invalid
```

The browser connects only to the local bridge URL printed by the command, for
example:

```text
Example Game bridge listening on ws://127.0.0.1:8787/?token=<random-token>
```

The token is required. A random website cannot use the bridge unless it knows
that token and passes the configured browser origin policy.

## Local Security Boundaries

For review, these are the local effects:

- **Files:** `key generate` creates an Ed25519 key and `.pub` file. Incarnate
  defaults to `~/.ssh/incarnate_ed25519`; other games can set their own
  `defaultKeyPath`.
- **Local dev bootstrap:** `--bootstrap-local-dev` may create or update
  `<repo-root>/java/lib_server/accounts/<account>.act`. This is Incarnate local
  development support and is not used unless explicitly requested.
- **SSH trust:** `host trust` runs OpenSSH with
  `StrictHostKeyChecking=accept-new`, which may add the selected host key to the
  user's normal `known_hosts`.
- **Processes:** the package spawns only `ssh-keygen` and `ssh`, using argument
  arrays rather than a shell.
- **Network:** `browser start` listens on loopback by default and connects to a
  loopback AI socket directly or through an OpenSSH local port forward.
- **Secrets:** private keys are never sent to the game server. The server sees
  public keys and detached signatures over challenge payloads.

The signing namespace is game-specific. Incarnate uses `incarnate-auth`; another
game should choose its own namespace, such as `my-game-auth`, so signatures are
not reusable across games.

## Browser Bridge Contract

The localhost WebSocket bridge:

- requires the session token
- rejects unexpected browser origins when configured
- rejects malformed and oversized browser messages
- closes on malformed or oversized upstream AI socket messages
- reserves bridge-local browser messages such as `client_debug` and
  `bridge_device_key`
- blocks browser-originated auth/account completion messages that must be owned
  by local key signing
- forwards normal game command envelopes to the AI socket
- replies to AI heartbeat `ping` with local `pong`

This inversion is intentional: the bridge does not maintain the game command
catalog. If a privileged command is safe only because the bridge blocks it, the
server is missing an authorization check.

## For Game Developers

A game needs a line-delimited JSON socket server with a challenge-signing auth
flow. The default packet names match Incarnate, but can be renamed in config.

Minimal `bridge.game.json`:

```json
{
  "gameId": "example-realm",
  "displayName": "Example Realm",
  "signingNamespace": "example-realm-auth",
  "defaultKeyPath": "~/.ssh/example_realm_ed25519",
  "defaultKeyLabel": "device",
  "defaultAiHost": "127.0.0.1",
  "defaultAiPort": 8083,
  "defaultBrowserBridgePort": 8787,
  "defaultSshHost": "game.example.invalid"
}
```

Then any user with the package already installed can run:

```bash
game-bridge browser start --game-config ./bridge.game.json --transport ssh
```

If your protocol uses different packet names:

```json
{
  "gameId": "example-realm",
  "displayName": "Example Realm",
  "signingNamespace": "example-realm-auth",
  "protocol": {
    "authBegin": "login_begin",
    "authChallenge": "login_challenge",
    "authComplete": "login_complete",
    "authResult": "login_result",
    "authChallengePayloadField": "payload",
    "characterList": ["hero_list"],
    "characterSelected": "hero_selected",
    "characterSelect": "hero_select"
  }
}
```

See [`examples/bridge.game.json`](examples/bridge.game.json).

## Library API

Use stable exports:

```ts
import { defineBridgeGameConfig, startBrowserBridgeServer } from "@inc-realm/bridge";
import { ensureKeyPair } from "@inc-realm/bridge/openssh";
import { ensureLocalAccountKey } from "@inc-realm/bridge/local-bootstrap";
import { INCARNATE_GAME_CONFIG } from "@inc-realm/bridge/incarnate";
```

Deep `dist/` imports remain available for compatibility, but new integrations
should use the stable exports above.

## Auth Pattern

The default flow is key-only challenge auth:

1. bridge connects to the game AI socket
2. server sends `hello`
3. bridge sends `auth_begin` or `auth_key_probe`
4. server sends `auth_challenge` with a signing payload
5. bridge signs locally with OpenSSH
6. bridge sends `auth_complete` with the detached signature
7. server verifies the signature against the account's registered public key
8. server sends `auth_result`

Account creation and key rotation use the same challenge-signing idea. The
bridge can fill in local public-key metadata, but the server must decide whether
the account/key operation is allowed.

## Environment Variables

Generic names:

- `BRIDGE_GAME_CONFIG`
- `BRIDGE_TRANSPORT`
- `BRIDGE_SSH_HOST`
- `BRIDGE_AI_HOST`
- `BRIDGE_AI_PORT`
- `BRIDGE_ACCOUNT`
- `BRIDGE_KEY_LABEL`
- `BRIDGE_KEY_PATH`
- `BRIDGE_CHARACTER`
- `BRIDGE_BROWSER_BRIDGE_HOST`
- `BRIDGE_BROWSER_BRIDGE_PORT`
- `BRIDGE_BROWSER_ORIGIN`
- `BRIDGE_BROWSER_SESSION_TOKEN`

Incarnate compatibility names still work:

- `INCARNATE_TRANSPORT`
- `INCARNATE_SSH_HOST`
- `INCARNATE_ACCOUNT`
- `INCARNATE_KEY_LABEL`
- `INCARNATE_KEY_PATH`
- `INCARNATE_CHARACTER`
- `INCARNATE_AI_PORT`
- `INCARNATE_BROWSER_BRIDGE_PORT`

## Source Development

```bash
git clone https://github.com/mshilts/incarnate-bridge.git
cd incarnate-bridge
npm install
npm test
```

Useful checks:

```bash
npm audit --omit=dev
npm run build
npm run browser:security-test
npm run pack:check
```

The npm package includes `dist/`, `src/`, `tests/`, `docs/`, `examples/`,
`README.md`, `SECURITY.md`, and `LICENSE` so the shipped JavaScript, TypeScript
source, regression tests, integration plan, and security policy are reviewable.

## Incarnate Integration

Incarnate-specific migration notes live in
[`docs/incarnate-integration-plan.md`](docs/incarnate-integration-plan.md).
