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
    instanceId?: string;
    ownerHost?: string;
    ownerAccount?: string;
    ownerKeyLabel?: string;
    keyFingerprint?: string;
    lifecycleTimings?: Partial<BrowserBridgeLifecycleTimings>;
}
export interface BrowserBridgeLifecycleTimings {
    initialAttachTimeoutMs: number;
    reconnectGraceMs: number;
    browserPingIntervalMs: number;
    browserPongTimeoutMs: number;
    closeTimeoutMs: number;
}
export interface BrowserBridgeServer {
    close: () => Promise<void>;
    closed: Promise<void>;
    port: number;
}
export declare function startBrowserBridgeServer(options: BrowserBridgeOptions): Promise<BrowserBridgeServer>;
export declare function splitBoundedAiLines(buffer: string, chunk: string, maxLineBytes?: number): {
    lines: string[];
    suffix: string;
};
