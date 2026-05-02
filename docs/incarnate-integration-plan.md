# Incarnate Integration Plan For Bridge 0.9

This package now has a reusable bridge core with an Incarnate adapter. The
Incarnate repo should consume the exported API and CLI configuration instead of
reaching into private `dist/` paths or depending on bridge-side game command
catalogs.

## Goals

- Depend on `@inc-realm/bridge@0.9.0`.
- Treat the Java AI socket as the command semantics and authorization boundary.
- Use the bridge only for local keys, challenge signing, SSH tunneling, and
  localhost browser policy.
- Stop importing `@inc-realm/bridge/dist/...` from application code.
- Keep local dev bootstrap Incarnate-specific and explicit.

## Package Updates

Update every Incarnate workspace package that depends on the bridge:

```json
{
  "dependencies": {
    "@inc-realm/bridge": "0.9.0"
  }
}
```

Then run the repo's normal lockfile update command.

## Import Updates

Replace deep `dist` imports:

```ts
import { ensureKeyPair } from "@inc-realm/bridge/dist/openssh.js";
import { ensureLocalAccountKey } from "@inc-realm/bridge/dist/local-bootstrap.js";
```

with exported subpaths:

```ts
import { ensureKeyPair } from "@inc-realm/bridge/openssh";
import { ensureLocalAccountKey } from "@inc-realm/bridge/local-bootstrap";
```

or the root API:

```ts
import { INCARNATE_GAME_CONFIG, startBrowserBridgeServer } from "@inc-realm/bridge";
```

## CLI And Environment

Existing `INCARNATE_*` environment variables still work. New generic
`BRIDGE_*` names are preferred for new wrapper scripts:

- `BRIDGE_TRANSPORT`
- `BRIDGE_SSH_HOST`
- `BRIDGE_AI_HOST`
- `BRIDGE_AI_PORT`
- `BRIDGE_KEY_PATH`
- `BRIDGE_KEY_LABEL`
- `BRIDGE_ACCOUNT`
- `BRIDGE_CHARACTER`
- `BRIDGE_BROWSER_BRIDGE_HOST`
- `BRIDGE_BROWSER_BRIDGE_PORT`
- `BRIDGE_BROWSER_ORIGIN`
- `BRIDGE_BROWSER_SESSION_TOKEN`

Incarnate wrappers can keep the `incarnate-bridge` binary. For non-Incarnate
games, pass `--game-config ./bridge.game.json`.

## Server Requirements

The Java AI socket must remain authoritative for:

- SysOp dashboard commands
- god/editor commands
- payment/credit commands
- account and key mutation commands
- all gameplay commands

The bridge forwards open-ended game command envelopes. It does not maintain the
game command catalog anymore. If a command requires privilege, Java must reject
it for unauthorized sessions.

## Browser Requirements

The browser should continue connecting only to the localhost bridge WebSocket
with the launcher-provided token. It should not connect directly to the hosted
AI socket.

Browser-originated bridge-owned signing messages remain blocked:

- `auth_key_probe`
- `auth_begin`
- `auth_complete`
- `account_create_begin`
- `account_create_complete`
- `account_add_key_begin`
- `account_add_key_complete`

Account setup should send begin messages only in the accountless setup state
where the bridge fills in local key metadata and owns completion signatures.

## Validation Checklist

- `npm install` resolves `@inc-realm/bridge@0.9.0`.
- No imports reference `@inc-realm/bridge/dist/...`.
- `npm run bridge:security-test` passes.
- Browser play can create or recognize a local key.
- Browser play can send a command not known to the bridge package.
- Java rejects `ops_dashboard_request` for non-SysOp sessions.
- Java accepts `ops_dashboard_request` for authorized SysOps sessions.
- Java rejects god/payment/operator commands for unauthorized sessions.
