export const BROWSER_COMMAND_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const BROWSER_RESERVED_COMMAND_TYPES = [
    "account_add_key_complete",
    "account_create_complete",
    "auth_complete",
    "client_capabilities",
    "pong"
];
export function isBrowserAiCommandType(value) {
    return typeof value === "string" && BROWSER_COMMAND_TYPE_PATTERN.test(value);
}
