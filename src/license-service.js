const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { mkdirSync } = require("node:fs");
const { dirname } = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const PRODUCT_DAYS = {
  monthly: 31,
  quarterly: 92,
  yearly: 366,
};

function nowIso() {
  return new Date().toISOString();
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString();
}

function hashSecret(value) {
  return createHash("sha256").update(value).digest("hex");
}

function formatCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(20);
  const parts = [];
  for (let offset = 0; offset < 20; offset += 4) {
    let part = "";
    for (let index = offset; index < offset + 4; index += 1) {
      part += alphabet[bytes[index] % alphabet.length];
    }
    parts.push(part);
  }
  return `JSK-${parts.join("-")}`;
}

class LicenseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class LicenseService {
  constructor(databasePath) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activation_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        code_value TEXT,
        product TEXT NOT NULL,
        expires_at TEXT,
        max_redemptions INTEGER NOT NULL DEFAULT 1,
        redemptions INTEGER NOT NULL DEFAULT 0,
        revoked_at TEXT,
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entitlements (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        product TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT,
        source TEXT NOT NULL,
        source_id TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        browser_device_id TEXT NOT NULL,
        label TEXT NOT NULL,
        activated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE(customer_id, browser_device_id)
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        customer_id TEXT REFERENCES customers(id),
        action TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(activation_codes)").all();
    if (!columns.some((column) => column.name === "code_value")) {
      this.db.exec("ALTER TABLE activation_codes ADD COLUMN code_value TEXT");
    }
  }

  close() {
    this.db.close();
  }

  assertPhone(phone) {
    if (!/^1\d{10}$/.test(phone)) {
      throw new LicenseError("invalid_phone", "请输入有效的中国大陆手机号。");
    }
  }

  assertProduct(product) {
    if (!["permanent", "monthly", "quarterly", "yearly"].includes(product)) {
      throw new LicenseError("invalid_product", "未知的授权类型。");
    }
  }

  createActivationCode({ product, expiresAt = null, maxRedemptions = 1, note = "" }) {
    this.assertProduct(product);
    if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1) {
      throw new LicenseError("invalid_redemptions", "兑换次数必须是正整数。");
    }
    const code = formatCode();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO activation_codes
        (id, code_hash, code_value, product, expires_at, max_redemptions, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, hashSecret(code), code, product, expiresAt, maxRedemptions, note, nowIso());
    return { id, code, product, expiresAt, maxRedemptions, note };
  }

  grant({ phone, product, note = "" }) {
    this.assertPhone(phone);
    this.assertProduct(product);
    const customer = this.getOrCreateCustomer(phone);
    const entitlement = this.createEntitlement(customer.id, product, "admin", null);
    this.audit(customer.id, "admin_grant", JSON.stringify({ product, note, entitlementId: entitlement.id }));
    return entitlement;
  }

  redeem({ phone, code }) {
    this.assertPhone(phone);
    const customer = this.getOrCreateCustomer(phone);
    const activationCode = this.db.prepare("SELECT * FROM activation_codes WHERE code_hash = ?").get(hashSecret(code.trim().toUpperCase()));
    if (!activationCode || activationCode.revoked_at) {
      throw new LicenseError("invalid_code", "兑换码无效或已撤销。");
    }
    const existingEntitlement = this.findActiveEntitlementBySource(customer.id, activationCode.id);
    if (existingEntitlement) {
      return existingEntitlement;
    }
    if (activationCode.expires_at && new Date(activationCode.expires_at) <= new Date()) {
      throw new LicenseError("expired_code", "兑换码已过期。");
    }
    if (activationCode.redemptions >= activationCode.max_redemptions) {
      throw new LicenseError("used_code", "兑换码已被使用。");
    }
    this.db.prepare("UPDATE activation_codes SET redemptions = redemptions + 1 WHERE id = ?").run(activationCode.id);
    const entitlement = this.createEntitlement(customer.id, activationCode.product, "code", activationCode.id);
    this.audit(customer.id, "code_redeemed", JSON.stringify({ codeId: activationCode.id, product: activationCode.product }));
    return entitlement;
  }

  activateDevice({ phone, browserDeviceId, label }) {
    this.assertPhone(phone);
    const customer = this.getOrCreateCustomer(phone);
    if (!this.hasActiveEntitlement(customer.id)) {
      throw new LicenseError("no_entitlement", "该手机号尚无有效授权，请先兑换或由管理员授权。");
    }

    const existing = this.db.prepare(
      "SELECT * FROM devices WHERE customer_id = ? AND browser_device_id = ? AND revoked_at IS NULL"
    ).get(customer.id, browserDeviceId);
    if (existing) {
      this.touchDevice(existing.id);
      return existing;
    }

    const activeDevice = this.db.prepare("SELECT * FROM devices WHERE customer_id = ? AND revoked_at IS NULL").get(customer.id);
    if (activeDevice) {
      if (browserDeviceId.startsWith("oauth-client:") && !activeDevice.browser_device_id.startsWith("oauth-client:")) {
        this.db.prepare("UPDATE devices SET browser_device_id = ?, label = ?, last_seen_at = ? WHERE id = ?")
          .run(browserDeviceId, label || activeDevice.label, nowIso(), activeDevice.id);
        this.audit(customer.id, "device_binding_migrated", JSON.stringify({ deviceId: activeDevice.id }));
        return this.db.prepare("SELECT * FROM devices WHERE id = ?").get(activeDevice.id);
      }
      const earliestTransferAt = addDays(activeDevice.activated_at, 90);
      if (new Date(earliestTransferAt) > new Date()) {
        throw new LicenseError("device_limit", `当前授权已绑定一台电脑，最早可在 ${earliestTransferAt.slice(0, 10)} 自助换机。`);
      }
      this.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(nowIso(), activeDevice.id);
      this.audit(customer.id, "device_transferred", JSON.stringify({ from: activeDevice.id }));
    }

    const device = {
      id: randomUUID(),
      customer_id: customer.id,
      browser_device_id: browserDeviceId,
      label: label || "Codex 电脑",
      activated_at: nowIso(),
      last_seen_at: nowIso(),
      revoked_at: null,
    };
    this.db.prepare(`
      INSERT INTO devices (id, customer_id, browser_device_id, label, activated_at, last_seen_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(device.id, device.customer_id, device.browser_device_id, device.label, device.activated_at, device.last_seen_at, device.revoked_at);
    this.audit(customer.id, "device_activated", JSON.stringify({ deviceId: device.id, label: device.label }));
    return device;
  }

  revokeCustomer({ phone, reason = "refund" }) {
    const customer = this.findCustomer(phone);
    if (!customer) throw new LicenseError("unknown_customer", "未找到该手机号对应的授权。");
    const timestamp = nowIso();
    this.db.prepare("UPDATE entitlements SET revoked_at = ? WHERE customer_id = ? AND revoked_at IS NULL").run(timestamp, customer.id);
    this.db.prepare("UPDATE devices SET revoked_at = ? WHERE customer_id = ? AND revoked_at IS NULL").run(timestamp, customer.id);
    this.audit(customer.id, "customer_revoked", JSON.stringify({ reason }));
  }

  releaseDevice({ phone, reason = "admin_release" }) {
    const customer = this.findCustomer(phone);
    if (!customer) throw new LicenseError("unknown_customer", "未找到该手机号对应的用户。");
    const timestamp = nowIso();
    const result = this.db.prepare("UPDATE devices SET revoked_at = ? WHERE customer_id = ? AND revoked_at IS NULL").run(timestamp, customer.id);
    if (result.changes === 0) throw new LicenseError("no_active_device", "该用户当前没有已绑定设备。");
    this.audit(customer.id, "device_released", JSON.stringify({ reason }));
  }

  listCustomers() {
    return this.db.prepare(`
      SELECT
        customers.phone,
        customers.created_at,
        (
          SELECT product FROM entitlements
          WHERE customer_id = customers.id AND revoked_at IS NULL
            AND (ends_at IS NULL OR ends_at > ?)
          ORDER BY CASE WHEN product = 'permanent' THEN 1 ELSE 0 END DESC, ends_at DESC
          LIMIT 1
        ) AS product,
        (
          SELECT ends_at FROM entitlements
          WHERE customer_id = customers.id AND revoked_at IS NULL
            AND (ends_at IS NULL OR ends_at > ?)
          ORDER BY CASE WHEN product = 'permanent' THEN 1 ELSE 0 END DESC, ends_at DESC
          LIMIT 1
        ) AS ends_at,
        (
          SELECT source FROM entitlements
          WHERE customer_id = customers.id AND revoked_at IS NULL
            AND (ends_at IS NULL OR ends_at > ?)
          ORDER BY CASE WHEN product = 'permanent' THEN 1 ELSE 0 END DESC, ends_at DESC
          LIMIT 1
        ) AS entitlement_source,
        (
          SELECT source_id FROM entitlements
          WHERE customer_id = customers.id AND revoked_at IS NULL
            AND (ends_at IS NULL OR ends_at > ?)
          ORDER BY CASE WHEN product = 'permanent' THEN 1 ELSE 0 END DESC, ends_at DESC
          LIMIT 1
        ) AS entitlement_source_id,
        (
          SELECT label FROM devices
          WHERE customer_id = customers.id AND revoked_at IS NULL
          ORDER BY activated_at DESC
          LIMIT 1
        ) AS device_label,
        (
          SELECT activated_at FROM devices
          WHERE customer_id = customers.id AND revoked_at IS NULL
          ORDER BY activated_at DESC
          LIMIT 1
        ) AS device_activated_at,
        (
          SELECT last_seen_at FROM devices
          WHERE customer_id = customers.id AND revoked_at IS NULL
          ORDER BY last_seen_at DESC
          LIMIT 1
        ) AS last_seen_at
      FROM customers
      ORDER BY customers.created_at DESC
    `).all(nowIso(), nowIso(), nowIso(), nowIso());
  }

  listActivationCodes() {
    return this.db.prepare(`
      SELECT
        activation_codes.id,
        activation_codes.code_value,
        activation_codes.product,
        activation_codes.expires_at,
        activation_codes.max_redemptions,
        activation_codes.redemptions,
        activation_codes.revoked_at,
        activation_codes.note,
        activation_codes.created_at,
        COALESCE((
          SELECT GROUP_CONCAT(customers.phone || '（' || SUBSTR(entitlements.created_at, 1, 10) || '）', '、')
          FROM entitlements
          JOIN customers ON customers.id = entitlements.customer_id
          WHERE entitlements.source = 'code' AND entitlements.source_id = activation_codes.id
        ), '') AS redeemed_customers
      FROM activation_codes
      ORDER BY activation_codes.created_at DESC
    `).all();
  }

  listAuditLogs(limit = 50) {
    return this.db.prepare(`
      SELECT audit_log.action, audit_log.detail, audit_log.created_at, customers.phone
      FROM audit_log
      LEFT JOIN customers ON customers.id = audit_log.customer_id
      ORDER BY audit_log.created_at DESC
      LIMIT ?
    `).all(limit);
  }

  activeEntitlement(customerId) {
    return this.db.prepare(`
      SELECT * FROM entitlements
      WHERE customer_id = ? AND revoked_at IS NULL
        AND (ends_at IS NULL OR ends_at > ?)
      ORDER BY CASE WHEN product = 'permanent' THEN 1 ELSE 0 END DESC, ends_at DESC
      LIMIT 1
    `).get(customerId, nowIso());
  }

  findActiveEntitlementBySource(customerId, sourceId) {
    return this.db.prepare(`
      SELECT * FROM entitlements
      WHERE customer_id = ? AND source = 'code' AND source_id = ? AND revoked_at IS NULL
        AND (ends_at IS NULL OR ends_at > ?)
      ORDER BY created_at DESC
      LIMIT 1
    `).get(customerId, sourceId, nowIso());
  }

  hasActiveEntitlement(customerId) {
    return Boolean(this.activeEntitlement(customerId));
  }

  createEntitlement(customerId, product, source, sourceId) {
    this.assertProduct(product);
    const startsAt = nowIso();
    const endsAt = product === "permanent" ? null : addDays(startsAt, PRODUCT_DAYS[product]);
    const entitlement = {
      id: randomUUID(),
      customer_id: customerId,
      product,
      starts_at: startsAt,
      ends_at: endsAt,
      source,
      source_id: sourceId,
      revoked_at: null,
      created_at: startsAt,
    };
    this.db.prepare(`
      INSERT INTO entitlements
        (id, customer_id, product, starts_at, ends_at, source, source_id, revoked_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entitlement.id,
      entitlement.customer_id,
      entitlement.product,
      entitlement.starts_at,
      entitlement.ends_at,
      entitlement.source,
      entitlement.source_id,
      entitlement.revoked_at,
      entitlement.created_at,
    );
    return entitlement;
  }

  getAccess(phone, browserDeviceId) {
    const customer = this.findCustomer(phone);
    if (!customer) return null;
    const device = this.db.prepare(
      "SELECT * FROM devices WHERE customer_id = ? AND browser_device_id = ? AND revoked_at IS NULL"
    ).get(customer.id, browserDeviceId);
    if (!device || !this.hasActiveEntitlement(customer.id)) return null;
    this.touchDevice(device.id);
    return { customer, device, entitlement: this.activeEntitlement(customer.id) };
  }

  getOrCreateCustomer(phone) {
    this.assertPhone(phone);
    const existing = this.findCustomer(phone);
    if (existing) return existing;
    const customer = { id: randomUUID(), phone, created_at: nowIso() };
    this.db.prepare("INSERT INTO customers (id, phone, created_at) VALUES (?, ?, ?)").run(customer.id, customer.phone, customer.created_at);
    return customer;
  }

  findCustomer(phone) {
    return this.db.prepare("SELECT * FROM customers WHERE phone = ?").get(phone);
  }

  touchDevice(deviceId) {
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(nowIso(), deviceId);
  }

  audit(customerId, action, detail) {
    this.db.prepare("INSERT INTO audit_log (id, customer_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), customerId, action, detail, nowIso());
  }
}

module.exports = { LicenseError, LicenseService, hashSecret };
