# @inc-realm/bridge

Small local bridge for browser apps that need SSH-key signing, SSH tunneling, or
localhost TCP access without giving the browser direct access to private keys.

It ships with Incarnate defaults, but the core is game-configurable. A different
game can use the same installed package by providing a `bridge.game.json` file
and running `game-bridge`.

## Quick Safety Read

Installing does not start the bridge:

- no `preinstall`, `install`, or `postinstall` scripts
- one runtime dependency: `ws`
- no telemetry
- no browser storage access
- no shell startup file changes
- no background daemon
- no private monorepo dependency
- private keys never leave your machine

Keys, host trust, tunnels, and localhost listeners are created only when you run
the matching command.

## Requirements

- Node.js 20 or newer
- npm
- OpenSSH client tools: `ssh`, `ssh-keygen`

## Install

```bash
npm install -g @inc-realm/bridge
```

This installs two CLI names:

```bash
game-bridge
incarnate-bridge
```

Use `game-bridge` for reusable integrations. `incarnate-bridge` remains for
Incarnate compatibility.

## Play Incarnate

```bash
incarnate-bridge key generate
incarnate-bridge host trust --ssh-host game.inc-realm.com
incarnate-bridge browser start \
  --transport ssh \
  --ssh-host game.inc-realm.com \
  --account "" \
  --character ""
```

The browser connects to the local URL printed by the command:

```text
Incarnate bridge listening on ws://127.0.0.1:8787/?token=<random-token>
```

The token is required. A random website cannot use the bridge unless it knows
the token and passes the configured browser origin policy.

## Use Another Game

Create a `bridge.game.json`:

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

Then run:

```bash
game-bridge key generate --game-config ./bridge.game.json
game-bridge browser start \
  --game-config ./bridge.game.json \
  --transport ssh
```

The server stays authoritative. The bridge forwards game command JSON; it does
not decide whether a player may run a gameplay, admin, payment, or account
command.

## Security Model

The bridge keeps sensitive operations local:

- `key generate` creates an Ed25519 key and `.pub` file
- `host trust` uses normal OpenSSH `known_hosts`
- `browser start` listens on loopback by default
- browser access requires a random session token
- optional browser origin checks are enforced before session setup
- private keys are used only for local `ssh-keygen -Y sign`
- signatures are scoped by a game-specific signing namespace

Use this when a browser UI needs a narrow local capability. If your user is
already in a terminal, plain SSH may be enough. If you need normal browser login,
use WebAuthn/passkeys. If you need server-to-server identity, use SSH, mTLS, or
another standard service-auth mechanism.

For the full architecture, threat boundaries, auth flow, environment variables,
and protocol customization, see [`docs/architecture.md`](docs/architecture.md).

## Library API

```ts
import { defineBridgeGameConfig, startBrowserBridgeServer } from "@inc-realm/bridge";
import { ensureKeyPair } from "@inc-realm/bridge/openssh";
import { INCARNATE_GAME_CONFIG } from "@inc-realm/bridge/incarnate";
```

## Development

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
`README.md`, `SECURITY.md`, and `LICENSE` so the shipped JavaScript, source,
tests, architecture notes, and security policy are reviewable.

Incarnate migration notes live in
[`docs/incarnate-integration-plan.md`](docs/incarnate-integration-plan.md).
