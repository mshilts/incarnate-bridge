import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureKeyPair, fingerprintPublicKey, openSshTunnel, signPayload, SSH_SIGNING_NAMESPACE, trustHost } from "../src/openssh.js";

test("ensureKeyPair creates an ed25519 key pair and leaves existing keys intact", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "incarnate-openssh-"));
  const keyPath = join(tempDir, "id_ed25519");
  try {
    ensureKeyPair(keyPath, "incarnate-test");
    assert.equal(existsSync(keyPath), true, "private key should exist");
    assert.equal(existsSync(`${keyPath}.pub`), true, "public key should exist");
    assert.match(readFileSync(`${keyPath}.pub`, "utf8"), /^ssh-ed25519 /);

    const firstMtime = statSync(keyPath).mtimeMs;
    ensureKeyPair(keyPath, "different-comment");
    assert.equal(statSync(keyPath).mtimeMs, firstMtime, "existing key should not be regenerated");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("fingerprintPublicKey returns an OpenSSH SHA256 fingerprint", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "incarnate-fingerprint-test-"));
  const keyPath = join(tempDir, "id_ed25519");
  try {
    ensureKeyPair(keyPath, "incarnate-fingerprint-test");
    const publicKey = readFileSync(`${keyPath}.pub`, "utf8").trim();
    assert.match(fingerprintPublicKey(publicKey), /^SHA256:[A-Za-z0-9+/]+$/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("signPayload creates a verifiable SSH signature in the Incarnate namespace", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "incarnate-sign-test-"));
  const keyPath = join(tempDir, "id_ed25519");
  const allowedSignersPath = join(tempDir, "allowed_signers");
  const payloadPath = join(tempDir, "payload.txt");
  const signaturePath = `${payloadPath}.sig`;
  try {
    ensureKeyPair(keyPath, "incarnate-sign-test");
    const publicKey = readFileSync(`${keyPath}.pub`, "utf8").trim();
    const payload = "challenge:unit-test";
    const signature = signPayload(keyPath, payload);
    assert.match(signature, /BEGIN SSH SIGNATURE/);

    writeFileSync(allowedSignersPath, `tester ${publicKey}\n`, "utf8");
    writeFileSync(payloadPath, payload, "utf8");
    writeFileSync(signaturePath, signature, "utf8");

    const verify = spawnSync("ssh-keygen", [
      "-Y",
      "verify",
      "-f",
      allowedSignersPath,
      "-I",
      "tester",
      "-n",
      SSH_SIGNING_NAMESPACE,
      "-s",
      signaturePath
    ], {
      input: payload,
      encoding: "utf8"
    });
    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("signPayload supports a custom game signing namespace", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "incarnate-sign-namespace-test-"));
  const keyPath = join(tempDir, "id_ed25519");
  const allowedSignersPath = join(tempDir, "allowed_signers");
  const payloadPath = join(tempDir, "payload.txt");
  const signaturePath = `${payloadPath}.sig`;
  const namespace = "example-game-auth";
  try {
    ensureKeyPair(keyPath, "incarnate-sign-namespace-test");
    const publicKey = readFileSync(`${keyPath}.pub`, "utf8").trim();
    const payload = "challenge:custom-namespace";
    const signature = signPayload(keyPath, payload, namespace);

    writeFileSync(allowedSignersPath, `tester ${publicKey}\n`, "utf8");
    writeFileSync(payloadPath, payload, "utf8");
    writeFileSync(signaturePath, signature, "utf8");

    const verify = spawnSync("ssh-keygen", [
      "-Y",
      "verify",
      "-f",
      allowedSignersPath,
      "-I",
      "tester",
      "-n",
      namespace,
      "-s",
      signaturePath
    ], {
      input: payload,
      encoding: "utf8"
    });
    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("SSH helpers reject option-like hosts and invalid ports before spawning ssh", async () => {
  await assert.rejects(() => trustHost("-oProxyCommand=sh"), /Invalid SSH host alias/);
  await assert.rejects(() => openSshTunnel("game.inc-realm.com", 0), /Invalid remote port/);
  await assert.rejects(() => openSshTunnel("bad host", 8083), /Invalid SSH host alias/);
});
