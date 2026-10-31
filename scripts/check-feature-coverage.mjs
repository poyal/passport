import assert from "node:assert/strict";
import fs from "node:fs";
import { loadGuiPolicy } from "./release-gui-policy.mjs";

const inventory = JSON.parse(
  fs.readFileSync("tests/feature-coverage.json", "utf8"),
);
const source = fs.readFileSync("src/shared/model.ts", "utf8");
const contract = source.match(
  /export interface Calls \{([\s\S]+?)\r?\n\}\r?\nexport type Call/,
);
assert.ok(contract, "Missing Calls contract");
const calls = [...contract[1].matchAll(/^  (?:"([^"]+)"|(\w+)):/gm)]
  .map((match) => match[1] || match[2])
  .sort();
assert.ok(calls.length > 0, "Empty Calls contract");
const policy = new Set(loadGuiPolicy().policy.tests.map((test) => test.id));
const mapped = new Set(),
  scenarios = new Set(),
  ids = new Set();
assert.equal(inventory.schemaVersion, 1);
for (const feature of inventory.features) {
  assert.ok(feature.id && !ids.has(feature.id), "Duplicate feature ID");
  ids.add(feature.id);
  assert.ok(
    feature.outcomes.length && feature.unit.length && feature.e2e.length,
    `Incomplete feature: ${feature.id}`,
  );
  for (const file of feature.unit)
    assert.ok(fs.existsSync(file), `Missing unit evidence: ${file}`);
  for (const file of feature.scenario || [])
    assert.ok(fs.existsSync(file), `Missing scenario runner: ${file}`);
  for (const id of feature.e2e) {
    assert.ok(policy.has(id), `Unknown GUI scenario: ${id}`);
    scenarios.add(id);
  }
  for (const call of feature.calls) {
    assert.ok(calls.includes(call), `Removed or renamed IPC: ${call}`);
    mapped.add(call);
  }
}
assert.deepEqual(
  [...mapped].sort(),
  calls,
  "Every IPC needs an explicit feature and regression mapping",
);
assert.deepEqual(
  [...scenarios].sort(),
  [...policy].sort(),
  "Every GUI policy scenario needs a feature mapping",
);
console.log(
  `Feature inventory: ${ids.size} groups, ${calls.length} IPC calls, ${scenarios.size} GUI scenarios. Mapping is not proof of execution; use the reports.`,
);
