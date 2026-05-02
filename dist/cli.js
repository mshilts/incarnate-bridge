#!/usr/bin/env node
import net from "node:net";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { ensureKeyPair, fingerprintPublicKey, openSshTunnel, readPublicKey, signPayload, trustHost } from "./openssh.js";
import { ensureLocalAccountKey } from "./local-bootstrap.js";
import { startBrowserBridgeServer } from "./browser-server.js";
import { loadBridgeGameConfig } from "./config.js";
import { INCARNATE_GAME_CONFIG } from "./incarnate.js";
function env(name, fallback = "") {
    return process.env[name] ?? fallback;
}
function envAny(names, fallback = "") {
    for (const name of names) {
        if (process.env[name] !== undefined) {
            return process.env[name] ?? "";
        }
    }
    return fallback;
}
function optionValue(args, names) {
    for (let index = 0; index < args.length; index += 1) {
        if (names.includes(args[index])) {
            return args[index + 1] ?? "";
        }
    }
    return "";
}
function resolveGameConfig(args) {
    const configPath = optionValue(args, ["--game-config"]) || envAny(["BRIDGE_GAME_CONFIG", "INCARNATE_GAME_CONFIG"]);
    return configPath ? loadBridgeGameConfig(configPath) : INCARNATE_GAME_CONFIG;
}
function parseCommonOptions(args) {
    const gameConfig = resolveGameConfig(args);
    const options = {
        gameConfig,
        transport: (envAny(["BRIDGE_TRANSPORT", "INCARNATE_TRANSPORT"], "local-direct") === "ssh" ? "ssh" : "local-direct"),
        sshHost: envAny(["BRIDGE_SSH_HOST", "INCARNATE_SSH_HOST"], gameConfig.defaultSshHost),
        aiHost: envAny(["BRIDGE_AI_HOST", "INCARNATE_HOST"], gameConfig.defaultAiHost),
        aiPort: Number(envAny(["BRIDGE_AI_PORT", "INCARNATE_AI_PORT"], String(gameConfig.defaultAiPort))),
        repoRoot: envAny(["BRIDGE_REPO_ROOT", "INCARNATE_REPO_ROOT"], process.cwd()),
        account: envAny(["BRIDGE_ACCOUNT", "INCARNATE_ACCOUNT"], gameConfig.defaultAccount),
        keyLabel: envAny(["BRIDGE_KEY_LABEL", "INCARNATE_KEY_LABEL"], gameConfig.defaultKeyLabel),
        targetKeyLabel: envAny(["BRIDGE_TARGET_KEY_LABEL", "INCARNATE_TARGET_KEY_LABEL"], ""),
        keyPath: envAny(["BRIDGE_KEY_PATH", "INCARNATE_KEY_PATH"], gameConfig.defaultKeyPath),
        targetKeyPath: envAny(["BRIDGE_TARGET_KEY_PATH", "INCARNATE_TARGET_KEY_PATH"], ""),
        character: envAny(["BRIDGE_CHARACTER", "INCARNATE_CHARACTER"], ""),
        radius: Number(envAny(["BRIDGE_RADIUS", "INCARNATE_RADIUS"], "14")),
        wsHost: envAny(["BRIDGE_BROWSER_BRIDGE_HOST", "INCARNATE_BROWSER_BRIDGE_HOST"], gameConfig.defaultBrowserBridgeHost),
        wsPort: Number(envAny(["BRIDGE_BROWSER_BRIDGE_PORT", "INCARNATE_BROWSER_BRIDGE_PORT"], String(gameConfig.defaultBrowserBridgePort))),
        browserOrigin: envAny(["BRIDGE_BROWSER_ORIGIN", "INCARNATE_BROWSER_ORIGIN"], ""),
        sessionToken: envAny(["BRIDGE_BROWSER_SESSION_TOKEN", "INCARNATE_BROWSER_SESSION_TOKEN"], randomUUID()),
        bootstrapLocal: envAny(["BRIDGE_BOOTSTRAP_LOCAL_DEV", "INCARNATE_BOOTSTRAP_LOCAL_DEV"], "false") === "true"
    };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        const next = () => args[++index] ?? "";
        if (arg === "--transport") {
            options.transport = next() === "ssh" ? "ssh" : "local-direct";
        }
        else if (arg === "--ssh-host") {
            options.sshHost = next();
        }
        else if (arg === "--ai-host") {
            options.aiHost = next();
        }
        else if (arg === "--ai-port") {
            options.aiPort = Number(next());
        }
        else if (arg === "--repo-root") {
            options.repoRoot = next();
        }
        else if (arg === "--account") {
            options.account = next();
        }
        else if (arg === "--key-label") {
            options.keyLabel = next();
        }
        else if (arg === "--target-key-label" || arg === "--new-key-label" || arg === "--remove-key-label") {
            options.targetKeyLabel = next();
        }
        else if (arg === "--key-path") {
            options.keyPath = next();
        }
        else if (arg === "--target-key-path" || arg === "--new-key-path") {
            options.targetKeyPath = next();
        }
        else if (arg === "--character") {
            options.character = next();
        }
        else if (arg === "--radius") {
            options.radius = Number(next());
        }
        else if (arg === "--ws-host") {
            options.wsHost = next();
        }
        else if (arg === "--ws-port") {
            options.wsPort = Number(next());
        }
        else if (arg === "--browser-origin") {
            options.browserOrigin = next();
        }
        else if (arg === "--session-token") {
            options.sessionToken = next();
        }
        else if (arg === "--game-config") {
            next();
        }
        else if (arg === "--bootstrap-local-dev") {
            options.bootstrapLocal = true;
        }
    }
    validateCommonOptions(options);
    return options;
}
function validateCommonOptions(options) {
    validateTcpPort(options.aiPort, "AI port");
    validateTcpPort(options.wsPort, "browser bridge port", true);
    if (!Number.isFinite(options.radius) || options.radius < 1) {
        throw new Error("Invalid viewport radius.");
    }
}
function validateTcpPort(port, label, allowZero = false) {
    const minimum = allowZero ? 0 : 1;
    if (!Number.isInteger(port) || port < minimum || port > 65535) {
        throw new Error(`Invalid ${label}.`);
    }
}
function acceptedResult(packet, gameConfig) {
    return gameConfig.protocol.authResultAcceptedFields.some((field) => packet[field] === true);
}
async function withTransport(options, action) {
    if (options.transport === "ssh") {
        if (!options.sshHost) {
            throw new Error("SSH transport requires --ssh-host, BRIDGE_SSH_HOST, or INCARNATE_SSH_HOST.");
        }
        const tunnel = await openSshTunnel(options.sshHost, options.aiPort);
        try {
            return await action({ host: tunnel.host, port: tunnel.port });
        }
        finally {
            tunnel.close();
        }
    }
    return await action({ host: options.aiHost, port: options.aiPort });
}
async function connectCommandSocket(host, port) {
    const socket = net.createConnection({ host, port });
    socket.setEncoding("utf8");
    await new Promise((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("error", reject);
    });
    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
    const waiters = new Map();
    rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
            return;
        }
        let packet;
        try {
            packet = JSON.parse(trimmed);
        }
        catch (error) {
            socket.destroy(error instanceof Error ? error : new Error("Invalid JSON from command socket."));
            return;
        }
        const listeners = waiters.get(String(packet.type ?? ""));
        if (!listeners || listeners.length === 0) {
            return;
        }
        const listener = listeners.shift();
        listener?.resolve(packet);
    });
    return {
        send(packet) {
            socket.write(`${JSON.stringify({ schemaVersion: 1, ...packet })}\n`);
        },
        waitFor(type, timeoutMs = 15000) {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs);
                const listeners = waiters.get(type) ?? [];
                listeners.push({
                    resolve: (packet) => {
                        clearTimeout(timeout);
                        resolve(packet);
                    },
                    reject
                });
                waiters.set(type, listeners);
            });
        },
        close() {
            rl.close();
            socket.end();
            socket.destroy();
        }
    };
}
async function authenticateConnection(connection, options) {
    const protocol = options.gameConfig.protocol;
    await connection.waitFor(protocol.hello);
    connection.send({ type: protocol.authBegin, account: options.account, keyLabel: options.keyLabel });
    const challenge = await connection.waitFor(protocol.authChallenge);
    const signature = signPayload(options.keyPath, String(challenge[protocol.authChallengePayloadField] ?? ""), options.gameConfig.signingNamespace);
    connection.send({ type: protocol.authComplete, signature });
    const result = await connection.waitFor(protocol.authResult);
    if (!acceptedResult(result, options.gameConfig)) {
        throw new Error(String(result.message ?? "Authentication failed."));
    }
}
async function commandKeyGenerate(options) {
    ensureKeyPair(options.keyPath, `${options.gameConfig.gameId}:${options.account}:${options.keyLabel}`);
    const publicKey = readPublicKey(options.keyPath);
    process.stdout.write(`Key path: ${options.keyPath}\n`);
    process.stdout.write(`Public key: ${publicKey}\n`);
    process.stdout.write(`Fingerprint: ${fingerprintPublicKey(publicKey)}\n`);
}
async function commandKeyInspect(options) {
    const publicKey = readPublicKey(options.keyPath);
    process.stdout.write(`Key path: ${options.keyPath}\n`);
    process.stdout.write(`Public key: ${publicKey}\n`);
    process.stdout.write(`Fingerprint: ${fingerprintPublicKey(publicKey)}\n`);
}
async function commandHostTrust(options) {
    if (!options.sshHost) {
        throw new Error("host trust requires --ssh-host, BRIDGE_SSH_HOST, or INCARNATE_SSH_HOST.");
    }
    await trustHost(options.sshHost);
    process.stdout.write(`Trusted host alias: ${options.sshHost}\n`);
}
async function commandAccountCreate(options) {
    const protocol = options.gameConfig.protocol;
    ensureKeyPair(options.keyPath, `${options.gameConfig.gameId}:${options.account}:${options.keyLabel}`);
    const publicKey = readPublicKey(options.keyPath);
    await withTransport(options, async (resolved) => {
        const connection = await connectCommandSocket(resolved.host, resolved.port);
        try {
            await connection.waitFor(protocol.hello);
            connection.send({
                type: protocol.accountCreateBegin,
                account: options.account,
                keyLabel: options.keyLabel,
                publicKey
            });
            const challenge = await connection.waitFor(protocol.authChallenge);
            const signature = signPayload(options.keyPath, String(challenge[protocol.authChallengePayloadField] ?? ""), options.gameConfig.signingNamespace);
            connection.send({ type: protocol.accountCreateComplete, signature });
            const result = await connection.waitFor(protocol.accountCreateResult);
            process.stdout.write(`${String(result.message ?? "")}\n`);
            if (!acceptedResult(result, options.gameConfig)) {
                process.exitCode = 1;
            }
        }
        finally {
            connection.close();
        }
    });
}
async function commandAccountAddKey(options) {
    const protocol = options.gameConfig.protocol;
    const addedKeyLabel = options.targetKeyLabel.trim() || options.keyLabel;
    const addedKeyPath = options.targetKeyPath.trim() || options.keyPath;
    ensureKeyPair(addedKeyPath, `${options.gameConfig.gameId}:${options.account}:${addedKeyLabel}`);
    const publicKey = readPublicKey(addedKeyPath);
    await withTransport(options, async (resolved) => {
        const connection = await connectCommandSocket(resolved.host, resolved.port);
        try {
            await authenticateConnection(connection, options);
            connection.send({
                type: protocol.accountAddKeyBegin,
                keyLabel: addedKeyLabel,
                publicKey
            });
            const challenge = await connection.waitFor(protocol.authChallenge);
            const signature = signPayload(addedKeyPath, String(challenge[protocol.authChallengePayloadField] ?? ""), options.gameConfig.signingNamespace);
            connection.send({ type: protocol.accountAddKeyComplete, signature });
            const result = await connection.waitFor(protocol.accountAddKeyResult);
            process.stdout.write(`${String(result.message ?? "")}\n`);
            if (!acceptedResult(result, options.gameConfig)) {
                process.exitCode = 1;
            }
        }
        finally {
            connection.close();
        }
    });
}
async function commandAccountListKeys(options) {
    const protocol = options.gameConfig.protocol;
    await withTransport(options, async (resolved) => {
        const connection = await connectCommandSocket(resolved.host, resolved.port);
        try {
            await authenticateConnection(connection, options);
            connection.send({ type: protocol.accountKeys });
            const result = await connection.waitFor(protocol.accountKeys);
            process.stdout.write(`${JSON.stringify(result.keys ?? [], null, 2)}\n`);
        }
        finally {
            connection.close();
        }
    });
}
async function commandAccountRemoveKey(options) {
    const protocol = options.gameConfig.protocol;
    const targetKeyLabel = options.targetKeyLabel.trim();
    if (!targetKeyLabel) {
        throw new Error("account remove-key requires --target-key-label.");
    }
    await withTransport(options, async (resolved) => {
        const connection = await connectCommandSocket(resolved.host, resolved.port);
        try {
            await authenticateConnection(connection, options);
            connection.send({
                type: protocol.accountRemoveKey,
                targetKeyLabel
            });
            const result = await connection.waitFor(protocol.accountRemoveKeyResult);
            process.stdout.write(`${String(result.message ?? "")}\n`);
            if (!acceptedResult(result, options.gameConfig)) {
                process.exitCode = 1;
            }
        }
        finally {
            connection.close();
        }
    });
}
async function commandBrowserStart(options) {
    ensureKeyPair(options.keyPath, `${options.gameConfig.gameId}:${options.account}:${options.keyLabel}`);
    const publicKey = readPublicKey(options.keyPath);
    if (options.bootstrapLocal && options.transport === "local-direct") {
        ensureLocalAccountKey(options.repoRoot, options.account, options.keyLabel, publicKey);
    }
    const resolvedOrigin = options.browserOrigin || `http://127.0.0.1:${envAny(["BRIDGE_BROWSER_PORT", "INCARNATE_BROWSER_PORT"], String(options.gameConfig.defaultBrowserOriginPort))}`;
    let resolved = { host: options.aiHost, port: options.aiPort };
    let tunnel = null;
    if (options.transport === "ssh") {
        if (!options.sshHost) {
            throw new Error("SSH transport requires --ssh-host, BRIDGE_SSH_HOST, or INCARNATE_SSH_HOST.");
        }
        const openedTunnel = await openSshTunnel(options.sshHost, options.aiPort);
        tunnel = openedTunnel;
        resolved = { host: openedTunnel.host, port: openedTunnel.port };
    }
    const server = await startBrowserBridgeServer({
        gameConfig: options.gameConfig,
        aiHost: resolved.host,
        aiPort: resolved.port,
        wsHost: options.wsHost,
        wsPort: options.wsPort,
        account: options.account,
        keyLabel: options.keyLabel,
        keyPath: options.keyPath,
        character: options.character,
        radius: options.radius,
        sessionToken: options.sessionToken,
        allowedOrigin: resolvedOrigin
    });
    process.stdout.write(`${options.gameConfig.displayName} bridge listening on ws://${options.wsHost}:${server.port}/?token=${options.sessionToken}\n`);
    process.stdout.write(`Allowed browser origin: ${resolvedOrigin}\n`);
    const stop = async () => {
        await server.close();
        tunnel?.close();
        process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await new Promise(() => { });
}
async function main() {
    const args = process.argv.slice(2);
    const [scope = "", action = "", ...rest] = args;
    const options = parseCommonOptions(rest);
    if (scope === "key" && action === "generate") {
        await commandKeyGenerate(options);
        return;
    }
    if (scope === "key" && action === "inspect") {
        await commandKeyInspect(options);
        return;
    }
    if (scope === "host" && action === "trust") {
        await commandHostTrust(options);
        return;
    }
    if (scope === "account" && action === "create") {
        await commandAccountCreate(options);
        return;
    }
    if (scope === "account" && action === "add-key") {
        await commandAccountAddKey(options);
        return;
    }
    if (scope === "account" && action === "list-keys") {
        await commandAccountListKeys(options);
        return;
    }
    if (scope === "account" && action === "remove-key") {
        await commandAccountRemoveKey(options);
        return;
    }
    if (scope === "browser" && action === "start") {
        await commandBrowserStart(options);
        return;
    }
    throw new Error("Usage: incarnate-bridge <key|host|account|browser> <action> [options]");
}
main().catch((error) => {
    console.error(String(error));
    process.exit(1);
});
