import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BROWSER_RESERVED_COMMAND_TYPES,
  isBrowserAiCommandType
} from "../src/protocol.js";

test("browser bridge reserves only local-control command responses", () => {
  const commands = new Set(BROWSER_RESERVED_COMMAND_TYPES);
  assert.equal(commands.size, BROWSER_RESERVED_COMMAND_TYPES.length, "reserved command list should not contain duplicates");

  for (const command of [
    "auth_complete",
    "account_create_complete",
    "account_add_key_complete",
    "client_capabilities",
    "pong"
  ]) {
    assert(commands.has(command as typeof BROWSER_RESERVED_COMMAND_TYPES[number]), `${command} should be reserved for bridge control`);
  }
});

test("browser command type syntax accepts future gameplay commands without a bridge allowlist", () => {
  for (const command of [
    "move",
    "ops_dashboard_request",
    "future_gameplay_probe",
    "paid_buy"
  ]) {
    assert.equal(isBrowserAiCommandType(command), true, `${command} should be accepted as a browser command type`);
  }

  for (const command of [
    "",
    "_hidden",
    "BridgeCommand",
    "shell.exec",
    "x".repeat(65),
    undefined
  ]) {
    assert.equal(isBrowserAiCommandType(command), false, `${String(command)} should not be accepted as a browser command type`);
  }
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
