# Security Policy

`@inc-realm/bridge` is local infrastructure for games that need a small,
reviewable program on a player's machine. It touches sensitive boundaries:
private keys, SSH host trust, loopback sockets, and challenge signatures.

## Reporting

Report security issues privately to the repository owner before opening a public
issue. Include:

- affected package version
- operating system and Node.js version
- command and configuration used
- expected and observed behavior
- minimal reproduction when possible

## Security Model

The bridge is responsible for:

- creating or reusing an OpenSSH private key selected by the user/configuration
- signing server challenge payloads locally with `ssh-keygen -Y sign`
- opening optional OpenSSH local port forwards
- exposing a token-protected localhost WebSocket for browser clients
- enforcing local-only reserved browser messages and bridge-owned auth/account
  signing flows

The game server is responsible for:

- command semantics
- authorization for gameplay, operator, payment, god, and account actions
- rejecting malformed or unauthorized game commands
- binding public keys to accounts

Open-ended browser command forwarding is intentional. If a privileged game
command is safe only because the bridge blocks it, that is a server-side security
bug.

## Install-Time Behavior

The package has no `preinstall`, `install`, or `postinstall` scripts. Installing
it links the CLI and installs runtime dependencies. Keys, SSH host trust, SSH
tunnels, and WebSocket listeners are created only when commands are run.

## Supported Versions

Until `1.0.0`, security fixes are released on the latest minor/preview line.
Consumers should pin exact versions and update deliberately.
