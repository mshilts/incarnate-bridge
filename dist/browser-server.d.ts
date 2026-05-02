import { type BridgeGameConfig } from "./config.js";
export interface BrowserBridgeOptions {
    gameConfig?: BridgeGameConfig;
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
export declare function startBrowserBridgeServer(options: BrowserBridgeOptions): Promise<BrowserBridgeServer>;
