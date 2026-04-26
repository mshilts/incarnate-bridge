import { createServer, type Server as HttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { BROWSER_AI_COMMAND_TYPES, type BrowserAiCommandContract, type BrowserSessionState } from "./protocol.js";
import { fingerprintPublicKey, readPublicKey, signPayload } from "./openssh.js";

export interface BrowserBridgeOptions {
  aiHost: string;
  aiPort: number;
  wsHost: string;
  wsPort: number;
  account: string;
  keyLabel: string;
  keyPath: string;
  character: string;
  radius: number;
  sessionToken: string;
  allowedOrigin: string;
}

export interface BrowserBridgeServer {
  close: () => Promise<void>;
  port: number;
}

const ALLOWED_COMMANDS = new Set<string>(BROWSER_AI_COMMAND_TYPES);

const BROWSER_MANAGED_ACCOUNT_COMMANDS = new Set([
  "auth_key_probe",
  "auth_begin",
  "account_create_begin",
  "account_add_key_begin"
]);

const MAX_BROWSER_MESSAGE_BYTES = 64 * 1024;
const MAX_WEBSOCKET_FRAME_BYTES = 1024 * 1024;
const MAX_AI_LINE_BYTES = 1024 * 1024;

export async function startBrowserBridgeServer(options: BrowserBridgeOptions): Promise<BrowserBridgeServer> {
  if (!options.sessionToken) {
    throw new Error("Browser bridge session token must not be empty.");
  }
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ server: httpServer, maxPayload: MAX_WEBSOCKET_FRAME_BYTES });
  let session: BridgeSession | null = null;

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
      session = new BridgeSession(options, () => {
        session = null;
      });
      session.start();
    }
    session.attachSocket(socket);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.wsPort, options.wsHost, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address() as AddressInfo | null;
  return {
    port: address?.port ?? options.wsPort,
    close: async () => {
      if (session) {
        session.close();
        session = null;
      }
      await Promise.all([
        new Promise<void>((resolve) => wsServer.close(() => resolve())),
        closeHttpServer(httpServer)
      ]);
    }
  };
}

class BridgeSession {
  private socket: WebSocket | null = null;
  private aiSocket: net.Socket | null = null;
  private aiBuffer = "";
  private autoSelectPending = false;
  private closed = false;
  private pendingTellTargets: Array<{ target: string; text: string }> = [];
  private readonly sessionId = Math.random().toString(36).slice(2, 8);
  private sessionState: BrowserSessionState = "connecting";
  private sessionStateMessage = "";
  private activeCharacter = "";
  private activeMapName = "";
  private lastLifecyclePacket: Record<string, unknown> | null = null;
  private pendingChallengeKind: "auth" | "account_create" | "account_add_key" | "" = "";
  private authenticated = false;

  constructor(
    private readonly options: BrowserBridgeOptions,
    private readonly onClosed: () => void
  ) {}

  start() {
    this.autoSelectPending = this.options.character.trim().length > 0;
    this.emitSessionState("connecting", `Connecting to AI socket ${this.options.aiHost}:${this.options.aiPort}.`);
    this.connectAiSocket();
  }

  isClosed() {
    return this.closed;
  }

  attachSocket(socket: WebSocket) {
    if (this.closed) {
      socket.close();
      return;
    }
    if (this.socket && this.socket !== socket) {
      try {
        this.socket.close();
      } catch (_error) {
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

  private connectAiSocket() {
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

  private onBrowserMessage(payload: Buffer | ArrayBuffer | Buffer[]) {
    const raw = browserPayloadToUtf8(payload);
    if (Buffer.byteLength(raw, "utf8") > MAX_BROWSER_MESSAGE_BYTES) {
      this.emitSessionError("browser_message_too_large", "Browser bridge message exceeded the maximum accepted size.");
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch (_error) {
      this.emitSessionError("invalid_browser_json", "Browser bridge received malformed JSON.");
      return;
    }
    if (parsed.type === "client_debug") {
      this.log(`client_debug ${String(parsed.source ?? "browser")}:${String(parsed.event ?? "event")} ${truncateDebugDetail(parsed.detail)}`);
      return;
    }
    if (parsed.type === "bridge_device_key") {
      this.forwardDeviceKey();
      return;
    }
    const command = parsed as unknown as BrowserAiCommandContract;
    if (!ALLOWED_COMMANDS.has(command.type)) {
      this.emitSessionError("unsupported_command", `Command ${String(command.type)} is not allowed by the browser bridge.`);
      return;
    }
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

  private onAiData(chunk: string) {
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
          this.onAiPacket(JSON.parse(line) as Record<string, unknown>);
        } catch (_error) {
          this.emitSessionError("invalid_ai_json", "AI socket sent malformed JSON.");
          this.emitSessionState("error", "AI socket protocol error.");
          this.close();
          return;
        }
      }
      newlineIndex = this.aiBuffer.indexOf("\n");
    }
  }

  private onAiPacket(packet: Record<string, unknown>) {
    const type = String(packet.type ?? "");
    if (type === "ping") {
      this.writeRawAiCommand({
        schemaVersion: 1,
        type: "pong",
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
      } else if (!packet.to) {
        packet.to = this.options.character;
      }
    }
    if (type === "hello") {
      this.emitSessionState("connected", "Received Incarnate session hello.");
      this.writeRawAiCommand({
        schemaVersion: 1,
        type: "client_capabilities",
        viewportDeltas: true
      });
      this.forwardDeviceKey();
      if (this.options.account.trim().length > 0) {
        this.emitSessionState("authenticating", "Authenticating browser bridge.");
        this.pendingChallengeKind = "auth";
        this.writeRawAiCommand({
          schemaVersion: 1,
          type: "auth_begin",
          account: this.options.account,
          keyLabel: this.options.keyLabel
        });
      } else {
        this.forward(packet);
        this.emitSessionState("authenticating", "Checking this device key.");
        this.pendingChallengeKind = "auth";
        this.sendKeyProbe();
      }
      return;
    }
    if (type === "auth_challenge") {
      try {
        const signature = signPayload(this.options.keyPath, String(packet.signingPayload ?? ""));
        const responseType = this.challengeResponseType();
        this.writeRawAiCommand({
          schemaVersion: 1,
          type: responseType,
          signature
        });
        this.pendingChallengeKind = "";
      } catch (error) {
        this.emitSessionError("auth_sign_failed", String(error));
      }
      return;
    }
    if (type === "auth_key_probe_result") {
      this.forward(packet);
      const status = String(packet.status ?? "");
      if (status === "unknown" || status === "error" || status === "duplicate") {
        this.pendingChallengeKind = "";
        this.emitSessionState("ready", "Browser bridge ready for account setup.");
      } else if (status === "recognized") {
        this.emitSessionState("authenticating", "Signing in with this device key.");
      }
      return;
    }
    if (type === "auth_result") {
      const ok = packet.ok === true || packet.accepted === true;
      this.authenticated = ok;
      if (!ok) {
        this.emitSessionError("auth_failed", String(packet.message ?? "Authentication failed."));
      }
      this.forward(packet);
      return;
    }
    if (type === "character_list") {
      this.lastLifecyclePacket = packet;
      this.forward(packet);
      if (this.autoSelectConfiguredCharacter()) {
        this.selectConfiguredCharacter();
      } else {
        this.emitSessionState("ready", "Character roster available.");
      }
      return;
    }
    if (type === "character_roster") {
      this.lastLifecyclePacket = packet;
      this.forward(packet);
      if (this.autoSelectConfiguredCharacter()) {
        this.selectConfiguredCharacter();
      } else {
        this.emitSessionState("ready", "Character roster available.");
      }
      return;
    }
    if (type === "character_builder_state") {
      this.lastLifecyclePacket = packet;
      this.forward(packet);
      this.emitSessionState("ready", "Character builder available.");
      return;
    }
    if (type === "character_selected") {
      this.autoSelectPending = false;
      this.activeCharacter = String(packet.character ?? this.options.character);
      this.activeMapName = String(packet.mapName ?? "");
      this.forward(packet);
      const readyPacket = {
        type: "session_ready",
        character: this.activeCharacter,
        mapName: this.activeMapName
      };
      this.lastLifecyclePacket = readyPacket;
      this.forward(readyPacket);
      this.emitSessionState("ready", "Browser session ready.");
      this.sendAiCommand({ type: "query_viewport" });
      return;
    }
    if (type === "action_result") {
      this.log(`forward ${type}: ${String(packet.message ?? "")}`);
    }
    this.forward(packet);
  }

  private sendAiCommand(command: BrowserAiCommandContract, injectSchemaVersion = true) {
    const packet = injectSchemaVersion ? { schemaVersion: 1, ...command } : command;
    this.writeRawAiCommand(packet);
  }

  private prepareBrowserCommand(command: BrowserAiCommandContract): BrowserAiCommandContract {
    if (command.type === "auth_begin") {
      this.pendingChallengeKind = "auth";
      const packet = command as BrowserAiCommandContract & { keyLabel?: string };
      if (!String(packet.keyLabel ?? "").trim()) {
        packet.keyLabel = this.options.keyLabel;
      }
      return packet;
    }
    if (command.type === "account_create_begin") {
      this.pendingChallengeKind = "account_create";
      const packet = command as BrowserAiCommandContract & { publicKey?: string; keyLabel?: string };
      if (!String(packet.publicKey ?? "").trim()) {
        packet.publicKey = readPublicKey(this.options.keyPath);
      }
      if (!String(packet.keyLabel ?? "").trim()) {
        packet.keyLabel = this.options.keyLabel;
      }
      return packet;
    }
    if (command.type === "account_add_key_begin") {
      this.pendingChallengeKind = "account_add_key";
      const packet = command as BrowserAiCommandContract & { publicKey?: string; keyLabel?: string };
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

  private rejectBrowserManagedAccountCommand(commandType: string) {
    if (!BROWSER_MANAGED_ACCOUNT_COMMANDS.has(commandType)) {
      return false;
    }
    if (commandType === "auth_key_probe" || commandType === "account_add_key_begin") {
      return true;
    }
    return this.authenticated || this.options.account.trim().length > 0;
  }

  private challengeResponseType() {
    if (this.pendingChallengeKind === "account_create") {
      return "account_create_complete";
    }
    if (this.pendingChallengeKind === "account_add_key") {
      return "account_add_key_complete";
    }
    return "auth_complete";
  }

  private forwardDeviceKey() {
    try {
      const publicKey = readPublicKey(this.options.keyPath);
      this.forward({
        type: "bridge_device_key",
        keyLabel: this.options.keyLabel,
        publicKey,
        fingerprint: fingerprintPublicKey(publicKey)
      });
    } catch (error) {
      this.emitSessionError("device_key_failed", String(error));
    }
  }

  private sendKeyProbe() {
    try {
      const publicKey = readPublicKey(this.options.keyPath);
      this.writeRawAiCommand({
        schemaVersion: 1,
        type: "auth_key_probe",
        keyLabel: this.options.keyLabel,
        publicKey,
        fingerprint: fingerprintPublicKey(publicKey)
      });
    } catch (error) {
      this.emitSessionError("device_key_failed", String(error));
      this.emitSessionState("error", "Unable to read local device key.");
    }
  }

  private autoSelectConfiguredCharacter() {
    return this.autoSelectPending && this.options.character.trim().length > 0;
  }

  private selectConfiguredCharacter() {
    this.autoSelectPending = false;
    this.writeRawAiCommand({
      schemaVersion: 1,
      type: "character_select",
      character: this.options.character,
      radius: this.options.radius
    });
  }

  private writeRawAiCommand(packet: object) {
    if (!this.aiSocket || this.aiSocket.destroyed) {
      this.emitSessionError("ai_socket_closed", "AI socket is not connected.");
      return;
    }
    this.aiSocket.write(`${JSON.stringify(packet)}\n`);
  }

  private emitSessionError(code: string, message: string) {
    this.log(`session_error ${code}: ${message}`);
    this.forward({ type: "session_error", code, message });
  }

  private emitSessionState(state: BrowserSessionState, message: string) {
    this.sessionState = state;
    this.sessionStateMessage = message;
    this.log(`session_state ${state}: ${message}`);
    this.forward({ type: "session_state", state, message });
  }

  private forward(packet: Record<string, unknown>) {
    if (this.socket && this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify(packet));
    }
  }

  private detachSocket(socket: WebSocket) {
    if (this.socket === socket) {
      this.socket = null;
    }
  }

  private replayBrowserSession() {
    this.forward({
      type: "session_state",
      state: this.sessionState,
      message: this.sessionStateMessage
    });
    if (this.lastLifecyclePacket) {
      this.forward(this.lastLifecyclePacket);
    }
    if (this.sessionState === "ready" && this.activeCharacter.length > 0) {
      this.sendAiCommand({ type: "status" });
      this.sendAiCommand({ type: "query_viewport" });
    }
  }

  private log(message: string) {
    process.stdout.write(`[bridge:${this.sessionId}] ${message}\n`);
  }
}

function normalizeName(value: string) {
  return String(value ?? "").trim().toLowerCase();
}

function truncateDebugDetail(detail: unknown) {
  const raw = JSON.stringify(detail);
  if (!raw) {
    return "";
  }
  return raw.length > 400 ? `${raw.slice(0, 397)}...` : raw;
}

function browserPayloadToUtf8(payload: Buffer | ArrayBuffer | Buffer[]) {
  if (typeof payload === "string") {
    return payload;
  }
  if (Array.isArray(payload)) {
    return Buffer.concat(payload).toString("utf8");
  }
  if (Buffer.isBuffer(payload)) {
    return payload.toString("utf8");
  }
  return Buffer.from(payload as ArrayBuffer).toString("utf8");
}

function constantTimeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

async function closeHttpServer(server: HttpServer) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
