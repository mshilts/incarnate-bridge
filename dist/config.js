import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export const BRIDGE_RESERVED_BROWSER_MESSAGE_TYPES = [
    "client_debug",
    "bridge_device_key"
];
export const DEFAULT_BRIDGE_PROTOCOL_CONFIG = {
    hello: "hello",
    ping: "ping",
    pong: "pong",
    clientCapabilities: "client_capabilities",
    authBegin: "auth_begin",
    authChallenge: "auth_challenge",
    authComplete: "auth_complete",
    authResult: "auth_result",
    authChallengePayloadField: "signingPayload",
    authResultAcceptedFields: ["ok", "accepted"],
    keyProbe: "auth_key_probe",
    keyProbeResult: "auth_key_probe_result",
    keyProbeRecognizedStatus: "recognized",
    keyProbeSetupStatuses: ["unknown", "error", "duplicate"],
    accountCreateBegin: "account_create_begin",
    accountCreateComplete: "account_create_complete",
    accountCreateResult: "account_create_result",
    accountAddKeyBegin: "account_add_key_begin",
    accountAddKeyComplete: "account_add_key_complete",
    accountAddKeyResult: "account_add_key_result",
    accountKeys: "account_keys",
    accountRemoveKey: "account_remove_key",
    accountRemoveKeyResult: "account_remove_key_result",
    characterList: ["character_list", "character_roster"],
    characterBuilderState: "character_builder_state",
    characterSelected: "character_selected",
    characterSelect: "character_select",
    sessionReady: "session_ready",
    queryViewport: "query_viewport",
    status: "status"
};
const DEFAULT_BRIDGE_GAME_CONFIG = {
    gameId: "local-json-game",
    displayName: "Local JSON Game",
    signingNamespace: "local-json-game-auth",
    defaultKeyPath: path.join(os.homedir(), ".ssh", "local_json_game_ed25519"),
    defaultKeyLabel: "local-device",
    defaultAccount: "",
    defaultAiHost: "127.0.0.1",
    defaultAiPort: 8083,
    defaultBrowserBridgeHost: "127.0.0.1",
    defaultBrowserBridgePort: 8787,
    defaultBrowserOriginPort: 4174,
    defaultSshHost: "",
    reservedBrowserMessageTypes: BRIDGE_RESERVED_BROWSER_MESSAGE_TYPES,
    bridgeManagedBrowserCommandTypes: [
        DEFAULT_BRIDGE_PROTOCOL_CONFIG.keyProbe,
        DEFAULT_BRIDGE_PROTOCOL_CONFIG.authBegin,
        DEFAULT_BRIDGE_PROTOCOL_CONFIG.authComplete,
        DEFAULT_BRIDGE_PROTOCOL_CONFIG.accountCreateBegin,
        DEFAULT_BRIDGE_PROTOCOL_CONFIG.accountCreateComplete,
        DEFAULT_BRIDGE_PROTOCOL_CONFIG.accountAddKeyBegin,
        DEFAULT_BRIDGE_PROTOCOL_CONFIG.accountAddKeyComplete
    ],
    protocol: DEFAULT_BRIDGE_PROTOCOL_CONFIG
};
export function defineBridgeGameConfig(input) {
    const protocol = {
        ...DEFAULT_BRIDGE_PROTOCOL_CONFIG,
        ...input.protocol
    };
    return {
        ...DEFAULT_BRIDGE_GAME_CONFIG,
        ...input,
        defaultKeyPath: expandHome(input.defaultKeyPath ?? DEFAULT_BRIDGE_GAME_CONFIG.defaultKeyPath),
        protocol,
        reservedBrowserMessageTypes: input.reservedBrowserMessageTypes ?? DEFAULT_BRIDGE_GAME_CONFIG.reservedBrowserMessageTypes,
        bridgeManagedBrowserCommandTypes: input.bridgeManagedBrowserCommandTypes ?? [
            protocol.keyProbe,
            protocol.authBegin,
            protocol.authComplete,
            protocol.accountCreateBegin,
            protocol.accountCreateComplete,
            protocol.accountAddKeyBegin,
            protocol.accountAddKeyComplete
        ]
    };
}
export function loadBridgeGameConfig(configPath) {
    const resolvedPath = expandHome(configPath);
    const raw = fs.readFileSync(resolvedPath, "utf8");
    const parsed = JSON.parse(raw);
    return defineBridgeGameConfig(parsed);
}
export function expandHome(value) {
    if (value === "~") {
        return os.homedir();
    }
    if (value.startsWith("~/")) {
        return path.join(os.homedir(), value.slice(2));
    }
    return value;
}
