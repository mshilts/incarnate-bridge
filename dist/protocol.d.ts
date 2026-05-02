export { BRIDGE_RESERVED_BROWSER_MESSAGE_TYPES } from "./config.js";
export type BrowserSessionState = "connecting" | "connected" | "authenticating" | "ready" | "disconnected" | "error";
export type BrowserAiCommandType = string;
export type BrowserAiCommandContract = {
    schemaVersion?: number;
    type: string;
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
