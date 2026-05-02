# Architecture and Security Model

`@inc-realm/bridge` is a local trust bridge. It is useful when a browser UI needs
local private-key signing, SSH tunneling, or localhost TCP access, but the
browser itself should not own those capabilities.

It is not a universal PKI layer. It complements SSH, WebAuthn/passkeys, mTLS,
hardware-backed signing, and service-auth systems.

## Components

- **CLI:** starts explicit user-requested actions such as key generation, SSH
  host trust, account operations, and the browser bridge.
- **OpenSSH helpers:** call `ssh-keygen` and `ssh` with argument arrays, not a
  shell.
- **Game config:** provides display name, key path, signing namespace, default
  socket ports, SSH host, and protocol field names.
- **Browser bridge:** exposes a token-protected loopback WebSocket for a hosted
  browser UI.
- **Game server:** owns account, gameplay, admin, payment, and authorization
  decisions.

The bridge should stay small. Its job is local capability mediation, not game
policy.

## Local Effects

Installation does not run code beyond npm package installation. There are no
install scripts.

Runtime commands may touch:

- `key generate`: creates an Ed25519 private key and matching `.pub` file
- `host trust`: may add the selected SSH host key to normal OpenSSH
  `known_hosts`
- `browser start`: listens on loopback and connects to the game AI socket
  directly or through an OpenSSH local port forward
- `--bootstrap-local-dev`: may create or update an Incarnate local dev account
  file under `<repo-root>/java/lib_server/accounts/`

Private keys are never sent to the game server. The server sees public keys and
detached signatures over server-provided challenge payloads.

## Auth Flow

The default flow is SSH-key challenge auth:

1. Bridge connects to the game AI socket.
2. Server sends `hello`.
3. Bridge sends `auth_begin` or `auth_key_probe`.
4. Server sends `auth_challenge` with a signing payload.
5. Bridge signs locally with `ssh-keygen -Y sign`.
6. Bridge sends `auth_complete` with the detached signature.
7. Server verifies the signature against the registered public key.
8. Server sends `auth_result`.

Account creation and key rotation use the same pattern. The bridge can provide
local public-key metadata, but the server decides whether the operation is
allowed.

Each game should use a unique signing namespace, such as `example-realm-auth`.
That prevents a signature from one game from being reusable in another game's
challenge domain.

## Browser Bridge Contract

The localhost WebSocket bridge:

- requires a session token
- rejects unexpected browser origins when configured
- rejects malformed or oversized browser messages
- closes on malformed or oversized upstream AI socket messages
- reserves bridge-local browser messages such as `client_debug` and
  `bridge_device_key`
- blocks browser-originated auth/account completion messages that must be owned
  by local key signing
- forwards normal game command envelopes to the AI socket
- replies to AI heartbeat `ping` with local `pong`

Command filtering is intentionally inverted. The bridge does not maintain the
game command catalog. If a privileged command is safe only because the bridge
blocks it, the server is missing an authorization check.

## Protocol Customization

The default packet names match Incarnate. Other games can rename them in
`bridge.game.json`:

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

See [`../examples/bridge.game.json`](../examples/bridge.game.json) for a fuller
config example.

## Environment Variables

Generic environment names:

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

## When Not To Use This

Use plain SSH when the user is already in a terminal or the workflow does not
need a browser-to-local adapter.

Use WebAuthn/passkeys for normal browser login.

Use mTLS, SSH, SPIFFE, OIDC, or signed service tokens for server-to-server
identity.

Use audited domain-specific protocols for financial signing, custody, trading,
or end-to-end encrypted messaging. The bridge can mediate a local signing key,
but it is not a replacement for transaction-specific signing, hardware-backed
keys, key transparency, forward secrecy, revocation design, or regulatory
review.

## Review Checklist

Before publishing or adopting a new integration:

- keep install scripts absent
- keep runtime dependencies minimal
- verify `npm audit --omit=dev`
- run `npm run browser:security-test`
- use a unique signing namespace
- enforce authorization on the server
- keep browser origin checks tight for hosted clients
- verify `npm run pack:check` so published files are reviewable
