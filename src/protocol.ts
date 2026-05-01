export type BrowserSessionState =
  | "connecting"
  | "connected"
  | "authenticating"
  | "ready"
  | "disconnected"
  | "error";

export const BROWSER_COMMAND_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const BROWSER_RESERVED_COMMAND_TYPES = [
  "account_add_key_complete",
  "account_create_complete",
  "auth_complete",
  "client_capabilities",
  "pong"
] as const;

export type BrowserAiCommandType = string;

export function isBrowserAiCommandType(value: unknown): value is BrowserAiCommandType {
  return typeof value === "string" && BROWSER_COMMAND_TYPE_PATTERN.test(value);
}

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
