import fs from "node:fs";
import path from "node:path";
import { fingerprintPublicKey, KEY_ONLY_SENTINEL } from "./openssh.js";
export function ensureLocalAccountKey(repoRoot, account, keyLabel, publicKey) {
    validateLocalIdentifier("account", account);
    validateLocalIdentifier("key label", keyLabel);
    if (/[\r\n]/.test(publicKey)) {
        throw new Error("Public key must be a single line.");
    }
    const accountPath = path.join(repoRoot, "java", "lib_server", "accounts", `${account}.act`);
    const fingerprint = fingerprintPublicKey(publicKey);
    const keyLine = `${keyLabel}\ttrue\t${fingerprint}\t${publicKey}\t`;
    fs.mkdirSync(path.dirname(accountPath), { recursive: true });
    if (!fs.existsSync(accountPath)) {
        const lines = [
            "Begin of Account Class {",
            `${account}  /// UserName`,
            `${KEY_ONLY_SENTINEL}  /// PassWord`,
            "none  /// MothersMaiden",
            `${account}@local  /// Email`,
            "0  /// LastLogon in milles",
            "GodMode {",
            "false",
            "} End of GodMode",
            "Aliases {",
            "} End of Aliases",
            "AuthorizedKeys {",
            keyLine,
            "} End of AuthorizedKeys",
            "Begin Character Names {",
            "} End of Character names!",
            "} End of the Account class!"
        ];
        fs.writeFileSync(accountPath, `${lines.join("\n")}\n`, "utf8");
        return;
    }
    const lines = fs.readFileSync(accountPath, "utf8").split(/\r?\n/);
    if (lines.length < 6) {
        throw new Error(`Unexpected account file format: ${accountPath}`);
    }
    if (lines[2]?.includes("/// PassWord")) {
        lines[2] = `${KEY_ONLY_SENTINEL}  /// PassWord`;
    }
    const beginKeys = lines.findIndex((line) => line === "AuthorizedKeys {");
    if (beginKeys >= 0) {
        const endKeys = lines.findIndex((line, index) => index > beginKeys && line === "} End of AuthorizedKeys");
        const bodyStart = beginKeys + 1;
        const bodyEnd = endKeys >= 0 ? endKeys : bodyStart;
        const body = lines.slice(bodyStart, bodyEnd).filter((line) => line.trim().length > 0);
        const filtered = body.filter((line) => line.split("\t", 1)[0] !== keyLabel);
        filtered.push(keyLine);
        lines.splice(bodyStart, bodyEnd - bodyStart, ...filtered);
    }
    else {
        const insertAt = lines.findIndex((line) => line === "Begin Character Names {");
        const block = ["AuthorizedKeys {", keyLine, "} End of AuthorizedKeys"];
        lines.splice(insertAt >= 0 ? insertAt : lines.length - 1, 0, ...block);
    }
    fs.writeFileSync(accountPath, `${lines.filter((line, index, all) => !(index === all.length - 1 && line === "")).join("\n")}\n`, "utf8");
}
function validateLocalIdentifier(label, value) {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(value) || value === "." || value === "..") {
        throw new Error(`Invalid ${label}.`);
    }
}
