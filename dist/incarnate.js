import os from "node:os";
import path from "node:path";
import { defineBridgeGameConfig } from "./config.js";
export const INCARNATE_GAME_CONFIG = defineBridgeGameConfig({
    gameId: "inc-realm",
    displayName: "Incarnate",
    signingNamespace: "incarnate-auth",
    defaultKeyPath: path.join(os.homedir(), ".ssh", "incarnate_ed25519"),
    defaultKeyLabel: "local-dev",
    defaultAccount: "matt",
    defaultAiHost: "127.0.0.1",
    defaultAiPort: 8083,
    defaultBrowserBridgeHost: "127.0.0.1",
    defaultBrowserBridgePort: 8787,
    defaultBrowserOriginPort: 4174,
    defaultSshHost: "game.inc-realm.com"
});
