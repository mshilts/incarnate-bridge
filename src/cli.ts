#!/usr/bin/env node

import net from "node:net";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import {
  defaultKeyPath,
  ensureKeyPair,
  fingerprintPublicKey,
  openSshTunnel,
  readPublicKey,
  signPayload,
  trustHost
} from "./openssh.js";
import { ensureLocalAccountKey } from "./local-bootstrap.js";
import { startBrowserBridgeServer } from "./browser-server.js";

type TransportOptions = {
  transport: "ssh" | "local-direct";
  sshHost: string;
  aiHost: string;
  aiPort: number;
};

type CommonOptions = TransportOptions & {
  repoRoot: string;
  account: string;
  keyLabel: string;
  targetKeyLabel: string;
  keyPath: string;
  targetKeyPath: string;
  character: string;
  radius: number;
  wsHost: string;
  wsPort: number;
  browserOrigin: string;
  sessionToken: string;
  bootstrapLocal: boolean;
};

function env(name: string, fallback = "") {
  return process.env[name] ?? fallback;
}

function parseCommonOptions(args: string[]): CommonOptions {
  const options: CommonOptions = {
    transport: (env("INCARNATE_TRANSPORT", "local-direct") === "ssh" ? "ssh" : "local-direct"),
    sshHost: env("INCARNATE_SSH_HOST", ""),
    aiHost: env("INCARNATE_HOST", "127.0.0.1"),
    aiPort: Number(env("INCARNATE_AI_PORT", "8083")),
    repoRoot: env("INCARNATE_REPO_ROOT", process.cwd()),
    account: env("INCARNATE_ACCOUNT", "matt"),
    keyLabel: env("INCARNATE_KEY_LABEL", "local-dev"),
    targetKeyLabel: env("INCARNATE_TARGET_KEY_LABEL", ""),
    keyPath: env("INCARNATE_KEY_PATH", defaultKeyPath()),
    targetKeyPath: env("INCARNATE_TARGET_KEY_PATH", ""),
    character: env("INCARNATE_CHARACTER", ""),
    radius: Number(env("INCARNATE_RADIUS", "14")),
    wsHost: env("INCARNATE_BROWSER_BRIDGE_HOST", "127.0.0.1"),
    wsPort: Number(env("INCARNATE_BROWSER_BRIDGE_PORT", "8787")),
    browserOrigin: env("INCARNATE_BROWSER_ORIGIN", ""),
    sessionToken: env("INCARNATE_BROWSER_SESSION_TOKEN", randomUUID()),
    bootstrapLocal: env("INCARNATE_BOOTSTRAP_LOCAL_DEV", "false") === "true"
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => args[++index] ?? "";
    if (arg === "--transport") {
      options.transport = next() === "ssh" ? "ssh" : "local-direct";
    } else if (arg === "--ssh-host") {
      options.sshHost = next();
    } else if (arg === "--ai-host") {
      options.aiHost = next();
    } else if (arg === "--ai-port") {
      options.aiPort = Number(next());
    } else if (arg === "--repo-root") {
      options.repoRoot = next();
    } else if (arg === "--account") {
      options.account = next();
    } else if (arg === "--key-label") {
      options.keyLabel = next();
    } else if (arg === "--target-key-label" || arg === "--new-key-label" || arg === "--remove-key-label") {
      options.targetKeyLabel = next();
    } else if (arg === "--key-path") {
      options.keyPath = next();
    } else if (arg === "--target-key-path" || arg === "--new-key-path") {
      options.targetKeyPath = next();
    } else if (arg === "--character") {
      options.character = next();
    } else if (arg === "--radius") {
      options.radius = Number(next());
    } else if (arg === "--ws-host") {
      options.wsHost = next();
    } else if (arg === "--ws-port") {
      options.wsPort = Number(next());
    } else if (arg === "--browser-origin") {
      options.browserOrigin = next();
    } else if (arg === "--session-token") {
      options.sessionToken = next();
    } else if (arg === "--bootstrap-local-dev") {
      options.bootstrapLocal = true;
    }
  }
  return options;
}

async function withTransport<T>(options: TransportOptions, action: (resolved: { host: string; port: number }) => Promise<T>) {
  if (options.transport === "ssh") {
    if (!options.sshHost) {
      throw new Error("SSH transport requires --ssh-host or INCARNATE_SSH_HOST.");
    }
    const tunnel = await openSshTunnel(options.sshHost, options.aiPort);
    try {
      return await action({ host: tunnel.host, port: tunnel.port });
    } finally {
      tunnel.close();
    }
  }
  return await action({ host: options.aiHost, port: options.aiPort });
}

async function connectCommandSocket(host: string, port: number) {
  const socket = net.createConnection({ host, port });
  socket.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
  const waiters = new Map<string, { resolve: (packet: any) => void; reject: (error: Error) => void }[]>();
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    const packet = JSON.parse(trimmed);
    const listeners = waiters.get(String(packet.type ?? ""));
    if (!listeners || listeners.length === 0) {
      return;
    }
    const listener = listeners.shift();
    listener?.resolve(packet);
  });
  return {
    send(packet: Record<string, unknown>) {
      socket.write(`${JSON.stringify({ schemaVersion: 1, ...packet })}\n`);
    },
    waitFor(type: string, timeoutMs = 15000) {
      return new Promise<any>((resolve, reject) => {
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

async function authenticateConnection(connection: Awaited<ReturnType<typeof connectCommandSocket>>, options: CommonOptions) {
  await connection.waitFor("hello");
  connection.send({ type: "auth_begin", account: options.account, keyLabel: options.keyLabel });
  const challenge = await connection.waitFor("auth_challenge");
  const signature = signPayload(options.keyPath, String(challenge.signingPayload ?? ""));
  connection.send({ type: "auth_complete", signature });
  const result = await connection.waitFor("auth_result");
  if (!(result.ok === true || result.accepted === true)) {
    throw new Error(String(result.message ?? "Authentication failed."));
  }
}

async function commandKeyGenerate(options: CommonOptions) {
  ensureKeyPair(options.keyPath, `incarnate:${options.account}:${options.keyLabel}`);
  const publicKey = readPublicKey(options.keyPath);
  process.stdout.write(`Key path: ${options.keyPath}\n`);
  process.stdout.write(`Public key: ${publicKey}\n`);
  process.stdout.write(`Fingerprint: ${fingerprintPublicKey(publicKey)}\n`);
}

async function commandKeyInspect(options: CommonOptions) {
  const publicKey = readPublicKey(options.keyPath);
  process.stdout.write(`Key path: ${options.keyPath}\n`);
  process.stdout.write(`Public key: ${publicKey}\n`);
  process.stdout.write(`Fingerprint: ${fingerprintPublicKey(publicKey)}\n`);
}

async function commandHostTrust(options: CommonOptions) {
  if (!options.sshHost) {
    throw new Error("host trust requires --ssh-host or INCARNATE_SSH_HOST.");
  }
  await trustHost(options.sshHost);
  process.stdout.write(`Trusted host alias: ${options.sshHost}\n`);
}

async function commandAccountCreate(options: CommonOptions) {
  ensureKeyPair(options.keyPath, `incarnate:${options.account}:${options.keyLabel}`);
  const publicKey = readPublicKey(options.keyPath);
  await withTransport(options, async (resolved) => {
    const connection = await connectCommandSocket(resolved.host, resolved.port);
    try {
      await connection.waitFor("hello");
      connection.send({
        type: "account_create_begin",
        account: options.account,
        keyLabel: options.keyLabel,
        publicKey
      });
      const challenge = await connection.waitFor("auth_challenge");
      const signature = signPayload(options.keyPath, String(challenge.signingPayload ?? ""));
      connection.send({ type: "account_create_complete", signature });
      const result = await connection.waitFor("account_create_result");
      process.stdout.write(`${String(result.message ?? "")}\n`);
      if (!(result.ok === true || result.accepted === true)) {
        process.exitCode = 1;
      }
    } finally {
      connection.close();
    }
  });
}

async function commandAccountAddKey(options: CommonOptions) {
  const addedKeyLabel = options.targetKeyLabel.trim() || options.keyLabel;
  const addedKeyPath = options.targetKeyPath.trim() || options.keyPath;
  ensureKeyPair(addedKeyPath, `incarnate:${options.account}:${addedKeyLabel}`);
  const publicKey = readPublicKey(addedKeyPath);
  await withTransport(options, async (resolved) => {
    const connection = await connectCommandSocket(resolved.host, resolved.port);
    try {
      await authenticateConnection(connection, options);
      connection.send({
        type: "account_add_key_begin",
        keyLabel: addedKeyLabel,
        publicKey
      });
      const challenge = await connection.waitFor("auth_challenge");
      const signature = signPayload(addedKeyPath, String(challenge.signingPayload ?? ""));
      connection.send({ type: "account_add_key_complete", signature });
      const result = await connection.waitFor("account_add_key_result");
      process.stdout.write(`${String(result.message ?? "")}\n`);
      if (!(result.ok === true || result.accepted === true)) {
        process.exitCode = 1;
      }
    } finally {
      connection.close();
    }
  });
}

async function commandAccountListKeys(options: CommonOptions) {
  await withTransport(options, async (resolved) => {
    const connection = await connectCommandSocket(resolved.host, resolved.port);
    try {
      await authenticateConnection(connection, options);
      connection.send({ type: "account_keys" });
      const result = await connection.waitFor("account_keys");
      process.stdout.write(`${JSON.stringify(result.keys ?? [], null, 2)}\n`);
    } finally {
      connection.close();
    }
  });
}

async function commandAccountRemoveKey(options: CommonOptions) {
  const targetKeyLabel = options.targetKeyLabel.trim();
  if (!targetKeyLabel) {
    throw new Error("account remove-key requires --target-key-label.");
  }
  await withTransport(options, async (resolved) => {
    const connection = await connectCommandSocket(resolved.host, resolved.port);
    try {
      await authenticateConnection(connection, options);
      connection.send({
        type: "account_remove_key",
        targetKeyLabel
      });
      const result = await connection.waitFor("account_remove_key_result");
      process.stdout.write(`${String(result.message ?? "")}\n`);
      if (!(result.ok === true || result.accepted === true)) {
        process.exitCode = 1;
      }
    } finally {
      connection.close();
    }
  });
}

async function commandBrowserStart(options: CommonOptions) {
  ensureKeyPair(options.keyPath, `incarnate:${options.account}:${options.keyLabel}`);
  const publicKey = readPublicKey(options.keyPath);
  if (options.bootstrapLocal && options.transport === "local-direct") {
    ensureLocalAccountKey(options.repoRoot, options.account, options.keyLabel, publicKey);
  }
  const resolvedOrigin = options.browserOrigin || `http://127.0.0.1:${env("INCARNATE_BROWSER_PORT", "4174")}`;
  let resolved = { host: options.aiHost, port: options.aiPort };
  let tunnel: { close: () => void } | null = null;
  if (options.transport === "ssh") {
    if (!options.sshHost) {
      throw new Error("SSH transport requires --ssh-host or INCARNATE_SSH_HOST.");
    }
    const openedTunnel = await openSshTunnel(options.sshHost, options.aiPort);
    tunnel = openedTunnel;
    resolved = { host: openedTunnel.host, port: openedTunnel.port };
  }
  const server = await startBrowserBridgeServer({
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
  process.stdout.write(`Incarnate bridge listening on ws://${options.wsHost}:${server.port}/?token=${options.sessionToken}\n`);
  process.stdout.write(`Allowed browser origin: ${resolvedOrigin}\n`);
  const stop = async () => {
    await server.close();
    tunnel?.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await new Promise<void>(() => {});
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
