import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocket } from "ws";
import { startBrowserBridgeServer } from "../src/browser-server.js";
import { defineBridgeGameConfig } from "../src/config.js";
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

test("browser bridge refuses to start without a session token", async () => {
  const key = createTestKey();
  const mockAi = await startMockAiServer();
  try {
    await assert.rejects(
      () => startBrowserBridgeServer({
        aiHost: "127.0.0.1",
        aiPort: mockAi.port,
        wsHost: "127.0.0.1",
        wsPort: 0,
        account: "matt",
        keyLabel: "device",
        keyPath: key.path,
        character: "Matthew_mage",
        radius: 6,
        sessionToken: "",
        allowedOrigin: ORIGIN
      }),
      /session token/
    );
  } finally {
    await mockAi.close();
    key.close();
  }
});

test("status is bearer protected and reports bridge identity separately from game readiness", async () => {
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
    allowedOrigin: ORIGIN,
    instanceId: "launcher-owner-id",
    ownerHost: "game.example",
    ownerAccount: "matt",
    ownerKeyLabel: "laptop",
    keyFingerprint: "SHA256:public-key-fingerprint",
    lifecycleTimings: { initialAttachTimeoutMs: 2_000 }
  });

  try {
    const url = `http://127.0.0.1:${bridge.port}/__incarnate/status`;
    assert.equal((await fetch(url)).status, 401, "status must require the bridge session token");
    assert.equal((await fetch(url, { headers: { Authorization: "Bearer wrong-token" } })).status, 401);
    const waitingResponse = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(waitingResponse.status, 200);
    const waiting = await waitingResponse.json() as Record<string, unknown>;
    assert.equal(waiting.instanceId, "launcher-owner-id");
    assert.equal(waiting.host, "game.example");
    assert.equal(waiting.ownerAccount, "matt");
    assert.equal(waiting.ownerKeyLabel, "laptop");
    assert.equal(waiting.keyFingerprint, "SHA256:public-key-fingerprint");
    assert.equal(waiting.state, "waiting");
    assert.equal(waiting.sessionState, "not_started");
    assert.equal(waiting.browserAttached, false);

    const client = await connectBrowser(bridge.port);
    await waitFor(() => client.packets.some((packet) => packet.type === "session_ready"), "session should become ready");
    const attachedResponse = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const attached = await attachedResponse.json() as Record<string, unknown>;
    assert.equal(attached.state, "attached");
    assert.equal(attached.sessionState, "ready");
    assert.equal(attached.browserAttached, true);
    assert.equal(attached.account, "matt");
    assert.equal(attached.character, "Matthew_mage");

    const unauthorized = new WebSocket(`ws://127.0.0.1:${bridge.port}?token=wrong-token`, {
      headers: { Origin: ORIGIN }
    });
    const [closeCode] = await once(unauthorized, "close") as [number, Buffer];
    assert.equal(closeCode, 1008, "an invalid token cannot control the live session");
    assert.equal(client.ws.readyState, WebSocket.OPEN, "rejecting another socket leaves the owning browser attached");

    client.ws.send(JSON.stringify({ type: "bridge_disconnect" }));
    await once(client.ws, "close");
    await bridge.closed;
    await waitFor(() => mockAi.closedConnectionCount === 1, "disconnect should close the game socket");
    assert.equal(mockAi.connectionCount, 1, "disconnect closes the existing upstream instead of opening another session");
  } finally {
    await bridge.close();
    await mockAi.close();
    key.close();
  }
});

test("browser reconnect cancels the detach timer and stale timer generation", async () => {
  const key = createTestKey();
  const mockAi = await startMockAiServer();
  const bridge = await startBrowserBridgeServer({
    aiHost: "127.0.0.1",
    aiPort: mockAi.port,
    wsHost: "127.0.0.1",
    wsPort: 0,
    account: "",
    keyLabel: "device",
    keyPath: key.path,
    character: "Matthew_mage",
    radius: 6,
    sessionToken: TOKEN,
    allowedOrigin: ORIGIN,
    lifecycleTimings: {
      initialAttachTimeoutMs: 2_000,
      reconnectGraceMs: 100,
      browserPingIntervalMs: 500,
      browserPongTimeoutMs: 1_000,
      closeTimeoutMs: 50
    }
  });

  try {
    const first = await connectBrowser(bridge.port);
    await waitFor(() => hasReadyBrowserSession(first.packets), "initial browser should be ready");
    first.ws.close();
    await once(first.ws, "close");
    await waitForStatusState(bridge.port, TOKEN, "detached");
    await delay(40);

    const second = await connectBrowser(bridge.port);
    await waitFor(() => hasReadyBrowserSession(second.packets), "replacement browser should resume the session");
    await delay(100);
    assert.equal(mockAi.connectionCount, 1, "reload reuses the original AI session");
    assert.equal(second.ws.readyState, WebSocket.OPEN, "the old detach timer must not close a reattached browser");
    await waitForStatusState(bridge.port, TOKEN, "attached");

    second.ws.close();
    await once(second.ws, "close");
    await waitForStatusState(bridge.port, TOKEN, "detached");
    await bridge.closed;
    await waitFor(() => mockAi.closedConnectionCount === 1, "expired reconnect grace should close the game socket");
  } finally {
    await bridge.close();
    await mockAi.close();
    key.close();
  }
});

test("a replacement browser gets ownership without reconnecting the replaced socket", async () => {
  const key = createTestKey();
  const mockAi = await startMockAiServer();
  const bridge = await startBrowserBridgeServer({
    aiHost: "127.0.0.1",
    aiPort: mockAi.port,
    wsHost: "127.0.0.1",
    wsPort: 0,
    account: "",
    keyLabel: "device",
    keyPath: key.path,
    character: "Matthew_mage",
    radius: 6,
    sessionToken: TOKEN,
    allowedOrigin: ORIGIN,
    lifecycleTimings: {
      initialAttachTimeoutMs: 2_000,
      reconnectGraceMs: 100,
      browserPingIntervalMs: 500,
      browserPongTimeoutMs: 1_000,
      closeTimeoutMs: 50
    }
  });

  try {
    const first = await connectBrowser(bridge.port);
    await waitFor(() => hasReadyBrowserSession(first.packets), "first browser should be ready");

    const second = await connectBrowser(bridge.port);
    const [closeCode, closeReason] = await once(first.ws, "close") as [number, Buffer];
    assert.equal(closeCode, 4001, "replacement is explicit so the old browser does not auto-reconnect");
    assert.match(closeReason.toString(), /replaced/i);
    await waitFor(() => hasReadyBrowserSession(second.packets), "replacement browser should resume the session");
    assert.equal((await fetch(`http://127.0.0.1:${bridge.port}/__incarnate/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    }).then((response) => response.json()) as Record<string, unknown>).state, "attached");
    assert.equal(mockAi.connectionCount, 1, "replacing a browser keeps one authenticated game session");

    second.ws.send(JSON.stringify({ type: "bridge_disconnect" }));
    await once(second.ws, "close");
    await bridge.closed;
  } finally {
    await bridge.close();
    await mockAi.close();
    key.close();
  }
});

test("browser bridge expires without an initial browser attachment", async () => {
  const key = createTestKey();
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
    allowedOrigin: ORIGIN,
    lifecycleTimings: { initialAttachTimeoutMs: 50, closeTimeoutMs: 25 }
  });

  try {
    await bridge.closed;
    assert.equal(mockAi.connectionCount, 0, "no game session starts before an authenticated browser attaches");
  } finally {
    await bridge.close();
    await mockAi.close();
    key.close();
  }
});

test("browser heartbeat expires a silent browser and closes its game session", async () => {
  const key = createTestKey();
  const mockAi = await startMockAiServer();
  const bridge = await startBrowserBridgeServer({
    aiHost: "127.0.0.1",
    aiPort: mockAi.port,
    wsHost: "127.0.0.1",
    wsPort: 0,
    account: "",
    keyLabel: "device",
    keyPath: key.path,
    character: "Matthew_mage",
    radius: 6,
    sessionToken: TOKEN,
    allowedOrigin: ORIGIN,
    lifecycleTimings: {
      initialAttachTimeoutMs: 2_000,
      reconnectGraceMs: 20,
      browserPingIntervalMs: 20,
      browserPongTimeoutMs: 60,
      closeTimeoutMs: 25
    }
  });
  let closed = false;
  void bridge.closed.then(() => { closed = true; });

  try {
    const packets: Array<Record<string, unknown>> = [];
    const silent = new WebSocket(`ws://127.0.0.1:${bridge.port}?token=${encodeURIComponent(TOKEN)}`, {
      headers: { Origin: ORIGIN },
      autoPong: false
    });
    let pingCount = 0;
    silent.on("ping", () => { pingCount += 1; });
    silent.on("message", (data) => packets.push(JSON.parse(String(data))));
    await once(silent, "open");
    await waitFor(() => closed, "a browser that stops answering WebSocket pings should be disconnected");
    await waitFor(() => mockAi.closedConnectionCount === 1, "silent-browser cleanup should close the game socket");
    assert(pingCount > 0, "the bridge probes browser liveness with protocol pings");
  } finally {
    await bridge.close();
    await mockAi.close();
    key.close();
  }
});

test("CLI exits after an authenticated browser requests bridge disconnect", async () => {
  const key = createTestKey();
  const mockAi = await startMockAiServer();
  const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const child = spawn(process.execPath, [
    cliPath,
    "browser",
    "start",
    "--ai-host", "127.0.0.1",
    "--ai-port", String(mockAi.port),
    "--ws-host", "127.0.0.1",
    "--ws-port", "0",
    "--browser-origin", ORIGIN,
    "--session-token", TOKEN,
    "--key-path", key.path,
    "--account", "",
    "--character", "Matthew_mage"
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;

  try {
    await waitFor(() => output.includes("bridge listening on"), "CLI should announce the browser bridge");
    const port = Number(output.match(/bridge listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1]);
    assert(Number.isInteger(port) && port > 0, "CLI should report its assigned bridge port");
    const browser = await connectBrowser(port);
    browser.ws.send(JSON.stringify({ type: "bridge_disconnect" }));
    const [exitCode] = await exited;
    assert.equal(exitCode, 0, "CLI should exit cleanly after bridge shutdown");
    await waitFor(() => mockAi.closedConnectionCount === 1, "CLI shutdown should close the upstream game socket");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
    await mockAi.close();
    key.close();
  }
});

test("oversized AI JSON lines close the browser session", async () => {
  const key = createTestKey();
  const mockAi = await startMockAiServer({ sendOversizedLineAfterHello: true });
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
    await waitForError(client.packets, "ai_message_too_large");
    await waitFor(
      () => client.ws.readyState === WebSocket.CLOSING || client.ws.readyState === WebSocket.CLOSED,
      "browser socket should close after oversized AI JSON"
    );
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

test("browser bridge forwards open-ended game commands to AI socket", async () => {
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

    client.ws.send(JSON.stringify({ type: "shell", command: "server-authorized-command" }));
    client.ws.send(JSON.stringify({ type: "future_server_command", payload: { ok: true } }));
    await waitFor(() => mockAi.received.some((packet) => packet.type === "shell"), "unknown game command should relay");
    await waitFor(() => mockAi.received.some((packet) => packet.type === "future_server_command"), "future server command should relay");

    client.ws.close();
    await once(client.ws, "close");
  } finally {
    await bridge.close();
    await mockAi.close();
    key.close();
  }
});

test("browser bridge forwards new server commands without bridge catalog updates", async () => {
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

    client.ws.send(JSON.stringify({ type: "ops_dashboard_request" }));
    await waitFor(() => mockAi.received.some((packet) => packet.type === "ops_dashboard_request"), "SysOps dashboard command should relay");

    client.ws.close();
    await once(client.ws, "close");
  } finally {
    await bridge.close();
    await mockAi.close();
    key.close();
  }
});

test("browser bridge can run with a non-Incarnate protocol config", async () => {
  const gameConfig = defineBridgeGameConfig({
    gameId: "test-game",
    displayName: "Test Game",
    signingNamespace: "test-game-auth",
    protocol: {
      clientCapabilities: "client_features",
      authBegin: "login_begin",
      authChallenge: "login_challenge",
      authComplete: "login_complete",
      authResult: "login_result",
      authChallengePayloadField: "payload",
      characterList: ["hero_list"],
      characterSelected: "hero_selected",
      characterSelect: "hero_select",
      queryViewport: "viewport_query"
    }
  });
  const key = createTestKey();
  const mockAi = await startCustomProtocolAiServer();
  const bridge = await startBrowserBridgeServer({
    gameConfig,
    aiHost: "127.0.0.1",
    aiPort: mockAi.port,
    wsHost: "127.0.0.1",
    wsPort: 0,
    account: "player",
    keyLabel: "device",
    keyPath: key.path,
    character: "Ada",
    radius: 5,
    sessionToken: TOKEN,
    allowedOrigin: ORIGIN
  });

  try {
    const client = await connectBrowser(bridge.port);
    await waitFor(() => client.packets.some((packet) => packet.type === "session_ready"), "custom protocol session should become ready");

    assert(mockAi.received.some((packet) => packet.type === "client_features"));
    assert(mockAi.received.some((packet) => packet.type === "login_begin" && packet.account === "player"));
    assert(mockAi.received.some((packet) => packet.type === "login_complete" && String(packet.signature).includes("BEGIN SSH SIGNATURE")));
    assert(mockAi.received.some((packet) => packet.type === "hero_select" && packet.character === "Ada"));
    assert(mockAi.received.some((packet) => packet.type === "viewport_query"));

    client.ws.send(JSON.stringify({ type: "new_game_command" }));
    await waitFor(() => mockAi.received.some((packet) => packet.type === "new_game_command"), "custom protocol command should relay");

    client.ws.close();
    await once(client.ws, "close");
  } finally {
    await bridge.close();
    await mockAi.close();
    key.close();
  }
});

test("browser bridge rejects missing command type", async () => {
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
    const before = mockAi.received.length;

    client.ws.send(JSON.stringify({ direction: "east" }));
    await waitForError(client.packets, "invalid_browser_command");
    await delay(50);
    assert.equal(mockAi.received.length, before, "missing command type must not reach the server");

    client.ws.close();
    await once(client.ws, "close");
  } finally {
    await bridge.close();
    await mockAi.close();
    key.close();
  }
});

test("browser bridge rejects empty command type", async () => {
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
    const before = mockAi.received.length;

    client.ws.send(JSON.stringify({ type: "" }));
    client.ws.send(JSON.stringify({ type: "   " }));
    await waitForError(client.packets, "invalid_browser_command");
    await delay(50);
    assert.equal(mockAi.received.length, before, "empty command types must not reach the server");

    client.ws.close();
    await once(client.ws, "close");
  } finally {
    await bridge.close();
    await mockAi.close();
    key.close();
  }
});

test("browser bridge rejects non-string command type", async () => {
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
    const before = mockAi.received.length;

    client.ws.send(JSON.stringify({ type: 42 }));
    await waitForError(client.packets, "invalid_browser_command");
    await delay(50);
    assert.equal(mockAi.received.length, before, "non-string command type must not reach the server");

    client.ws.close();
    await once(client.ws, "close");
  } finally {
    await bridge.close();
    await mockAi.close();
    key.close();
  }
});

test("browser bridge keeps reserved local messages off the AI socket", async () => {
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
    const before = mockAi.received.length;

    client.ws.send(JSON.stringify({ type: "client_debug", source: "test", event: "click" }));
    client.ws.send(JSON.stringify({ type: "bridge_device_key" }));
    await waitFor(() => client.packets.some((packet) => packet.type === "bridge_device_key"), "device key should be answered locally");
    await delay(50);
    assert.equal(mockAi.received.length, before, "reserved local messages must not reach the server");

    client.ws.close();
    await once(client.ws, "close");
  } finally {
    await bridge.close();
    await mockAi.close();
    key.close();
  }
});

test("browser bridge blocks malformed, oversized, and browser-managed account commands", async () => {
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

    for (const command of [
      { type: "auth_key_probe", keyLabel: "device" },
      { type: "auth_begin", account: "matt", keyLabel: "device" },
      { type: "auth_complete", signature: "attacker-controlled" },
      { type: "account_create_begin", account: "evil", keyLabel: "device" },
      { type: "account_create_complete", signature: "attacker-controlled" },
      { type: "account_add_key_begin", keyLabel: "second-device" },
      { type: "account_add_key_complete", signature: "attacker-controlled" }
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
    await waitFor(() => mockAi.received.some((packet) => packet.type === "auth_key_probe"), "accountless session should probe local device key");
    const probe = mockAi.received.find((packet) => packet.type === "auth_key_probe");
    assert.equal(probe?.keyLabel, "device");
    assert.equal(probe?.publicKey, publicKey);
    assert(client.packets.some((packet) => packet.type === "auth_key_probe_result" && packet.status === "unknown"));

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

test("accountless browser bridge signs recognized key probe challenges", async () => {
  const key = createTestKey();
  const mockAi = await startMockAiServer({ recognizeProbe: true });
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
    await waitFor(() => client.packets.some((packet) => packet.type === "character_list"), "recognized probe should authenticate");

    assert(mockAi.received.some((packet) => packet.type === "auth_key_probe"));
    assert(mockAi.received.some((packet) => packet.type === "auth_complete" && String(packet.signature).includes("BEGIN SSH SIGNATURE")));
    assert(client.packets.some((packet) => packet.type === "auth_key_probe_result" && packet.status === "recognized"));

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
  readonly connectionCount: number;
  readonly closedConnectionCount: number;
  close: () => Promise<void>;
}

async function startMockAiServer(options: {
  recognizeProbe?: boolean;
  sendInvalidJsonAfterHello?: boolean;
  sendOversizedLineAfterHello?: boolean;
} = {}): Promise<MockAiServer> {
  const received: Array<Record<string, unknown>> = [];
  const sockets = new Set<net.Socket>();
  let connectionCount = 0;
  let closedConnectionCount = 0;
  const server = net.createServer((socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    send(socket, { schemaVersion: 1, type: "hello" });
    send(socket, { schemaVersion: 1, type: "ping", token: "unit-ping" });
    if (options.sendInvalidJsonAfterHello) {
      setTimeout(() => socket.write("{invalid-json\n"), 20);
    }
    if (options.sendOversizedLineAfterHello) {
      setTimeout(() => socket.write("x".repeat(1024 * 1024 + 1)), 20);
    }
    socket.on("error", () => {
      // Bridge shutdown may reset the loopback test connection while closing the CLI process.
    });
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const packet = JSON.parse(line) as Record<string, unknown>;
          received.push(packet);
          handleAiCommand(socket, packet, options);
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      closedConnectionCount += 1;
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    received,
    get connectionCount() { return connectionCount; },
    get closedConnectionCount() { return closedConnectionCount; },
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

function handleAiCommand(socket: net.Socket, packet: Record<string, unknown>, options: { recognizeProbe?: boolean } = {}) {
  if (packet.type === "auth_key_probe") {
    send(socket, {
      schemaVersion: 1,
      type: "auth_key_probe_result",
      status: options.recognizeProbe ? "recognized" : "unknown",
      account: options.recognizeProbe ? "matt" : "",
      keyLabel: "device",
      fingerprint: String(packet.fingerprint ?? ""),
      message: options.recognizeProbe ? "Signing in." : "This device is not registered yet."
    });
    if (options.recognizeProbe) {
      send(socket, { schemaVersion: 1, type: "auth_challenge", signingPayload: "auth_key_probe:unit-challenge" });
    }
    return;
  }
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

async function startCustomProtocolAiServer(): Promise<MockAiServer> {
  const received: Array<Record<string, unknown>> = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    send(socket, { schemaVersion: 1, type: "hello" });
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const packet = JSON.parse(line) as Record<string, unknown>;
          received.push(packet);
          if (packet.type === "login_begin") {
            send(socket, { schemaVersion: 1, type: "login_challenge", payload: "custom-protocol-challenge" });
          } else if (packet.type === "login_complete") {
            send(socket, { schemaVersion: 1, type: "login_result", ok: true, account: "player" });
            send(socket, { schemaVersion: 1, type: "hero_list", characters: [{ name: "Ada" }] });
          } else if (packet.type === "hero_select") {
            send(socket, { schemaVersion: 1, type: "hero_selected", character: String(packet.character ?? "Ada"), mapName: "Test Map" });
          }
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

function hasReadyBrowserSession(packets: Array<Record<string, unknown>>) {
  return packets.some((packet) => packet.type === "session_ready" || (packet.type === "session_state" && packet.state === "ready"));
}

async function waitForStatusState(port: number, token: string, state: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__incarnate/status`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.ok) {
        const payload = await response.json() as Record<string, unknown>;
        if (payload.state === state) {
          return;
        }
      }
    } catch (_error) {
      // A closing bridge may stop accepting status requests between retries.
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for browser bridge state ${state}.`);
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
