export type BrowserSessionState = "connecting" | "connected" | "authenticating" | "ready" | "disconnected" | "error";
export declare const BROWSER_COMMAND_TYPE_PATTERN: RegExp;
export declare const BROWSER_RESERVED_COMMAND_TYPES: readonly ["account_add_key_complete", "account_create_complete", "auth_complete", "client_capabilities", "pong"];
export type BrowserAiCommandType = string;
export declare function isBrowserAiCommandType(value: unknown): value is BrowserAiCommandType;
export type BrowserAiCommandContract = {
    schemaVersion?: number;
    type: BrowserAiCommandType;
    [key: string]: unknown;
};
export type BridgeSessionStatePacket = {
    type: "session_state";
    state: BrowserSessionState;
    message: string;
};
export type BridgeSessionErrorPacket = {
    type: "session_error";
    code: string;
    message: string;
};
