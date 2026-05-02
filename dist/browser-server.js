import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import net from "node:net";
import { WebSocketServer } from "ws";
import { BRIDGE_RESERVED_BROWSER_MESSAGE_TYPES } from "./config.js";
import { INCARNATE_GAME_CONFIG } from "./incarnate.js";
import { fingerprintPublicKey, readPublicKey, signPayload } from "./openssh.js";
const BRIDGE_RESERVED_MESSAGES = new Set(BRIDGE_RESERVED_BROWSER_MESSAGE_TYPES);
const MAX_BROWSER_MESSAGE_BYTES = 64 * 1024;
const MAX_WEBSOCKET_FRAME_BYTES = 1024 * 1024;
const MAX_AI_LINE_BYTES = 1024 * 1024;
export async function startBrowserBridgeServer(options) {
    if (!options.sessionToken) {
        throw new Error("Browser bridge session token must not be empty.");
    }
    const httpServer = createServer();
    const wsServer = new WebSocketServer({ server: httpServer, maxPayload: MAX_WEBSOCKET_FRAME_BYTES });
    const gameConfig = options.gameConfig ?? INCARNATE_GAME_CONFIG;
    let session = null;
    wsServer.on("connection", (socket, request) => {
        const token = new URL(request.url ?? "/", `http://${options.wsHost}:${options.wsPort}`).searchParams.get("token") ?? "";
        const origin = String(request.headers.origin ?? "");
        if (!constantTimeEqual(token, options.sessionToken)) {
            socket.close(1008, "Invalid bridge token.");
            return;
        }
        if (options.allowedOrigin && origin && origin !== options.allowedOrigin) {
            socket.close(1008, "Origin not allowed.");
            return;
        }
        if (!session || session.isClosed()) {
            session = new BridgeSession(options, gameConfig, () => {
                session = null;
            });
            session.start();
        }
        session.attachSocket(socket);
    });
    await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(options.wsPort, options.wsHost, () => {
            httpServer.off("error", reject);
            resolve();
        });
    });
    const address = httpServer.address();
    return {
        port: address?.port ?? options.wsPort,
        close: async () => {
            if (session) {
                session.close();
                session = null;
            }
            await Promise.all([
                new Promise((resolve) => wsServer.close(() => resolve())),
                closeHttpServer(httpServer)
            ]);
        }
    };
}
class BridgeSession {
    options;
    gameConfig;
    onClosed;
    socket = null;
    aiSocket = null;
    aiBuffer = "";
    autoSelectPending = false;
    closed = false;
    pendingTellTargets = [];
    sessionId = Math.random().toString(36).slice(2, 8);
    sessionState = "connecting";
    sessionStateMessage = "";
    activeCharacter = "";
    activeMapName = "";
    lastLifecyclePacket = null;
    pendingChallengeKind = "";
    authenticated = false;
    constructor(options, gameConfig, onClosed) {
        this.options = options;
        this.gameConfig = gameConfig;
        this.onClosed = onClosed;
    }
    start() {
        this.autoSelectPending = this.options.character.trim().length > 0;
        this.emitSessionState("connecting", `Connecting to AI socket ${this.options.aiHost}:${this.options.aiPort}.`);
        this.connectAiSocket();
    }
    isClosed() {
        return this.closed;
    }
    attachSocket(socket) {
        if (this.closed) {
            socket.close();
            return;
        }
        if (this.socket && this.socket !== socket) {
            try {
                this.socket.close();
            }
            catch (_error) {
                // Ignore stale socket close failures during browser reload.
            }
        }
        this.socket = socket;
        socket.on("message", (payload) => this.onBrowserMessage(payload));
        socket.on("close", () => this.detachSocket(socket));
        socket.on("error", () => this.detachSocket(socket));
        this.replayBrowserSession();
    }
    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.aiSocket?.destroy();
        this.aiSocket = null;
        if (this.socket && (this.socket.readyState === this.socket.OPEN || this.socket.readyState === this.socket.CONNECTING)) {
            this.socket.close();
        }
        this.socket = null;
        this.onClosed();
    }
    connectAiSocket() {
        const aiSocket = net.createConnection({ host: this.options.aiHost, port: this.options.aiPort }, () => {
            this.aiSocket = aiSocket;
            this.emitSessionState("connected", "Connected to the Incarnate AI socket.");
        });
        aiSocket.setEncoding("utf8");
        aiSocket.on("data", (chunk) => this.onAiData(String(chunk)));
        aiSocket.on("error", (error) => {
            this.emitSessionError("ai_socket_error", String(error));
            this.emitSessionState("error", "AI socket error.");
            this.close();
        });
        aiSocket.on("close", () => {
            if (this.closed) {
                return;
            }
            this.emitSessionState("disconnected", "AI socket closed.");
            this.close();
        });
    }
    onBrowserMessage(payload) {
        const raw = browserPayloadToUtf8(payload);
        if (Buffer.byteLength(raw, "utf8") > MAX_BROWSER_MESSAGE_BYTES) {
            this.emitSessionError("browser_message_too_large", "Browser bridge message exceeded the maximum accepted size.");
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch (_error) {
            this.emitSessionError("invalid_browser_json", "Browser bridge received malformed JSON.");
            return;
        }
        const type = browserCommandType(parsed);
        if (type === "client_debug") {
            this.log(`client_debug ${String(parsed.source ?? "browser")}:${String(parsed.event ?? "event")} ${truncateDebugDetail(parsed.detail)}`);
            return;
        }
        if (type === "bridge_device_key") {
            this.forwardDeviceKey();
            return;
        }
        if (!type) {
            this.emitSessionError("invalid_browser_command", "Browser bridge command type must be a non-empty string.");
            return;
        }
        if (hasControlCharacters(type) || type !== type.trim()) {
            this.emitSessionError("invalid_browser_command", "Browser bridge command type must not contain whitespace or control characters.");
            return;
        }
        if (BRIDGE_RESERVED_MESSAGES.has(type) || this.gameConfig.reservedBrowserMessageTypes.includes(type)) {
            this.emitSessionError("reserved_browser_command", `Command ${type} is reserved by the browser bridge.`);
            return;
        }
        const command = { ...parsed, type };
        if (this.rejectBrowserManagedAccountCommand(command.type)) {
            this.emitSessionError("account_command_forbidden", `Command ${String(command.type)} is not allowed from this browser bridge session.`);
            return;
        }
        if (command.type === "tell_send") {
            this.pendingTellTargets.push({
                target: String(command.target ?? "").trim(),
                text: String(command.text ?? "").trim()
            });
            if (this.pendingTellTargets.length > 20) {
                this.pendingTellTargets = this.pendingTellTargets.slice(this.pendingTellTargets.length - 20);
            }
        }
        this.sendAiCommand(this.prepareBrowserCommand(command));
    }
    onAiData(chunk) {
        this.aiBuffer += chunk;
        if (Buffer.byteLength(this.aiBuffer, "utf8") > MAX_AI_LINE_BYTES) {
            this.emitSessionError("ai_message_too_large", "AI socket sent an oversized JSON line.");
            this.emitSessionState("error", "AI socket protocol error.");
            this.close();
            return;
        }
        let newlineIndex = this.aiBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
            const line = this.aiBuffer.slice(0, newlineIndex).trim();
            this.aiBuffer = this.aiBuffer.slice(newlineIndex + 1);
            if (line.length > 0) {
                try {
                    this.onAiPacket(JSON.parse(line));
                }
                catch (_error) {
                    this.emitSessionError("invalid_ai_json", "AI socket sent malformed JSON.");
                    this.emitSessionState("error", "AI socket protocol error.");
                    this.close();
                    return;
                }
            }
            newlineIndex = this.aiBuffer.indexOf("\n");
        }
    }
    onAiPacket(packet) {
        const type = String(packet.type ?? "");
        const protocol = this.gameConfig.protocol;
        if (type === protocol.ping) {
            this.writeRawAiCommand({
                schemaVersion: 1,
                type: protocol.pong,
                token: String(packet.token ?? "")
            });
            return;
        }
        if (type === "chat" && String(packet.scope ?? "").trim().toLowerCase() === "tell") {
            const from = String(packet.from ?? "").trim();
            const text = String(packet.text ?? "").trim();
            if (normalizeName(from) === normalizeName(this.options.character)) {
                const matchedIndex = this.pendingTellTargets.findIndex((entry) => entry.text === text);
                const matched = matchedIndex >= 0 ? this.pendingTellTargets.splice(matchedIndex, 1)[0] : this.pendingTellTargets.shift();
                if (matched?.target) {
                    packet.to = matched.target;
                }
            }
            else if (!packet.to) {
                packet.to = this.options.character;
            }
        }
        if (type === protocol.hello) {
            this.emitSessionState("connected", `Received ${this.gameConfig.displayName} session hello.`);
            this.writeRawAiCommand({
                schemaVersion: 1,
                type: protocol.clientCapabilities,
                viewportDeltas: true
            });
            this.forwardDeviceKey();
            if (this.options.account.trim().length > 0) {
                this.emitSessionState("authenticating", "Authenticating browser bridge.");
                this.pendingChallengeKind = "auth";
                this.writeRawAiCommand({
                    schemaVersion: 1,
                    type: protocol.authBegin,
                    account: this.options.account,
                    keyLabel: this.options.keyLabel
                });
            }
            else {
                this.forward(packet);
                this.emitSessionState("authenticating", "Checking this device key.");
                this.pendingChallengeKind = "auth";
                this.sendKeyProbe();
            }
            return;
        }
        if (type === protocol.authChallenge) {
            try {
                const signingPayload = String(packet[protocol.authChallengePayloadField] ?? "");
                const signature = signPayload(this.options.keyPath, signingPayload, this.gameConfig.signingNamespace);
                const responseType = this.challengeResponseType();
                this.writeRawAiCommand({
                    schemaVersion: 1,
                    type: responseType,
                    signature
                });
                this.pendingChallengeKind = "";
            }
            catch (error) {
                this.emitSessionError("auth_sign_failed", String(error));
            }
            return;
        }
        if (type === protocol.keyProbeResult) {
            this.forward(packet);
            const status = String(packet.status ?? "");
            if (protocol.keyProbeSetupStatuses.includes(status)) {
                this.pendingChallengeKind = "";
                this.emitSessionState("ready", "Browser bridge ready for account setup.");
            }
            else if (status === protocol.keyProbeRecognizedStatus) {
                this.emitSessionState("authenticating", "Signing in with this device key.");
            }
            return;
        }
        if (type === protocol.authResult) {
            const ok = protocol.authResultAcceptedFields.some((field) => packet[field] === true);
            this.authenticated = ok;
            if (!ok) {
                this.emitSessionError("auth_failed", String(packet.message ?? "Authentication failed."));
            }
            this.forward(packet);
            return;
        }
        if (protocol.characterList.includes(type)) {
            this.lastLifecyclePacket = packet;
            this.forward(packet);
            if (this.autoSelectConfiguredCharacter()) {
                this.selectConfiguredCharacter();
            }
            else {
                this.emitSessionState("ready", "Character roster available.");
            }
            return;
        }
        if (type === protocol.characterBuilderState) {
            this.lastLifecyclePacket = packet;
            this.forward(packet);
            this.emitSessionState("ready", "Character builder available.");
            return;
        }
        if (type === protocol.characterSelected) {
            this.autoSelectPending = false;
            this.activeCharacter = String(packet.character ?? this.options.character);
            this.activeMapName = String(packet.mapName ?? "");
            this.forward(packet);
            const readyPacket = {
                type: protocol.sessionReady,
                character: this.activeCharacter,
                mapName: this.activeMapName
            };
            this.lastLifecyclePacket = readyPacket;
            this.forward(readyPacket);
            this.emitSessionState("ready", "Browser session ready.");
            this.sendAiCommand({ type: protocol.queryViewport });
            return;
        }
        if (type === "action_result") {
            this.log(`forward ${type}: ${String(packet.message ?? "")}`);
        }
        this.forward(packet);
    }
    sendAiCommand(command, injectSchemaVersion = true) {
        const packet = injectSchemaVersion ? { schemaVersion: 1, ...command } : command;
        this.writeRawAiCommand(packet);
    }
    prepareBrowserCommand(command) {
        const protocol = this.gameConfig.protocol;
        if (command.type === protocol.authBegin) {
            this.pendingChallengeKind = "auth";
            const packet = command;
            if (!String(packet.keyLabel ?? "").trim()) {
                packet.keyLabel = this.options.keyLabel;
            }
            return packet;
        }
        if (command.type === protocol.accountCreateBegin) {
            this.pendingChallengeKind = "account_create";
            const packet = command;
            if (!String(packet.publicKey ?? "").trim()) {
                packet.publicKey = readPublicKey(this.options.keyPath);
            }
            if (!String(packet.keyLabel ?? "").trim()) {
                packet.keyLabel = this.options.keyLabel;
            }
            return packet;
        }
        if (command.type === protocol.accountAddKeyBegin) {
            this.pendingChallengeKind = "account_add_key";
            const packet = command;
            if (!String(packet.publicKey ?? "").trim()) {
                packet.publicKey = readPublicKey(this.options.keyPath);
            }
            if (!String(packet.keyLabel ?? "").trim()) {
                packet.keyLabel = this.options.keyLabel;
            }
            return packet;
        }
        return command;
    }
    rejectBrowserManagedAccountCommand(commandType) {
        if (!this.gameConfig.bridgeManagedBrowserCommandTypes.includes(commandType)) {
            return false;
        }
        const protocol = this.gameConfig.protocol;
        if (commandType === protocol.keyProbe ||
            commandType === protocol.authComplete ||
            commandType === protocol.accountCreateComplete ||
            commandType === protocol.accountAddKeyBegin ||
            commandType === protocol.accountAddKeyComplete) {
            return true;
        }
        return this.authenticated || this.options.account.trim().length > 0;
    }
    challengeResponseType() {
        const protocol = this.gameConfig.protocol;
        if (this.pendingChallengeKind === "account_create") {
            return protocol.accountCreateComplete;
        }
        if (this.pendingChallengeKind === "account_add_key") {
            return protocol.accountAddKeyComplete;
        }
        return protocol.authComplete;
    }
    forwardDeviceKey() {
        try {
            const publicKey = readPublicKey(this.options.keyPath);
            this.forward({
                type: "bridge_device_key",
                keyLabel: this.options.keyLabel,
                publicKey,
                fingerprint: fingerprintPublicKey(publicKey)
            });
        }
        catch (error) {
            this.emitSessionError("device_key_failed", String(error));
        }
    }
    sendKeyProbe() {
        try {
            const publicKey = readPublicKey(this.options.keyPath);
            this.writeRawAiCommand({
                schemaVersion: 1,
                type: this.gameConfig.protocol.keyProbe,
                keyLabel: this.options.keyLabel,
                publicKey,
                fingerprint: fingerprintPublicKey(publicKey)
            });
        }
        catch (error) {
            this.emitSessionError("device_key_failed", String(error));
            this.emitSessionState("error", "Unable to read local device key.");
        }
    }
    autoSelectConfiguredCharacter() {
        return this.autoSelectPending && this.options.character.trim().length > 0;
    }
    selectConfiguredCharacter() {
        this.autoSelectPending = false;
        this.writeRawAiCommand({
            schemaVersion: 1,
            type: this.gameConfig.protocol.characterSelect,
            character: this.options.character,
            radius: this.options.radius
        });
    }
    writeRawAiCommand(packet) {
        if (!this.aiSocket || this.aiSocket.destroyed) {
            this.emitSessionError("ai_socket_closed", "AI socket is not connected.");
            return;
        }
        this.aiSocket.write(`${JSON.stringify(packet)}\n`);
    }
    emitSessionError(code, message) {
        this.log(`session_error ${code}: ${message}`);
        this.forward({ type: "session_error", code, message });
    }
    emitSessionState(state, message) {
        this.sessionState = state;
        this.sessionStateMessage = message;
        this.log(`session_state ${state}: ${message}`);
        this.forward({ type: "session_state", state, message });
    }
    forward(packet) {
        if (this.socket && this.socket.readyState === this.socket.OPEN) {
            this.socket.send(JSON.stringify(packet));
        }
    }
    detachSocket(socket) {
        if (this.socket === socket) {
            this.socket = null;
        }
    }
    replayBrowserSession() {
        this.forward({
            type: "session_state",
            state: this.sessionState,
            message: this.sessionStateMessage
        });
        if (this.lastLifecyclePacket) {
            this.forward(this.lastLifecyclePacket);
        }
        if (this.sessionState === "ready" && this.activeCharacter.length > 0) {
            this.sendAiCommand({ type: this.gameConfig.protocol.status });
            this.sendAiCommand({ type: this.gameConfig.protocol.queryViewport });
        }
    }
    log(message) {
        process.stdout.write(`[bridge:${this.sessionId}] ${message}\n`);
    }
}
function normalizeName(value) {
    return String(value ?? "").trim().toLowerCase();
}
function browserCommandType(parsed) {
    return typeof parsed.type === "string" ? parsed.type : "";
}
function hasControlCharacters(value) {
    return /[\u0000-\u001f\u007f]/.test(value);
}
function truncateDebugDetail(detail) {
    const raw = JSON.stringify(detail);
    if (!raw) {
        return "";
    }
    return raw.length > 400 ? `${raw.slice(0, 397)}...` : raw;
}
function browserPayloadToUtf8(payload) {
    if (typeof payload === "string") {
        return payload;
    }
    if (Array.isArray(payload)) {
        return Buffer.concat(payload).toString("utf8");
    }
    if (Buffer.isBuffer(payload)) {
        return payload.toString("utf8");
    }
    return Buffer.from(payload).toString("utf8");
}
function constantTimeEqual(left, right) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }
    return timingSafeEqual(leftBuffer, rightBuffer);
}
async function closeHttpServer(server) {
    await new Promise((resolve) => server.close(() => resolve()));
}
