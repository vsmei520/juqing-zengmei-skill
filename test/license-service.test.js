const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { LicenseError, LicenseService } = require("../src/license-service");

const services = [];

function createService() {
  const directory = mkdtempSync(join(tmpdir(), "juqing-skill-"));
  const service = new LicenseService(join(directory, "licenses.sqlite"));
  services.push({ service, directory });
  return service;
}

afterEach(() => {
  for (const { service, directory } of services.splice(0)) {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("redeems an activation code and binds one device", () => {
  const service = createService();
  const { code } = service.createActivationCode({ product: "monthly" });

  service.redeem({ phone: "13800138000", code });
  const access = service.getAccess("13800138000", "device-a");
  assert.equal(access, null);

  service.activateDevice({ phone: "13800138000", browserDeviceId: "device-a", label: "电脑 A" });
  assert.equal(service.getAccess("13800138000", "device-a").device.label, "电脑 A");
});

test("rejects a second device before transfer window", () => {
  const service = createService();
  const { code } = service.createActivationCode({ product: "permanent" });
  service.redeem({ phone: "13900139000", code });
  service.activateDevice({ phone: "13900139000", browserDeviceId: "device-a" });

  assert.throws(
    () => service.activateDevice({ phone: "13900139000", browserDeviceId: "device-b" }),
    (error) => error instanceof LicenseError && error.code === "device_limit",
  );
});

test("allows a new device after administrative release", () => {
  const service = createService();
  const { code } = service.createActivationCode({ product: "permanent" });
  service.redeem({ phone: "13700137000", code });
  service.activateDevice({ phone: "13700137000", browserDeviceId: "device-a" });
  service.releaseDevice({ phone: "13700137000" });
  service.redeem({ phone: "13700137000", code });
  service.activateDevice({ phone: "13700137000", browserDeviceId: "device-b" });

  assert.equal(service.getAccess("13700137000", "device-b").device.browser_device_id, "device-b");
  assert.equal(service.listActivationCodes()[0].redemptions, 1);
});

test("does not allow a second phone to reuse an activated code", () => {
  const service = createService();
  const { code } = service.createActivationCode({ product: "permanent" });
  service.redeem({ phone: "13400134000", code });

  assert.throws(
    () => service.redeem({ phone: "13300133000", code }),
    (error) => error instanceof LicenseError && error.code === "used_code",
  );
});

test("revocation removes access", () => {
  const service = createService();
  const { code } = service.createActivationCode({ product: "permanent" });
  service.redeem({ phone: "13600136000", code });
  service.activateDevice({ phone: "13600136000", browserDeviceId: "device-a" });
  assert.ok(service.getAccess("13600136000", "device-a"));

  service.revokeCustomer({ phone: "13600136000" });
  assert.equal(service.getAccess("13600136000", "device-a"), null);
});

test("expired entitlement is not active", () => {
  const service = createService();
  const { code } = service.createActivationCode({ product: "monthly" });
  service.redeem({ phone: "13500135000", code });
  const customer = service.findCustomer("13500135000");
  service.db.prepare("UPDATE entitlements SET ends_at = ? WHERE customer_id = ?")
    .run(new Date(Date.now() - 60_000).toISOString(), customer.id);

  assert.equal(service.hasActiveEntitlement(customer.id), false);
  assert.throws(
    () => service.activateDevice({ phone: "13500135000", browserDeviceId: "device-a" }),
    (error) => error instanceof LicenseError && error.code === "no_entitlement",
  );
});
