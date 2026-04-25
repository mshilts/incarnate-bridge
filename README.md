# @incarnate/bridge

Open-source local bridge and SSH transport control plane for Incarnate.

This package is the small, reviewable program that runs on a player's machine.
It owns local SSH key generation, SSH host trust, SSH tunneling, challenge
signing, and the localhost browser WebSocket bridge. The private game server and
game content are not included in this repository.

## Why This Is Public

The bridge touches sensitive local boundaries:

- it creates or reuses an OpenSSH private key
- it signs game authentication challenges locally
- it opens an SSH tunnel to the hosted game server
- it exposes a token-protected localhost WebSocket for the hosted browser UI

Players and agents should be able to inspect that code before running the
installer or starting the bridge.

## Requirements

- Node.js 20 or newer
- npm
- OpenSSH client tools: `ssh`, `ssh-keygen`

## Install

After the package is published:

```bash
npm install -g @incarnate/bridge
```

During source review or local development:

```bash
git clone https://github.com/mshilts/incarnate-bridge.git
cd incarnate-bridge
npm install
npm run build
```

## Primary Commands

Installed CLI:

```bash
incarnate-bridge key generate
incarnate-bridge key inspect
incarnate-bridge host trust --ssh-host game.inc-realm.com
incarnate-bridge account create --transport ssh --ssh-host game.inc-realm.com --account <name> --key-label device
incarnate-bridge account list-keys --transport ssh --ssh-host game.inc-realm.com --account <name> --key-label device
incarnate-bridge account add-key --transport ssh --ssh-host game.inc-realm.com --account <name> --key-label <current-label> --key-path <current-key> --new-key-label <new-label> --new-key-path <new-key>
incarnate-bridge account remove-key --transport ssh --ssh-host game.inc-realm.com --account <name> --key-label <current-label> --key-path <current-key> --target-key-label <old-label>
incarnate-bridge browser start --transport ssh --ssh-host game.inc-realm.com --account "" --character ""
```

From this source checkout:

```bash
npm run key:generate
npm run key:inspect
npm run host:trust -- --ssh-host game.inc-realm.com
npm run browser:start -- --transport ssh --ssh-host game.inc-realm.com --account "" --character ""
```

## Auth Model

The live login flow is challenge-based and key-only:

1. connect to the Java AI socket through `local-direct` loopback or an SSH tunnel
2. send `auth_begin` with `account` and `keyLabel`
3. receive `auth_challenge`
4. sign the challenge payload with `ssh-keygen -Y sign`
5. send `auth_complete` with the detached signature
6. receive `auth_result`
7. receive `character_list` and then choose a character

Account creation uses the same challenge-signing path through
`account_create_begin` and `account_create_complete`.

Key rotation uses the account command surface:

1. authenticate with an existing active key
2. run `account add-key` with `--new-key-label` and `--new-key-path`
3. restart or reconfigure the bridge to use the new key label/path
4. run `account remove-key --target-key-label <old-label>`

`remove-key` deactivates the old key instead of physically deleting it. The
server refuses to deactivate the last active key for an account.

## Browser Bridge Contract

`browser start` exposes a loopback WebSocket bridge that:

- accepts only the launcher session token
- rejects unexpected browser origins when configured
- rejects malformed and oversized browser messages without forwarding them
- blocks browser-originated account/key-management commands after bridge-owned auth
- authenticates upstream with the same SSH-key challenge flow
- auto-selects a configured character when one was provided
- replies to AI heartbeat `ping` packets with local `pong`

The bridge intentionally uses minimal local protocol types in `src/protocol.ts`.
It forwards server packets as JSON and does not need the private game repo's full
browser UI contract.

AI agent clients are intentionally outside this package. They can depend on this
package for key handling, SSH tunneling, and browser bridge protocol helpers
without requiring players to install the private monorepo.

## Local Development Defaults

Common defaults come from environment variables consumed by `src/cli.ts`:

- `INCARNATE_TRANSPORT=local-direct`
- `INCARNATE_ACCOUNT=matt`
- `INCARNATE_KEY_LABEL=local-dev`
- `INCARNATE_KEY_PATH=~/.ssh/incarnate_ed25519`
- `INCARNATE_TARGET_KEY_LABEL=` for key rotation/removal targets
- `INCARNATE_TARGET_KEY_PATH=` for the new key during rotation
- `INCARNATE_CHARACTER=` for browser flows
- `INCARNATE_AI_PORT=8083`
- `INCARNATE_BROWSER_BRIDGE_PORT=8787`

For public hosted play, set `INCARNATE_TRANSPORT=ssh` and pass or export
`INCARNATE_SSH_HOST=game.inc-realm.com`.

## Verification

```bash
npm run build
npm run browser:security-test
npm run pack:check
```

The package is configured for public npm publishing with provenance from GitHub
Actions. The npm package contains `dist/`, `src/`, `README.md`, and `LICENSE` so
users can review the shipped JavaScript and the TypeScript source.
