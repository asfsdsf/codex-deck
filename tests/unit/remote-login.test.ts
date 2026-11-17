import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRemoteAdminUrl,
  rawInputIncludesBootstrapPinHints,
  resolveRemoteLoginTarget,
} from "../../web/remote-login";

const defaults = {
  pinnedRealmId: "default-realm",
  pinnedOpaqueServerPublicKey: "default-key",
};

test("remote login preserves server trust pins in a pasted CLI login URL", () => {
  const input =
    '"https://relay.example/?codexdeck_remote_server_url=https%3A%2F%2Frelay.example%2F&codexdeck_remote_realm_id=cli-realm&codexdeck_remote_opaque_server_key=key%2Bvalue%3D"';
  assert.equal(rawInputIncludesBootstrapPinHints(input), true);
  assert.deepEqual(resolveRemoteLoginTarget(input, defaults), {
    serverUrl: "https://relay.example",
    pins: { realmId: "cli-realm", opaqueServerPublicKey: "key+value=" },
  });
});

test("remote login uses bootstrap trust pins for a plain server URL", () => {
  assert.deepEqual(
    resolveRemoteLoginTarget(" https://relay.example/deck/ ", defaults),
    {
      serverUrl: "https://relay.example/deck",
      pins: { realmId: "default-realm", opaqueServerPublicKey: "default-key" },
    },
  );
  assert.equal(
    rawInputIncludesBootstrapPinHints("https://relay.example/"),
    false,
  );
  assert.equal(
    buildRemoteAdminUrl("https://relay.example/deck/"),
    "https://relay.example/admin",
  );
  assert.equal(buildRemoteAdminUrl(""), null);
});
