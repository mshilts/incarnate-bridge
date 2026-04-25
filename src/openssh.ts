import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const SSH_SIGNING_NAMESPACE = "incarnate-auth";
export const KEY_ONLY_SENTINEL = "KEY_ONLY";

export function defaultKeyPath() {
  return path.join(os.homedir(), ".ssh", "incarnate_ed25519");
}

export function ensureKeyPair(keyPath: string, comment = "incarnate") {
  if (fs.existsSync(keyPath) && fs.existsSync(`${keyPath}.pub`)) {
    return;
  }
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const result = spawnSync("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-C", comment], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "ssh-keygen failed");
  }
}

export function readPublicKey(keyPath: string) {
  return fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
}

export function fingerprintPublicKey(publicKey: string) {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "incarnate-fingerprint-"));
  const publicKeyPath = path.join(tempDirectory, "key.pub");
  try {
    fs.writeFileSync(publicKeyPath, `${publicKey}\n`, "utf8");
    const result = spawnSync("ssh-keygen", ["-lf", publicKeyPath], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || "ssh-keygen -lf failed");
    }
    const line = String(result.stdout ?? "").trim();
    const parts = line.split(/\s+/);
    return parts[1] ?? "";
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

export function signPayload(keyPath: string, payload: string) {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "incarnate-sign-"));
  const payloadPath = path.join(tempDirectory, "payload.txt");
  try {
    fs.writeFileSync(payloadPath, payload, "utf8");
    const result = spawnSync("ssh-keygen", ["-Y", "sign", "-f", keyPath, "-n", SSH_SIGNING_NAMESPACE, payloadPath], {
      encoding: "utf8"
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || "ssh-keygen -Y sign failed");
    }
    return fs.readFileSync(`${payloadPath}.sig`, "utf8");
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

export async function trustHost(sshHost: string) {
  const result = spawnSync("ssh", ["-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes", "-T", sshHost, "exit"], {
    encoding: "utf8"
  });
  if (result.status !== 0 && !`${result.stderr}\n${result.stdout}`.includes("Permanently added")) {
    throw new Error(result.stderr || result.stdout || "ssh host trust failed");
  }
}

async function reserveLocalPort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForPort(host: string, port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const opened = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host, port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (opened) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for forwarded port ${host}:${port}`);
}

export async function openSshTunnel(sshHost: string, remotePort: number) {
  const localPort = await reserveLocalPort();
  const process = spawn("ssh", [
    "-o",
    "ExitOnForwardFailure=yes",
    "-N",
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    sshHost
  ], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  process.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  let closed = false;
  process.once("exit", () => {
    closed = true;
  });

  try {
    await waitForPort("127.0.0.1", localPort, 10000);
  } catch (error) {
    if (!closed) {
      process.kill("SIGTERM");
    }
    throw new Error(stderr.trim() || String(error));
  }

  return {
    host: "127.0.0.1",
    port: localPort,
    close: () => {
      if (!closed) {
        process.kill("SIGTERM");
      }
    }
  };
}
