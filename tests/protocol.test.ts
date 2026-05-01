import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BROWSER_AI_COMMAND_TYPES } from "../src/protocol.js";

test("browser command allowlist is unique and includes sensitive server-authorized commands", () => {
  const commands = new Set(BROWSER_AI_COMMAND_TYPES);
  assert.equal(commands.size, BROWSER_AI_COMMAND_TYPES.length, "command allowlist should not contain duplicates");

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
    assert(commands.has(command as typeof BROWSER_AI_COMMAND_TYPES[number]), `${command} should be represented in the bridge contract`);
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
