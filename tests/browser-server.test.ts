import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { startBrowserBridgeServer } from "../src/browser-server.js";
import { ensureKeyPair } from "../src/openssh.js";

const TOKEN = "unit-test-token";
const ORIGIN = "http://127.0.0.1:4174";

test("browser bridge rejects bad token and wrong origin before opening a session", async () => {
  const key = createTestKey();
  const mockAi = await startMockAiServer();
  const bridge = await startBrowserBridgeServer({
    aiHost: "127.0.0.1",
    aiPort: mockAi.port,
    wsHost: "127.0.0.1",
    wsPort: 0,
    account: "matt",
    keyLabel: "device",
    keyPath: key.path,
    character: "Matthew_mage",
    radius: 6,
    sessionToken: TOKEN,
    allowedOrigin: ORIGIN
  });

  try {
    await assertRejected(bridge.port, "bad-token", ORIGIN);
    await assertRejected(bridge.port, TOKEN, "http://attacker.invalid");
    assert.equal(mockAi.received.length, 0, "policy-rejected browsers should not connect to the AI socket");
  } finally {
    await bridge.close();
    await mockAi.close();
    key.close();
  }
});

test("authenticated browser bridge signs auth, auto-selects the character, and relays allowed commands", async () => {
  const key = createTestKey();
  const mockAi = await startMockAiServer();
  const bridge = await startBrowserBridgeServer({
    aiHost: "127.0.0.1",
    aiPort: mockAi.port,
    wsHost: "127.0.0.1",
    wsPort: 0,
    account: "matt",
    keyLabel: "device",
    keyPath: key.path,
    character: "Matthew_mage",
    radius: 9,
    sessionToken: TOKEN,
    allowedOrigin: ORIGIN
  });

  try {
    const client = await connectBrowser(bridge.port);
    await waitFor(() => client.packets.some((packet) => packet.type === "session_ready"), "session should become ready");

    assert(mockAi.received.some((packet) => packet.type === "client_capabilities"));
    assert(mockAi.received.some((packet) => packet.type === "auth_begin" && packet.account === "matt" && packet.keyLabel === "device"));
    assert(mockAi.received.some((packet) => packet.type === "auth_complete" && String(packet.signature).includes("BEGIN SSH SIGNATURE")));
    assert(mockAi.received.some((packet) => packet.type === "character_select" && packet.character === "Matthew_mage" && packet.radius === 9));
    assert(mockAi.received.some((packet) => packet.type === "query_viewport"));

    client.ws.send(JSON.stringify({ type: "move", direction: "east", count: 1 }));
    client.ws.send(JSON.stringify({ type: "payments_command", action: "status" }));
    await waitFor(() => mockAi.received.some((packet) => packet.type === "move"), "move should relay");
    await waitFor(() => mockAi.received.some((packet) => packet.type === "payments_command"), "payment commands should relay to server authorization");

    client.ws.close();
    await once(client.ws, "close");
  } finally {
    await bridge.close();
    await mockAi.close();
    key.close();
  }
});

test("browser bridge blocks malformed, oversized, unsupported, and browser-managed account commands", async () => {
  const key = createTestKey();
  const mockAi = await startMockAiServer();
  const bridge = await startBrowserBridgeServer({
    aiHost: "127.0.0.1",
    aiPort: mockAi.port,
    wsHost: "127.0.0.1",
    wsPort: 0,
    account: "matt",
    keyLabel: "device",
    keyPath: key.path,
    character: "Matthew_mage",
    radius: 6,
    sessionToken: TOKEN,
    allowedOrigin: ORIGIN
  });

  try {
    const client = await connectBrowser(bridge.port);
    await waitFor(() => client.packets.some((packet) => packet.type === "session_ready"), "session should become ready");

    client.ws.send("{bad");
    await waitForError(client.packets, "invalid_browser_json");

    client.ws.send("x".repeat(70_000));
    await waitForError(client.packets, "browser_message_too_large");

    const beforeUnsupported = mockAi.received.length;
    client.ws.send(JSON.stringify({ type: "shell", command: "id" }));
    await waitForError(client.packets, "unsupported_command");
    await delay(50);
    assert.equal(mockAi.received.length, beforeUnsupported, "unsupported commands must not reach the server");

    for (const command of [
      { type: "auth_begin", account: "matt", keyLabel: "device" },
      { type: "account_create_begin", account: "evil", keyLabel: "device" },
      { type: "account_add_key_begin", keyLabel: "second-device" }
    ]) {
      const before = mockAi.received.length;
      client.ws.send(JSON.stringify(command));
      await waitForError(client.packets, "account_command_forbidden");
      await delay(50);
      assert.equal(mockAi.received.slice(before).some((packet) => packet.type === command.type), false, `${command.type} must not leak upstream`);
    }

    client.ws.send(JSON.stringify({ type: "look_tile", x: 1, y: 1 }));
    await waitFor(() => mockAi.received.some((packet) => packet.type === "look_tile"), "session should keep working after rejected frames");

    client.ws.close();
    await once(client.ws, "close");
  } finally {
    await bridge.close();
    await mockAi.close();
    key.close();
  }
});

test("account setup session permits account creation and injects local public key metadata", async () => {
  const key = createTestKey();
  const publicKey = readFileSync(`${key.path}.pub`, "utf8").trim();
  const mockAi = await startMockAiServer();
  const bridge = await startBrowserBridgeServer({
    aiHost: "127.0.0.1",
    aiPort: mockAi.port,
    wsHost: "127.0.0.1",
    wsPort: 0,
    account: "",
    keyLabel: "device",
    keyPath: key.path,
    character: "",
    radius: 6,
    sessionToken: TOKEN,
    allowedOrigin: ORIGIN
  });

  try {
    const client = await connectBrowser(bridge.port);
    await waitFor(() => client.packets.some((packet) => packet.type === "session_state" && packet.state === "ready"), "setup session should become ready");

    client.ws.send(JSON.stringify({ type: "account_create_begin", account: "newplayer" }));
    await waitFor(() => mockAi.received.some((packet) => packet.type === "account_create_begin"), "account create should relay during setup");
    const accountCreate = mockAi.received.find((packet) => packet.type === "account_create_begin");
    assert.equal(accountCreate?.keyLabel, "device");
    assert.equal(accountCreate?.publicKey, publicKey);
    await waitFor(() => mockAi.received.some((packet) => packet.type === "account_create_complete"), "bridge should sign account create challenge");

    client.ws.send(JSON.stringify({ type: "account_add_key_begin", keyLabel: "second" }));
    await waitForError(client.packets, "account_command_forbidden");

    client.ws.close();
    await once(client.ws, "close");
  } finally {
    await bridge.close();
    await mockAi.close();
    key.close();
  }
});

test("AI ping is answered locally and malformed AI JSON closes the browser session", async () => {
  const key = createTestKey();
  const mockAi = await startMockAiServer({ sendInvalidJsonAfterHello: true });
  const bridge = await startBrowserBridgeServer({
    aiHost: "127.0.0.1",
    aiPort: mockAi.port,
    wsHost: "127.0.0.1",
    wsPort: 0,
    account: "",
    keyLabel: "device",
    keyPath: key.path,
    character: "",
    radius: 6,
    sessionToken: TOKEN,
    allowedOrigin: ORIGIN
  });

  try {
    const client = await connectBrowser(bridge.port);
    await waitFor(() => mockAi.received.some((packet) => packet.type === "pong" && packet.token === "unit-ping"), "bridge should answer AI ping locally");
    await waitForError(client.packets, "invalid_ai_json");
    await waitFor(
      () => client.ws.readyState === WebSocket.CLOSING || client.ws.readyState === WebSocket.CLOSED,
      "browser socket should close after malformed AI JSON"
    );
  } finally {
    await bridge.close();
    await mockAi.close();
    key.close();
  }
});

function createTestKey() {
  const tempDir = mkdtempSync(join(tmpdir(), "incarnate-browser-test-"));
  const keyPath = join(tempDir, "id_ed25519");
  ensureKeyPair(keyPath, "incarnate-browser-test");
  return {
    path: keyPath,
    close: () => rmSync(tempDir, { recursive: true, force: true })
  };
}

async function assertRejected(port: number, token: string, origin: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}`, {
    headers: { Origin: origin }
  });
  const [code] = await once(ws, "close") as [number, Buffer];
  assert.equal(code, 1008);
}

async function connectBrowser(port: number) {
  const packets: Array<Record<string, unknown>> = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(TOKEN)}`, {
    headers: { Origin: ORIGIN }
  });
  ws.on("message", (data) => packets.push(JSON.parse(String(data))));
  await once(ws, "open");
  return { ws, packets };
}

async function waitForError(packets: Array<Record<string, unknown>>, code: string) {
  await waitFor(
    () => packets.some((packet) => packet.type === "session_error" && packet.code === code),
    `expected session_error ${code}`
  );
}

interface MockAiServer {
  port: number;
  received: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

async function startMockAiServer(options: { sendInvalidJsonAfterHello?: boolean } = {}): Promise<MockAiServer> {
  const received: Array<Record<string, unknown>> = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    send(socket, { schemaVersion: 1, type: "hello" });
    send(socket, { schemaVersion: 1, type: "ping", token: "unit-ping" });
    if (options.sendInvalidJsonAfterHello) {
      setTimeout(() => socket.write("{invalid-json\n"), 20);
    }
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const packet = JSON.parse(line) as Record<string, unknown>;
          received.push(packet);
          handleAiCommand(socket, packet);
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    received,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

function handleAiCommand(socket: net.Socket, packet: Record<string, unknown>) {
  if (packet.type === "auth_begin" || packet.type === "account_create_begin") {
    send(socket, { schemaVersion: 1, type: "auth_challenge", signingPayload: `${packet.type}:unit-challenge` });
    return;
  }
  if (packet.type === "auth_complete") {
    send(socket, { schemaVersion: 1, type: "auth_result", ok: true, account: "matt" });
    send(socket, {
      schemaVersion: 1,
      type: "character_list",
      characters: [{ name: "Matthew_mage", editable: true, active: false }],
      canCreate: true
    });
    return;
  }
  if (packet.type === "account_create_complete") {
    send(socket, { schemaVersion: 1, type: "account_create_result", ok: true, account: "newplayer" });
    return;
  }
  if (packet.type === "character_select") {
    send(socket, {
      schemaVersion: 1,
      type: "character_selected",
      character: String(packet.character ?? "Matthew_mage"),
      mapName: "Sordon's Castle"
    });
    send(socket, { schemaVersion: 1, type: "viewport", mapName: "Sordon's Castle", width: 1, height: 1, tiles: [] });
  }
}

function send(socket: net.Socket, packet: Record<string, unknown>) {
  socket.write(`${JSON.stringify(packet)}\n`);
}

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(20);
  }
  throw new Error(message);
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
