import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { WebSocketServer } from "ws";
import { BRIDGE_RESERVED_BROWSER_MESSAGE_TYPES } from "./config.js";
import { INCARNATE_GAME_CONFIG } from "./incarnate.js";
import { fingerprintPublicKey, readPublicKey, signPayload } from "./openssh.js";
const BRIDGE_RESERVED_MESSAGES = new Set(BRIDGE_RESERVED_BROWSER_MESSAGE_TYPES);
const MAX_BROWSER_MESSAGE_BYTES = 64 * 1024;
const MAX_WEBSOCKET_FRAME_BYTES = 1024 * 1024;
const MAX_AI_LINE_BYTES = 1024 * 1024;
const CAPABILITIES_WAIT_MS = 500;
const CAPABILITIES_ACK_WAIT_MS = 5_000;
const STATUS_PATH = "/__incarnate/status";
const DEFAULT_LIFECYCLE_TIMINGS = {
    initialAttachTimeoutMs: 60_000,
    reconnectGraceMs: 5_000,
    browserPingIntervalMs: 10_000,
    browserPongTimeoutMs: 10_000,
    closeTimeoutMs: 500
};
const BRIDGE_VERSION = readBridgeVersion();
export async function startBrowserBridgeServer(options) {
    if (!options.sessionToken) {
        throw new Error("Browser bridge session token must not be empty.");
    }
    const timings = { ...DEFAULT_LIFECYCLE_TIMINGS, ...options.lifecycleTimings };
    validateLifecycleTimings(timings);
    const instanceId = options.instanceId ?? randomUUID();
    const startedAt = new Date().toISOString();
    let session = null;
    let closing = false;
    let initialAttachTimer = null;
    let closePromise = null;
    let resolveClosed;
    const closed = new Promise((resolve) => {
        resolveClosed = resolve;
    });
    let closeServer = async () => { };
    const httpServer = createServer((request, response) => {
        if (request.url?.split("?", 1)[0] !== STATUS_PATH) {
            writeJsonResponse(response, 404, { error: "not_found" });
            return;
        }
        if (request.method !== "GET") {
            response.setHeader("Allow", "GET");
            writeJsonResponse(response, 405, { error: "method_not_allowed" });
            return;
        }
        if (!hasBearerToken(request, options.sessionToken)) {
            writeJsonResponse(response, 401, { error: "unauthorized" });
            return;
        }
        if (!isLoopbackAddress(request.socket.remoteAddress)) {
            writeJsonResponse(response, 403, { error: "loopback_only" });
            return;
        }
        if (closing) {
            writeJsonResponse(response, 410, { error: "bridge_closing" });
            return;
        }
        writeJsonResponse(response, 200, {
            version: BRIDGE_VERSION,
            instanceId,
            host: options.ownerHost || options.aiHost,
            account: session?.getActiveAccount() ?? "",
            ownerAccount: options.ownerAccount ?? options.account.trim(),
            keyLabel: options.keyLabel,
            ownerKeyLabel: options.ownerKeyLabel ?? options.keyLabel,
            keyFingerprint: options.keyFingerprint ?? "",
            character: session?.getActiveCharacter() ?? "",
            state: closing ? "closing" : session?.isBrowserAttached() ? "attached" : session ? "detached" : "waiting",
            sessionState: session?.getRuntimeState() ?? "not_started",
            browserAttached: session?.isBrowserAttached() ?? false,
            startedAt
        });
    });
    const wsServer = new WebSocketServer({ server: httpServer, maxPayload: MAX_WEBSOCKET_FRAME_BYTES });
    const gameConfig = options.gameConfig ?? INCARNATE_GAME_CONFIG;
    wsServer.on("connection", (socket, request) => {
        if (closing) {
            socket.close(1001, "Bridge shutting down.");
            return;
        }
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
        if (initialAttachTimer) {
            clearTimeout(initialAttachTimer);
            initialAttachTimer = null;
        }
        if (!session || session.isClosed()) {
            let createdSession;
            createdSession = new BridgeSession(options, gameConfig, timings, () => {
                if (session === createdSession) {
                    session = null;
                }
                void closeServer();
            });
            session = createdSession;
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
    closeServer = () => {
        if (closePromise) {
            return closePromise;
        }
        closing = true;
        closePromise = (async () => {
            await Promise.resolve();
            if (initialAttachTimer) {
                clearTimeout(initialAttachTimer);
                initialAttachTimer = null;
            }
            const currentSession = session;
            session = null;
            currentSession?.close();
            for (const socket of wsServer.clients) {
                if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
                    socket.close(1001, "Bridge session ended.");
                }
            }
            const forceCloseTimer = setTimeout(() => {
                for (const socket of wsServer.clients) {
                    socket.terminate();
                }
                httpServer.closeAllConnections();
            }, timings.closeTimeoutMs);
            forceCloseTimer.unref();
            try {
                await Promise.all([
                    new Promise((resolve) => wsServer.close(() => resolve())),
                    closeHttpServer(httpServer)
                ]);
            }
            finally {
                clearTimeout(forceCloseTimer);
                resolveClosed();
            }
        })();
        return closePromise;
    };
    initialAttachTimer = setTimeout(() => {
        void closeServer();
    }, timings.initialAttachTimeoutMs);
    return {
        port: address?.port ?? options.wsPort,
        close: closeServer,
        closed
    };
}
class BridgeSession {
    options;
    gameConfig;
    timings;
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
    activeAccount = "";
    activeMapName = "";
    lastLifecyclePacket = null;
    pendingChallengeKind = "";
    authenticated = false;
    socketGeneration = 0;
    detachTimer = null;
    heartbeatTimer = null;
    browserPongTimer = null;
    socketCloseTimer = null;
    pendingBrowserPing = null;
    browserPingSequence = 0;
    aiHelloReceived = false;
    helloPacket = null;
    authenticationStarted = false;
    activationPending = false;
    capabilitiesSent = false;
    acceptedBrowserCapabilities = null;
    attachmentAck = null;
    pendingBrowserCommands = [];
    capabilitiesTimer = null;
    activationTimer = null;
    activationPingToken = "";
    constructor(options, gameConfig, timings, onClosed) {
        this.options = options;
        this.gameConfig = gameConfig;
        this.timings = timings;
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
    getActiveAccount() {
        return this.activeAccount;
    }
    getActiveCharacter() {
        return this.activeCharacter;
    }
    getRuntimeState() {
        return this.closed ? "closed" : this.sessionState;
    }
    isBrowserAttached() {
        return this.socket !== null && this.socket.readyState === this.socket.OPEN;
    }
    attachSocket(socket) {
        if (this.closed) {
            socket.close();
            return;
        }
        if (this.detachTimer) {
            clearTimeout(this.detachTimer);
            this.detachTimer = null;
        }
        this.clearHeartbeatTimer();
        const previousSocket = this.socket;
        const generation = ++this.socketGeneration;
        if (previousSocket && previousSocket !== socket) {
            try {
                previousSocket.close(4001, "Browser session replaced.");
            }
            catch (_error) {
                // Ignore stale socket close failures during browser reload.
            }
        }
        this.socket = socket;
        this.activationPending = true;
        this.capabilitiesSent = false;
        this.acceptedBrowserCapabilities = null;
        this.attachmentAck = null;
        this.pendingBrowserCommands = [];
        this.activationPingToken = "";
        this.clearActivationTimers();
        socket.on("message", (payload) => this.onBrowserMessage(socket, generation, payload));
        socket.on("pong", (payload) => {
            if (this.socket === socket &&
                this.socketGeneration === generation &&
                this.pendingBrowserPing?.equals(payload)) {
                this.clearBrowserPongTimer();
            }
        });
        socket.on("close", () => this.detachSocket(socket, generation));
        socket.on("error", () => this.detachSocket(socket, generation));
        this.startBrowserHeartbeat(socket, generation);
        this.forward({ type: "session_state", state: "connecting", message: "Preparing browser game session." });
        this.capabilitiesTimer = setTimeout(() => {
            if (this.socketGeneration === generation && this.socket === socket
                && !this.capabilitiesSent && this.acceptedBrowserCapabilities === null) {
                this.acceptedBrowserCapabilities = {};
                this.beginAttachmentActivation();
            }
        }, CAPABILITIES_WAIT_MS);
        this.activationTimer = setTimeout(() => {
            if (this.activationPending && this.socketGeneration === generation) {
                this.emitSessionError("browser_activation_timeout", "Game server did not confirm browser activation.");
                this.close();
            }
        }, CAPABILITIES_ACK_WAIT_MS);
    }
    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.clearBrowserTimers();
        this.clearActivationTimers();
        this.aiSocket?.destroy();
        this.aiSocket = null;
        const socket = this.socket;
        this.socket = null;
        this.socketGeneration += 1;
        if (socket && (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING)) {
            socket.close(1000, "Bridge session ended.");
            const closeTimer = setTimeout(() => {
                if (this.socketCloseTimer === closeTimer) {
                    this.socketCloseTimer = null;
                }
                socket.terminate();
            }, this.timings.closeTimeoutMs);
            this.socketCloseTimer = closeTimer;
            socket.once("close", () => {
                if (this.socketCloseTimer === closeTimer) {
                    clearTimeout(closeTimer);
                    this.socketCloseTimer = null;
                }
            });
            closeTimer.unref();
        }
        this.onClosed();
    }
    connectAiSocket() {
        const aiSocket = net.createConnection({ host: this.options.aiHost, port: this.options.aiPort }, () => {
            if (this.closed || this.aiSocket !== aiSocket) {
                aiSocket.destroy();
                return;
            }
            this.emitSessionState("connected", "Connected to the Incarnate AI socket.");
        });
        this.aiSocket = aiSocket;
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
    onBrowserMessage(socket, generation, payload) {
        if (this.closed || this.socket !== socket || this.socketGeneration !== generation) {
            return;
        }
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
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            this.emitSessionError("invalid_browser_json", "Browser bridge requires a JSON command object.");
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
        if (type === this.gameConfig.protocol.clientCapabilities) {
            if (this.activationPending && !this.capabilitiesSent) {
                this.acceptedBrowserCapabilities = parsed;
                if (this.capabilitiesTimer) {
                    clearTimeout(this.capabilitiesTimer);
                    this.capabilitiesTimer = null;
                }
                this.beginAttachmentActivation();
            }
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
        if (type === "bridge_disconnect") {
            this.close();
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
        if (this.activationPending) {
            if (this.pendingBrowserCommands.length >= 32) {
                this.emitSessionError("browser_activation_pending", "Too many commands arrived before browser activation.");
                return;
            }
            this.pendingBrowserCommands.push(command);
            return;
        }
        this.sendAiCommand(this.prepareBrowserCommand(command));
    }
    onAiData(chunk) {
        let split;
        try {
            split = splitBoundedAiLines(this.aiBuffer, chunk);
        }
        catch (_error) {
            this.rejectOversizedAiLine();
            return;
        }
        this.aiBuffer = split.suffix;
        for (const rawLine of split.lines) {
            const line = rawLine.trim();
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
            if (this.closed) {
                return;
            }
        }
    }
    rejectOversizedAiLine() {
        this.emitSessionError("ai_message_too_large", "AI socket sent an oversized JSON line.");
        this.emitSessionState("error", "AI socket protocol error.");
        this.close();
    }
    onAiPacket(packet) {
        const type = String(packet.type ?? "");
        const protocol = this.gameConfig.protocol;
        if (type === "client_capabilities_ack") {
            if (this.activationPending && this.capabilitiesSent
                && packet.attachmentId === String(this.socketGeneration)) {
                this.attachmentAck = packet;
            }
            return;
        }
        if (type === protocol.pong && packet.token === this.activationPingToken) {
            if (this.activationPending && this.capabilitiesSent) {
                this.finishAttachmentActivation();
            }
            return;
        }
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
            this.aiHelloReceived = true;
            this.helloPacket = packet;
            this.emitSessionState("connected", `Received ${this.gameConfig.displayName} session hello.`);
            this.beginAttachmentActivation();
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
            this.lastLifecyclePacket = packet;
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
            this.lastLifecyclePacket = packet;
            const ok = protocol.authResultAcceptedFields.some((field) => packet[field] === true);
            this.authenticated = ok;
            if (ok && typeof packet.account === "string") {
                this.activeAccount = packet.account.trim();
            }
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
                if (!this.activationPending) {
                    this.selectConfiguredCharacter();
                }
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
            if (!this.activationPending) {
                this.sendAiCommand({ type: protocol.queryViewport, complete: true });
            }
            return;
        }
        if (type === "action_result") {
            this.log(`forward ${type}: ${String(packet.message ?? "")}`);
        }
        if (!this.activationPending) {
            this.forward(packet);
        }
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
        if (!this.activationPending || state !== "ready") {
            this.forward({ type: "session_state", state, message });
        }
    }
    forward(packet) {
        if (this.activationPending
            && !["session_state", "session_error", "bridge_device_key"].includes(String(packet.type ?? ""))) {
            return;
        }
        if (this.socket && this.socket.readyState === this.socket.OPEN) {
            this.socket.send(JSON.stringify(packet));
        }
    }
    detachSocket(socket, generation) {
        if (this.socket !== socket || this.socketGeneration !== generation || this.closed) {
            return;
        }
        this.socket = null;
        this.activationPending = true;
        this.capabilitiesSent = false;
        this.acceptedBrowserCapabilities = null;
        this.attachmentAck = null;
        this.pendingBrowserCommands = [];
        this.activationPingToken = "";
        this.clearActivationTimers();
        this.clearHeartbeatTimer();
        const detachedGeneration = ++this.socketGeneration;
        if (this.detachTimer) {
            clearTimeout(this.detachTimer);
        }
        this.detachTimer = setTimeout(() => {
            this.detachTimer = null;
            if (!this.closed && this.socket === null && this.socketGeneration === detachedGeneration) {
                this.close();
            }
        }, this.timings.reconnectGraceMs);
    }
    startBrowserHeartbeat(socket, generation) {
        const sendPing = () => {
            if (this.closed || this.socket !== socket || this.socketGeneration !== generation) {
                return;
            }
            if (socket.readyState !== socket.OPEN) {
                socket.terminate();
                this.detachSocket(socket, generation);
                return;
            }
            if (this.pendingBrowserPing) {
                return;
            }
            const pingPayload = Buffer.from(`${generation}:${++this.browserPingSequence}`);
            this.pendingBrowserPing = pingPayload;
            const pongTimer = setTimeout(() => {
                if (this.socket !== socket ||
                    this.socketGeneration !== generation ||
                    !this.pendingBrowserPing?.equals(pingPayload)) {
                    return;
                }
                this.browserPongTimer = null;
                this.pendingBrowserPing = null;
                socket.terminate();
                this.detachSocket(socket, generation);
            }, this.timings.browserPongTimeoutMs);
            this.browserPongTimer = pongTimer;
            pongTimer.unref();
            try {
                socket.ping(pingPayload, false, (error) => {
                    if (error && this.socket === socket && this.socketGeneration === generation) {
                        this.clearBrowserPongTimer();
                        socket.terminate();
                        this.detachSocket(socket, generation);
                    }
                });
            }
            catch (_error) {
                this.clearBrowserPongTimer();
                socket.terminate();
                this.detachSocket(socket, generation);
            }
        };
        this.heartbeatTimer = setInterval(sendPing, this.timings.browserPingIntervalMs);
        sendPing();
    }
    clearHeartbeatTimer() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.clearBrowserPongTimer();
    }
    clearBrowserPongTimer() {
        if (this.browserPongTimer) {
            clearTimeout(this.browserPongTimer);
            this.browserPongTimer = null;
        }
        this.pendingBrowserPing = null;
    }
    clearBrowserTimers() {
        this.clearHeartbeatTimer();
        if (this.detachTimer) {
            clearTimeout(this.detachTimer);
            this.detachTimer = null;
        }
        if (this.socketCloseTimer) {
            clearTimeout(this.socketCloseTimer);
            this.socketCloseTimer = null;
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
            this.sendAiCommand({ type: this.gameConfig.protocol.queryViewport, complete: true });
        }
    }
    beginAttachmentActivation() {
        if (!this.activationPending || this.capabilitiesSent || !this.aiHelloReceived
            || this.acceptedBrowserCapabilities === null || this.socket === null) {
            return;
        }
        const browserCapabilities = this.acceptedBrowserCapabilities;
        const attachmentId = this.socketGeneration;
        this.capabilitiesSent = true;
        if (this.capabilitiesTimer) {
            clearTimeout(this.capabilitiesTimer);
            this.capabilitiesTimer = null;
        }
        this.activationPingToken = `browser-attachment:${attachmentId}:${randomUUID()}`;
        this.writeRawAiCommand({
            schemaVersion: 1,
            type: this.gameConfig.protocol.clientCapabilities,
            clientKind: "browser",
            attachmentId: String(attachmentId),
            generation: attachmentId,
            viewportDeltas: browserCapabilities.viewportDeltas === true,
            compactMapStaticV1: browserCapabilities.compactMapStaticV1 === true
        });
        this.writeRawAiCommand({
            schemaVersion: 1,
            type: this.gameConfig.protocol.ping,
            token: this.activationPingToken
        });
    }
    finishAttachmentActivation() {
        this.clearActivationTimers();
        this.activationPending = false;
        this.activationPingToken = "";
        if (this.attachmentAck) {
            this.forward(this.attachmentAck);
            this.attachmentAck = null;
        }
        if (this.helloPacket) {
            this.forward(this.helloPacket);
        }
        if (!this.authenticationStarted) {
            this.authenticationStarted = true;
            this.forwardDeviceKey();
            if (this.options.account.trim().length > 0) {
                this.emitSessionState("authenticating", "Authenticating browser bridge.");
                this.pendingChallengeKind = "auth";
                this.writeRawAiCommand({
                    schemaVersion: 1,
                    type: this.gameConfig.protocol.authBegin,
                    account: this.options.account,
                    keyLabel: this.options.keyLabel
                });
            }
            else {
                this.emitSessionState("authenticating", "Checking this device key.");
                this.pendingChallengeKind = "auth";
                this.sendKeyProbe();
            }
        }
        else {
            this.replayBrowserSession();
        }
        if (this.autoSelectConfiguredCharacter()
            && this.lastLifecyclePacket
            && this.gameConfig.protocol.characterList.includes(String(this.lastLifecyclePacket.type ?? ""))
            && !this.pendingBrowserCommands.some((command) => command.type === this.gameConfig.protocol.characterSelect)) {
            this.selectConfiguredCharacter();
        }
        const pending = this.pendingBrowserCommands;
        this.pendingBrowserCommands = [];
        for (const command of pending) {
            this.sendAiCommand(this.prepareBrowserCommand(command));
        }
    }
    clearActivationTimers() {
        if (this.capabilitiesTimer) {
            clearTimeout(this.capabilitiesTimer);
            this.capabilitiesTimer = null;
        }
        if (this.activationTimer) {
            clearTimeout(this.activationTimer);
            this.activationTimer = null;
        }
    }
    log(message) {
        process.stdout.write(`[bridge:${this.sessionId}] ${message}\n`);
    }
}
export function splitBoundedAiLines(buffer, chunk, maxLineBytes = MAX_AI_LINE_BYTES) {
    const combined = buffer + chunk;
    const lines = [];
    let start = 0;
    let newline = combined.indexOf("\n", start);
    while (newline >= 0) {
        const line = combined.slice(start, newline);
        if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
            throw new RangeError("AI line exceeds the accepted byte limit.");
        }
        lines.push(line);
        start = newline + 1;
        newline = combined.indexOf("\n", start);
    }
    const suffix = combined.slice(start);
    if (Buffer.byteLength(suffix, "utf8") > maxLineBytes) {
        throw new RangeError("Unfinished AI line exceeds the accepted byte limit.");
    }
    return { lines, suffix };
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
function validateLifecycleTimings(timings) {
    const positive = [
        timings.initialAttachTimeoutMs,
        timings.browserPingIntervalMs,
        timings.browserPongTimeoutMs,
        timings.closeTimeoutMs
    ];
    if (positive.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
        throw new Error("Browser bridge lifecycle timeouts must be positive integer milliseconds.");
    }
    if (!Number.isSafeInteger(timings.reconnectGraceMs) || timings.reconnectGraceMs < 0) {
        throw new Error("Browser bridge reconnect grace must be a non-negative integer number of milliseconds.");
    }
}
function hasBearerToken(request, expectedToken) {
    const authorization = request.headers.authorization ?? "";
    return authorization.startsWith("Bearer ")
        && constantTimeEqual(authorization.slice("Bearer ".length), expectedToken);
}
function isLoopbackAddress(address) {
    const normalized = address?.toLowerCase().replace(/^::ffff:/, "");
    return normalized === "::1" || normalized?.startsWith("127.") === true;
}
function writeJsonResponse(response, status, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(body),
        "Content-Type": "application/json; charset=utf-8"
    });
    response.end(body);
}
function readBridgeVersion() {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof packageJson.version === "string" ? packageJson.version : "unknown";
}
async function closeHttpServer(server) {
    await new Promise((resolve) => server.close(() => resolve()));
}
