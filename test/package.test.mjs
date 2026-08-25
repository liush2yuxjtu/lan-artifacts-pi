import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const source = await readFile(new URL("extensions/lan-artifacts.ts", root), "utf8");

test("package is discoverable by Pi gallery", () => {
  assert.equal(pkg.private, undefined);
  assert.ok(pkg.keywords.includes("pi-package"));
  assert.deepEqual(pkg.pi.extensions, ["./extensions/lan-artifacts.ts"]);
});

test("published extension has no machine-local secret fallback or hidden prompt injection", () => {
  assert.doesNotMatch(source, /\.claude-artifacts/);
  assert.doesNotMatch(source, /before_agent_start/);
  assert.doesNotMatch(source, /context_get/);
  assert.match(source, /LAN_ARTIFACT_WRITE_TOKEN/);
});

test("destructive delete requires interactive human confirmation", () => {
  assert.match(source, /ctx\.ui\.confirm/);
  assert.match(source, /ctx\.hasUI/);
});
