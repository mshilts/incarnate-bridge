export declare const SSH_SIGNING_NAMESPACE = "incarnate-auth";
export declare const KEY_ONLY_SENTINEL = "KEY_ONLY";
export declare function defaultKeyPath(): string;
export declare function ensureKeyPair(keyPath: string, comment?: string): void;
export declare function readPublicKey(keyPath: string): string;
export declare function fingerprintPublicKey(publicKey: string): string;
export declare function signPayload(keyPath: string, payload: string): string;
export declare function trustHost(sshHost: string): Promise<void>;
export declare function openSshTunnel(sshHost: string, remotePort: number): Promise<{
    host: string;
    port: number;
    close: () => void;
}>;
