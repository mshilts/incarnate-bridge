import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BRIDGE_RESERVED_BROWSER_MESSAGE_TYPES, type BrowserAiCommandContract } from "../src/protocol.js";

test("bridge exposes only reserved local browser messages, not a game command catalog", () => {
  const reserved = new Set<string>(BRIDGE_RESERVED_BROWSER_MESSAGE_TYPES);
  assert.equal(reserved.size, BRIDGE_RESERVED_BROWSER_MESSAGE_TYPES.length, "reserved local browser messages should not contain duplicates");
  assert.deepEqual([...reserved].sort(), ["bridge_device_key", "client_debug"]);

  for (const command of [
    "guild_command",
    "god_mode",
    "god_map_save",
    "ops_dashboard_request",
    "payments_command",
    "buy_credits",
    "paid_buy",
    "paid_unlock",
    "auth_begin",
    "auth_key_probe",
    "account_create_begin",
    "account_add_key_begin"
  ]) {
    assert.equal(reserved.has(command), false, `${command} should not be modeled as a bridge-local message`);
  }
});

test("browser command contract accepts open-ended game command types", () => {
  const command: BrowserAiCommandContract = {
    schemaVersion: 1,
    type: "future_server_command",
    payload: { ok: true }
  };

  assert.equal(command.type, "future_server_command");
});

test("package has no private monorepo runtime dependency", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    workspaces?: unknown;
  };
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies
  };

  assert.equal(packageJson.workspaces, undefined, "standalone package must not declare workspaces");
  assert.equal(dependencies["@incarnate/protocol-ts"], undefined, "standalone bridge must not import private protocol workspace");
});
