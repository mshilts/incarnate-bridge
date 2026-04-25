import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureLocalAccountKey } from "../src/local-bootstrap.js";
import { ensureKeyPair, KEY_ONLY_SENTINEL } from "../src/openssh.js";

test("ensureLocalAccountKey creates a local account file with key-only auth", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "incarnate-local-bootstrap-"));
  const keyPath = join(tempDir, "id_ed25519");
  try {
    ensureKeyPair(keyPath, "incarnate-local-bootstrap");
    const publicKey = readFileSync(`${keyPath}.pub`, "utf8").trim();

    ensureLocalAccountKey(tempDir, "matt", "local-dev", publicKey);

    const accountFile = readFileSync(join(tempDir, "java/lib_server/accounts/matt.act"), "utf8");
    assert(accountFile.includes(`${KEY_ONLY_SENTINEL}  /// PassWord`));
    assert(accountFile.includes("AuthorizedKeys {\n"));
    assert(accountFile.includes(`local-dev\ttrue\tSHA256:`));
    assert(accountFile.includes(publicKey));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ensureLocalAccountKey updates existing accounts without duplicating key labels", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "incarnate-local-bootstrap-update-"));
  const keyPath = join(tempDir, "id_ed25519");
  try {
    ensureKeyPair(keyPath, "incarnate-local-bootstrap-update");
    const publicKey = readFileSync(`${keyPath}.pub`, "utf8").trim();

    ensureLocalAccountKey(tempDir, "matt", "device", publicKey);
    ensureLocalAccountKey(tempDir, "matt", "device", publicKey);

    const accountFile = readFileSync(join(tempDir, "java/lib_server/accounts/matt.act"), "utf8");
    assert.equal(accountFile.match(/^device\ttrue\t/gm)?.length, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ensureLocalAccountKey rejects path traversal and line injection inputs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "incarnate-local-bootstrap-reject-"));
  try {
    assert.throws(() => ensureLocalAccountKey(tempDir, "../matt", "device", "ssh-ed25519 AAAA"), /Invalid account/);
    assert.throws(() => ensureLocalAccountKey(tempDir, "matt", "device\nadmin", "ssh-ed25519 AAAA"), /Invalid key label/);
    assert.throws(() => ensureLocalAccountKey(tempDir, "matt", "device", "ssh-ed25519 AAAA\nextra"), /single line/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
