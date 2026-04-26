import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { WebSocket } from "ws";
import { startBrowserBridgeServer } from "./browser-server.js";
const TOKEN = "bridge-security-token";
const ORIGIN = "http://127.0.0.1:4173";
async function main() {
    const tempDir = mkdtempSync(join(tmpdir(), "incarnate-bridge-security-"));
    const keyPath = join(tempDir, "id_ed25519");
    const keygen = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "incarnate-bridge-security", "-f", keyPath], {
        stdio: "inherit"
    });
    assert.equal(keygen.status, 0, "ssh-keygen should create a bridge test key");
    const mockAi = await startMockAiServer();
    const bridge = await startBrowserBridgeServer({
        aiHost: "127.0.0.1",
        aiPort: mockAi.port,
        wsHost: "127.0.0.1",
        wsPort: 0,
        account: "matt",
        keyLabel: "security-regression",
        keyPath,
        character: "Matthew_mage",
        radius: 6,
        sessionToken: TOKEN,
        allowedOrigin: ORIGIN
    });
    try {
        await verifyRejectedConnection(bridge.port, "wrong-token", ORIGIN, "bad token");
        await verifyRejectedConnection(bridge.port, TOKEN, "http://evil.example", "bad origin");
        await verifyAuthenticatedBridgeControls(bridge.port, mockAi);
    }
    finally {
        await bridge.close();
        await mockAi.close();
        rmSync(tempDir, { recursive: true, force: true });
    }
    process.stdout.write("Browser bridge security regression passed\n");
}
async function verifyRejectedConnection(port, token, origin, label) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}`, {
        headers: { Origin: origin }
    });
    const [code] = await once(ws, "close");
    assert.equal(code, 1008, `${label} connection should be policy-rejected`);
}
async function verifyAuthenticatedBridgeControls(port, mockAi) {
    const packets = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(TOKEN)}`, {
        headers: { Origin: ORIGIN }
    });
    ws.on("message", (data) => packets.push(JSON.parse(String(data))));
    await once(ws, "open");
    await waitFor(() => packets.some((packet) => packet.type === "session_ready"), "expected session_ready");
    await waitFor(() => mockAi.received.some((packet) => packet.type === "query_viewport"), "expected initial viewport query");
    assert(mockAi.received.some((packet) => packet.type === "auth_begin"), "bridge should perform configured auth");
    assert(mockAi.received.some((packet) => packet.type === "auth_complete"), "bridge should sign configured auth challenge");
    ws.send("{malformed");
    await waitFor(() => packets.some((packet) => packet.type === "session_error" && packet.code === "invalid_browser_json"), "malformed browser JSON should be rejected without killing the session");
    ws.send("x".repeat(70_000));
    await waitFor(() => packets.some((packet) => packet.type === "session_error" && packet.code === "browser_message_too_large"), "oversized browser message should be rejected without killing the session");
    ws.send(JSON.stringify({ type: "move", direction: "east", count: 1 }));
    await waitFor(() => mockAi.received.some((packet) => packet.type === "move"), "valid command should still relay after rejected frames");
    ws.send(JSON.stringify({ type: "guild_command", action: "god_observe", target: "CLK" }));
    await waitFor(() => mockAi.received.some((packet) => packet.type === "guild_command"), "guild commands should relay to server authorization");
    await assertBlockedFromAi(ws, packets, mockAi, { type: "auth_begin", account: "matt", keyLabel: "security-regression" });
    await assertBlockedFromAi(ws, packets, mockAi, { type: "auth_key_probe", keyLabel: "security-regression" });
    await assertBlockedFromAi(ws, packets, mockAi, { type: "account_create_begin", account: "evil", keyLabel: "security-regression" });
    await assertBlockedFromAi(ws, packets, mockAi, { type: "account_add_key_begin", keyLabel: "evil-device" });
    for (const command of [
        { type: "credits" },
        { type: "buy_credits", credits: 100 },
        { type: "paid_shop" },
        { type: "paid_buy", sku: "pantry_loaf" },
        { type: "paid_unlock", sku: "account_level_10" },
        { type: "payments_command", action: "status" }
    ]) {
        ws.send(JSON.stringify(command));
        await waitFor(() => mockAi.received.some((packet) => packet.type === command.type), `expected ${command.type} to relay to server authorization`);
    }
    ws.close();
    await once(ws, "close");
}
async function assertBlockedFromAi(ws, packets, mockAi, command) {
    const before = mockAi.received.length;
    const errorCountBefore = packets.filter((packet) => packet.type === "session_error" && packet.code === "account_command_forbidden").length;
    ws.send(JSON.stringify(command));
    await waitFor(() => packets.filter((packet) => packet.type === "session_error" && packet.code === "account_command_forbidden").length > errorCountBefore, `${command.type} should be rejected by the bridge`);
    await delay(40);
    const leaked = mockAi.received.slice(before).filter((packet) => packet.type === command.type);
    assert.equal(leaked.length, 0, `${command.type} should not reach the AI socket from an authenticated browser`);
}
async function startMockAiServer() {
    const received = [];
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.setEncoding("utf8");
        let buffer = "";
        socket.write(JSON.stringify({ schemaVersion: 1, type: "hello" }) + "\n");
        socket.on("data", (chunk) => {
            buffer += String(chunk);
            let newline = buffer.indexOf("\n");
            while (newline >= 0) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (line.length > 0) {
                    const packet = JSON.parse(line);
                    received.push(packet);
                    handleAiCommand(socket, packet);
                }
                newline = buffer.indexOf("\n");
            }
        });
        socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    return {
        port: address.port,
        received,
        close: async () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise((resolve) => server.close(() => resolve()));
        }
    };
}
function handleAiCommand(socket, packet) {
    if (packet.type === "auth_begin") {
        send(socket, { schemaVersion: 1, type: "auth_challenge", signingPayload: "security-regression-challenge" });
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
function send(socket, packet) {
    socket.write(JSON.stringify(packet) + "\n");
}
async function waitFor(predicate, message) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
        if (predicate()) {
            return;
        }
        await delay(20);
    }
    throw new Error(message);
}
async function delay(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
