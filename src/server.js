require("dotenv").config();

const express = require("express");
const { randomBytes, randomUUID, createHash, timingSafeEqual } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const DysmsapiClient = require("@alicloud/dysmsapi20170525").default;
const { SendSmsRequest } = require("@alicloud/dysmsapi20170525");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createMcpExpressApp } = require("@modelcontextprotocol/sdk/server/express.js");
const { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } = require("@modelcontextprotocol/sdk/server/auth/router.js");
const { requireBearerAuth } = require("@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js");
const { InvalidTokenError } = require("@modelcontextprotocol/sdk/server/auth/errors.js");
const { LicenseError, LicenseService, hashSecret } = require("./license-service");

const port = Number(process.env.PORT || 18787);
const host = process.env.HOST || "127.0.0.1";
const publicBaseUrl = new URL(process.env.PUBLIC_BASE_URL || `http://localhost:${port}`);
const adminApiKey = process.env.ADMIN_API_KEY || "replace-this-before-deploying";
const authMode = process.env.AUTH_MODE || "sms";
const dataDir = resolve(process.env.DATA_DIR || join(process.cwd(), "data"));
const workflowDir = resolve(process.env.WORKFLOW_DIR || join(process.cwd(), "workflows"));
const licenseService = new LicenseService(join(dataDir, "licenses.sqlite"));
const workflowFiles = {
  reverseToDramaCommerce: join(workflowDir, "reverse-to-drama-commerce.md"),
  seedanceDramaContainer: join(workflowDir, "seedance-drama-container.md"),
};

if (!["sms", "redeem_only"].includes(authMode)) {
  throw new Error("AUTH_MODE 仅支持 sms 或 redeem_only。");
}

function randomToken() {
  return randomBytes(32).toString("base64url");
}

function errorResponse(res, error) {
  const status = error instanceof LicenseError ? 400 : 500;
  res.status(status).json({ error: error.code || "internal_error", message: error.message || "服务器错误。" });
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left || "");
  const rightBuffer = Buffer.from(right || "");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function requireAdmin(req, res, next) {
  const authorization = req.get("authorization") || "";
  const [scheme, credentials] = authorization.split(" ");
  const decoded = scheme === "Basic" && credentials
    ? Buffer.from(credentials, "base64").toString("utf8")
    : "";
  const separator = decoded.indexOf(":");
  const username = separator >= 0 ? decoded.slice(0, separator) : "";
  const password = separator >= 0 ? decoded.slice(separator + 1) : "";

  if (safeEqual(username, "admin") && safeEqual(password, adminApiKey)) {
    return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="juqing-skill-admin"');
  return res.status(401).type("html").send("<h1>需要管理员登录</h1>");
}

function adminPage({ result = null, error = null } = {}) {
  const notice = result
    ? `<section class="notice success">${result}</section>`
    : error
      ? `<section class="notice error">${error}</section>`
      : "";
  const customers = licenseService.listCustomers();
  const activationCodes = licenseService.listActivationCodes();
  const productName = {
    permanent: "永久",
    monthly: "月度",
    quarterly: "季度",
    yearly: "年度",
  };
  const activationCodeById = new Map(activationCodes.map((activationCode) => [activationCode.id, activationCode]));
  const activationCodeStatus = (activationCode) => {
    if (activationCode.revoked_at) return "已撤销";
    if (activationCode.expires_at && new Date(activationCode.expires_at) <= new Date()) return "已过期";
    if (activationCode.redemptions >= activationCode.max_redemptions) return "已用完";
    if (activationCode.redemptions > 0) return "部分已使用";
    return "未使用";
  };
  const customersRows = customers.length
    ? customers.map((customer) => {
      const entitlement = customer.product
        ? `${productName[customer.product]}${customer.ends_at ? ` · 至 ${customer.ends_at.slice(0, 10)}` : ""}`
        : "无有效授权";
      const device = customer.device_label
        ? `${escapeHtml(customer.device_label)}<br><small>绑定 ${customer.device_activated_at.slice(0, 10)} · 最近 ${customer.last_seen_at.slice(0, 16).replace("T", " ")}</small>`
        : "未绑定";
      const sourceCode = customer.entitlement_source === "code"
        ? activationCodeById.get(customer.entitlement_source_id)
        : null;
      const activationSource = customer.entitlement_source === "code"
        ? sourceCode?.code_value
          ? `<code>${escapeHtml(sourceCode.code_value)}</code>`
          : "<small>历史兑换码（完整码未保存）</small>"
        : customer.entitlement_source === "admin"
          ? "后台直接授权"
          : "无";
      return `<tr>
        <td>${escapeHtml(customer.phone)}</td>
        <td>${entitlement}</td>
        <td>${activationSource}</td>
        <td>${device}</td>
        <td>${customer.created_at.slice(0, 10)}</td>
        <td class="actions">
          <form method="post" action="/admin/web/release-device"><input type="hidden" name="phone" value="${customer.phone}"><button class="secondary" type="submit">解绑设备</button></form>
          <form method="post" action="/admin/web/revoke"><input type="hidden" name="phone" value="${customer.phone}"><input type="hidden" name="reason" value="admin_revoke"><button class="danger-button" type="submit">撤销授权</button></form>
        </td>
      </tr>`;
    }).join("")
    : '<tr><td colspan="6" class="empty">暂无用户。创建兑换码并完成激活后，用户会出现在这里。</td></tr>';
  const activationCodeRows = activationCodes.length
    ? activationCodes.map((activationCode) => {
      const code = activationCode.code_value
        ? `<code>${escapeHtml(activationCode.code_value)}</code>`
        : "<small>历史兑换码（完整码未保存）</small>";
      const expiry = activationCode.expires_at ? activationCode.expires_at.slice(0, 16).replace("T", " ") : "长期有效";
      const customers = activationCode.redeemed_customers || "暂无";
      return `<tr>
        <td>${code}</td>
        <td>${productName[activationCode.product]}</td>
        <td>${activationCodeStatus(activationCode)}</td>
        <td>${activationCode.redemptions} / ${activationCode.max_redemptions}</td>
        <td>${escapeHtml(customers)}</td>
        <td>${expiry}</td>
        <td>${escapeHtml(activationCode.note || "-")}</td>
      </tr>`;
    }).join("")
    : '<tr><td colspan="7" class="empty">暂无兑换码。</td></tr>';
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Juqing Skill 管理后台</title>
<style>
  :root { color-scheme: light; font-family: system-ui, sans-serif; color: #1f2937; background: #f4f6f8; }
  body { margin: 0; }
  main { max-width: 1180px; margin: 40px auto; padding: 0 20px 40px; }
  h1 { margin: 0 0 8px; font-size: 26px; }
  .intro { color: #667085; margin: 0 0 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(245px, 1fr)); gap: 16px; }
  section { background: #fff; border: 1px solid #d9dee7; border-radius: 8px; padding: 20px; }
  h2 { margin: 0 0 16px; font-size: 18px; }
  label { display: grid; gap: 6px; margin: 12px 0; font-size: 14px; font-weight: 600; }
  input, select, button { font: inherit; }
  input, select { box-sizing: border-box; padding: 9px 10px; border: 1px solid #c9d1dc; border-radius: 5px; }
  button { margin-top: 8px; padding: 9px 14px; border: 0; border-radius: 5px; background: #1677ff; color: #fff; cursor: pointer; }
  button.secondary { background: #526071; }
  button.danger-button { background: #c9362b; }
  .notice { margin-bottom: 16px; }
  .success { border-color: #8dcf9d; background: #effbf1; color: #1e6c30; }
  .error { border-color: #e5a5a0; background: #fff1f0; color: #a61d24; }
  code { font-size: 16px; font-weight: 700; word-break: break-all; }
  .users { margin-top: 20px; overflow-x: auto; }
  .activation-codes { margin-top: 20px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e5e9ef; vertical-align: top; }
  th { color: #667085; font-weight: 600; white-space: nowrap; }
  small { color: #667085; line-height: 1.5; }
  .actions { display: flex; gap: 8px; min-width: 188px; }
  .actions form { margin: 0; }
  .actions button { margin: 0; white-space: nowrap; font-size: 13px; }
  .empty { color: #667085; text-align: center; }
</style>
<main>
  <h1>Juqing Skill</h1>
  <p class="intro">授权管理后台</p>
  ${notice}
  <div class="grid">
    <section>
      <h2>创建兑换码</h2>
      <form method="post" action="/admin/web/codes">
        <label>授权类型
          <select name="product">
            <option value="permanent">永久</option>
            <option value="monthly">月度</option>
            <option value="quarterly">季度</option>
            <option value="yearly">年度</option>
          </select>
        </label>
        <label>可兑换次数<input name="maxRedemptions" type="number" min="1" value="1" required></label>
        <label>兑换截止时间（可选）<input name="expiresAt" type="datetime-local"></label>
        <label>备注（可选）<input name="note" maxlength="200"></label>
        <button type="submit">生成兑换码</button>
      </form>
    </section>
    <section>
      <h2>直接授权手机号</h2>
      <form method="post" action="/admin/web/grants">
        <label>手机号<input name="phone" inputmode="numeric" pattern="1[0-9]{10}" required></label>
        <label>授权类型
          <select name="product">
            <option value="permanent">永久</option>
            <option value="monthly">月度</option>
            <option value="quarterly">季度</option>
            <option value="yearly">年度</option>
          </select>
        </label>
        <label>备注（可选）<input name="note" maxlength="200"></label>
        <button type="submit">确认授权</button>
      </form>
    </section>
    <section>
      <h2>撤销授权</h2>
      <form method="post" action="/admin/web/revoke">
        <label>手机号<input name="phone" inputmode="numeric" pattern="1[0-9]{10}" required></label>
        <label>撤销原因<input name="reason" value="refund" maxlength="200"></label>
        <button class="danger-button" type="submit">撤销并踢下线</button>
      </form>
    </section>
  </div>
  <section class="users">
    <h2>用户列表（${customers.length}）</h2>
    <table>
      <thead><tr><th>手机号</th><th>当前授权</th><th>激活来源</th><th>绑定设备</th><th>注册日期</th><th>操作</th></tr></thead>
      <tbody>${customersRows}</tbody>
    </table>
  </section>
  <section class="activation-codes">
    <h2>激活码列表（${activationCodes.length}）</h2>
    <table>
      <thead><tr><th>激活码</th><th>授权类型</th><th>状态</th><th>已用 / 可用</th><th>已激活用户</th><th>截止时间</th><th>备注</th></tr></thead>
      <tbody>${activationCodeRows}</tbody>
    </table>
  </section>
</main>
</html>`;
}

function cookieParser(req, _res, next) {
  req.cookies = Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
  next();
}

class DevelopmentSmsProvider {
  constructor() {
    this.challenges = new Map();
  }

  createChallenge(phone) {
    const existing = this.challenges.get(phone);
    if (existing && Date.now() - existing.sentAt < 60 * 1000) {
      throw new LicenseError("sms_rate_limit", "验证码已发送，请 60 秒后再试。");
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    this.challenges.set(phone, {
      code,
      expiresAt: Date.now() + 5 * 60 * 1000,
      sentAt: Date.now(),
    });
    return code;
  }

  async send(phone) {
    return this.createChallenge(phone);
  }

  verify(phone, code) {
    const challenge = this.challenges.get(phone);
    if (!challenge || challenge.expiresAt < Date.now() || challenge.code !== code) {
      throw new LicenseError("invalid_sms_code", "短信验证码无效或已过期。");
    }
    this.challenges.delete(phone);
  }
}

class AliyunSmsProvider extends DevelopmentSmsProvider {
  constructor({ accessKeyId, accessKeySecret, signName, templateCode, templateParamName = "code" }) {
    super();
    if (!accessKeyId || !accessKeySecret || !signName || !templateCode) {
      throw new Error("阿里云短信配置不完整，请检查 .env 中的 ALIYUN_SMS_* 配置。");
    }
    this.client = new DysmsapiClient({
      accessKeyId,
      accessKeySecret,
      endpoint: "dysmsapi.aliyuncs.com",
    });
    this.signName = signName;
    this.templateCode = templateCode;
    this.templateParamName = templateParamName;
  }

  async send(phone) {
    const code = this.createChallenge(phone);
    try {
      const response = await this.client.sendSms(new SendSmsRequest({
        phoneNumbers: phone,
        signName: this.signName,
        templateCode: this.templateCode,
        templateParam: JSON.stringify({ [this.templateParamName]: code }),
      }));
      if (response.body?.code !== "OK") {
        throw new Error(response.body?.message || "阿里云短信发送失败。");
      }
    } catch (error) {
      this.challenges.delete(phone);
      throw new LicenseError("sms_send_failed", `验证码发送失败：${error.message || "请稍后再试。"}`);
    }
  }
}

function createSmsProvider() {
  if (process.env.SMS_MODE === "aliyun") {
    return new AliyunSmsProvider({
      accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
      accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET,
      signName: process.env.ALIYUN_SMS_SIGN_NAME,
      templateCode: process.env.ALIYUN_SMS_TEMPLATE_CODE,
      templateParamName: process.env.ALIYUN_SMS_TEMPLATE_PARAM_NAME,
    });
  }
  if (!process.env.SMS_MODE || process.env.SMS_MODE === "development") {
    return new DevelopmentSmsProvider();
  }
  throw new Error("SMS_MODE 仅支持 development 或 aliyun。");
}

class OAuthProvider {
  constructor(service, baseUrl, authenticationMode) {
    this.service = service;
    this.baseUrl = baseUrl;
    this.authenticationMode = authenticationMode;
    this.clientsStore = {
      getClient: async (clientId) => {
        const row = this.service.db.prepare("SELECT data FROM oauth_clients WHERE id = ?").get(clientId);
        return row ? JSON.parse(row.data) : undefined;
      },
      registerClient: async (client) => {
        this.service.db.prepare("INSERT INTO oauth_clients (id, data, created_at) VALUES (?, ?, ?)")
          .run(client.client_id, JSON.stringify(client), new Date().toISOString());
        return client;
      },
    };
  }

  async authorize(client, params, res) {
    const flowId = randomUUID();
    this.service.db.prepare(`
      INSERT INTO oauth_flows (id, client_id, params, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      flowId,
      client.client_id,
      JSON.stringify({
        ...params,
        resource: params.resource ? params.resource.toString() : null,
      }),
      new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      new Date().toISOString()
    );
    const browserDeviceId = randomUUID();
    res.cookie("rsav_device", browserDeviceId, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.baseUrl.protocol === "https:",
      maxAge: 365 * 24 * 60 * 60 * 1000,
      path: "/",
    });
    const authorizationForm = this.authenticationMode === "redeem_only"
      ? `
  <p>请输入手机号和兑换码激活。兑换码仅可使用一次，激活后会绑定当前电脑。</p>
  <form method="post" action="/authorization/complete">
    <input type="hidden" name="flow_id" value="${flowId}">
    <label>手机号<br><input name="phone" inputmode="numeric" pattern="1[0-9]{10}" required></label><br><br>
    <label>兑换码<br><input name="activation_code" autocomplete="off" required></label><br><br>
    <label>设备名称<br><input name="device_label" value="Codex 电脑"></label><br><br>
    <button type="submit">激活并继续</button>
  </form>`
      : `
  <p>首次使用请输入手机号、短信验证码和兑换码。已激活用户只需手机号和短信验证码。</p>
  <form method="post" action="/authorization/complete">
    <input type="hidden" name="flow_id" value="${flowId}">
    <label>手机号<br><input name="phone" inputmode="numeric" pattern="1[0-9]{10}" required></label>
    <button type="button" id="send">发送验证码</button><br><br>
    <label>短信验证码<br><input name="sms_code" inputmode="numeric" required></label><br><br>
    <label>兑换码（首次必填）<br><input name="activation_code" autocomplete="off"></label><br><br>
    <label>设备名称<br><input name="device_label" value="Codex 电脑"></label><br><br>
    <button type="submit">激活并继续</button>
  </form>
  <p id="hint"></p>
  <script>
    document.querySelector("#send").addEventListener("click", async () => {
      const phone = document.querySelector("[name=phone]").value;
      const response = await fetch("/auth/request-sms", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phone})});
      const body = await response.json();
      document.querySelector("#hint").textContent = body.message || body.error;
    });
  </script>`;
    res.type("html").send(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><title>Juqing Skill 授权</title>
<body style="font-family:system-ui;max-width:420px;margin:48px auto;line-height:1.5">
  <h1>激活 Juqing Skill</h1>
  ${authorizationForm}
</body></html>`);
  }

  async completeAuthorization({ flowId, phone, browserDeviceId, label }) {
    const flow = this.service.db.prepare(`
      SELECT * FROM oauth_flows WHERE id = ? AND used_at IS NULL AND expires_at > ?
    `).get(flowId, new Date().toISOString());
    if (!flow) throw new LicenseError("expired_authorization", "授权请求已过期，请返回 Codex 后重试。");
    const client = await this.clientsStore.getClient(flow.client_id);
    const params = JSON.parse(flow.params);
    const device = this.service.activateDevice({ phone, browserDeviceId, label });
    const code = randomToken();
    this.service.db.prepare(`
      INSERT INTO oauth_authorization_codes
        (id, code_hash, client_id, device_id, code_challenge, redirect_uri, resource, scopes, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      hashSecret(code),
      client.client_id,
      device.id,
      params.codeChallenge,
      params.redirectUri,
      params.resource,
      JSON.stringify(params.scopes || []),
      new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      new Date().toISOString()
    );
    this.service.db.prepare("UPDATE oauth_flows SET used_at = ? WHERE id = ?")
      .run(new Date().toISOString(), flowId);
    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state) target.searchParams.set("state", params.state);
    return target.toString();
  }

  async challengeForAuthorizationCode(client, authorizationCode) {
    const row = this.getAuthorizationCode(client.client_id, authorizationCode);
    if (!row) throw new Error("Invalid authorization code");
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode) {
    const row = this.getAuthorizationCode(client.client_id, authorizationCode);
    if (!row) throw new Error("Invalid authorization code");
    this.service.db.prepare("UPDATE oauth_authorization_codes SET used_at = ? WHERE id = ?")
      .run(new Date().toISOString(), row.id);
    return this.issueTokens(client.client_id, row.device_id, JSON.parse(row.scopes), row.resource);
  }

  async exchangeRefreshToken(client, refreshToken) {
    const token = this.getToken("refresh", refreshToken);
    if (!token || token.client_id !== client.client_id) throw new Error("Invalid refresh token");
    this.service.db.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE id = ?")
      .run(new Date().toISOString(), token.id);
    return this.issueTokens(client.client_id, token.device_id, JSON.parse(token.scopes), token.resource);
  }

  async verifyAccessToken(accessToken) {
    const token = this.getToken("access", accessToken);
    if (!token) throw new InvalidTokenError("Invalid or expired access token");
    const device = this.service.db.prepare(`
      SELECT devices.*, customers.phone FROM devices
      JOIN customers ON customers.id = devices.customer_id
      WHERE devices.id = ? AND devices.revoked_at IS NULL
    `).get(token.device_id);
    if (!device || !this.service.hasActiveEntitlement(device.customer_id)) {
      throw new InvalidTokenError("Device or entitlement is no longer valid");
    }
    this.service.touchDevice(device.id);
    return {
      token: accessToken,
      clientId: token.client_id,
      scopes: JSON.parse(token.scopes),
      expiresAt: Math.floor(new Date(token.expires_at).getTime() / 1000),
      resource: token.resource ? new URL(token.resource) : undefined,
      extra: { customerId: device.customer_id, deviceId: device.id },
    };
  }

  async revokeToken(_client, request) {
    const token = this.service.db.prepare(`
      SELECT id FROM oauth_tokens WHERE token_hash = ? AND revoked_at IS NULL
    `).get(hashSecret(request.token));
    if (token) {
      this.service.db.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE id = ?")
        .run(new Date().toISOString(), token.id);
    }
  }

  getAuthorizationCode(clientId, rawCode) {
    return this.service.db.prepare(`
      SELECT * FROM oauth_authorization_codes
      WHERE code_hash = ? AND client_id = ? AND used_at IS NULL AND expires_at > ?
    `).get(hashSecret(rawCode), clientId, new Date().toISOString());
  }

  getToken(kind, rawToken) {
    return this.service.db.prepare(`
      SELECT * FROM oauth_tokens
      WHERE token_hash = ? AND kind = ? AND revoked_at IS NULL AND expires_at > ?
    `).get(hashSecret(rawToken), kind, new Date().toISOString());
  }

  issueTokens(clientId, deviceId, scopes, resource) {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const now = new Date();
    const accessExpiry = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const refreshExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    for (const [kind, token, expiry] of [
      ["access", accessToken, accessExpiry],
      ["refresh", refreshToken, refreshExpiry],
    ]) {
      this.service.db.prepare(`
        INSERT INTO oauth_tokens
          (id, token_hash, kind, client_id, device_id, scopes, resource, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), hashSecret(token), kind, clientId, deviceId, JSON.stringify(scopes), resource, expiry, now.toISOString());
    }
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "bearer",
      expires_in: 3600,
      scope: scopes.join(" "),
    };
  }
}

function addAuthTables(service) {
  service.db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_flows (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, params TEXT NOT NULL, expires_at TEXT NOT NULL,
      used_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
      id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, device_id TEXT NOT NULL,
      code_challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, resource TEXT, scopes TEXT NOT NULL,
      expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, client_id TEXT NOT NULL,
      device_id TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT, expires_at TEXT NOT NULL,
      revoked_at TEXT, created_at TEXT NOT NULL
    );
  `);
}

function createProtectedMcpServer() {
  const server = new McpServer({ name: "juqing-skill", version: "1.0.0" });
  server.registerTool("get_reverse_to_drama_commerce_workflow", {
    description: "获取受授权保护的剧情带货反推工作流。",
  }, async () => ({
    content: [{
      type: "text",
      text: readFileSync(workflowFiles.reverseToDramaCommerce, "utf8"),
    }],
  }));
  server.registerTool("get_seedance_drama_container_workflow", {
    description: "获取受授权保护的 Seedance 剧情带货制作工作流。",
  }, async () => ({
    content: [{
      type: "text",
      text: readFileSync(workflowFiles.seedanceDramaContainer, "utf8"),
    }],
  }));
  return server;
}

function createApp() {
  addAuthTables(licenseService);
  const provider = new OAuthProvider(licenseService, publicBaseUrl, authMode);
  const sms = authMode === "sms" ? createSmsProvider() : null;
  const app = createMcpExpressApp({
    host,
    allowedHosts: [...new Set([publicBaseUrl.hostname, "localhost", "127.0.0.1", "[::1]"])],
  });
  app.use(cookieParser);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.get("/admin", requireAdmin, (_req, res) => {
    res.type("html").send(adminPage());
  });
  app.post("/admin/web/codes", requireAdmin, (req, res) => {
    try {
      const created = licenseService.createActivationCode({
        product: req.body.product,
        expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt).toISOString() : null,
        maxRedemptions: Number(req.body.maxRedemptions),
        note: req.body.note || "",
      });
      res.type("html").send(adminPage({
        result: `兑换码已生成：<code>${created.code}</code>`,
      }));
    } catch (error) {
      res.status(400).type("html").send(adminPage({ error: error.message || "创建兑换码失败。" }));
    }
  });
  app.post("/admin/web/grants", requireAdmin, (req, res) => {
    try {
      licenseService.grant(req.body);
      res.type("html").send(adminPage({ result: "已完成直接授权。" }));
    } catch (error) {
      res.status(400).type("html").send(adminPage({ error: error.message || "授权失败。" }));
    }
  });
  app.post("/admin/web/revoke", requireAdmin, (req, res) => {
    try {
      licenseService.revokeCustomer(req.body);
      res.type("html").send(adminPage({ result: "授权已撤销，相关设备和令牌已失效。" }));
    } catch (error) {
      res.status(400).type("html").send(adminPage({ error: error.message || "撤销失败。" }));
    }
  });
  app.post("/admin/web/release-device", requireAdmin, (req, res) => {
    try {
      licenseService.releaseDevice(req.body);
      res.type("html").send(adminPage({ result: "设备绑定已解除，用户下次授权时可绑定新电脑。" }));
    } catch (error) {
      res.status(400).type("html").send(adminPage({ error: error.message || "解绑失败。" }));
    }
  });

  app.post("/auth/request-sms", (req, res) => {
    if (authMode !== "sms") {
      return res.status(404).json({ error: "sms_disabled", message: "当前授权模式不使用短信验证码。" });
    }
    try {
      licenseService.assertPhone(req.body.phone);
      sms.send(req.body.phone).then((debugCode) => {
        res.json({
          message: "验证码已发送。",
          ...(process.env.SMS_MODE === "development" ? { developmentCode: debugCode } : {}),
        });
      }).catch((error) => errorResponse(res, error));
    } catch (error) {
      errorResponse(res, error);
    }
  });

  app.post("/authorization/complete", (req, res) => {
    try {
      licenseService.assertPhone(req.body.phone);
      if (authMode === "sms") {
        sms.verify(req.body.phone, req.body.sms_code);
      }
      const customer = licenseService.findCustomer(req.body.phone);
      const hasEntitlement = customer && licenseService.hasActiveEntitlement(customer.id);
      if (!hasEntitlement && !req.body.activation_code) {
        throw new LicenseError("activation_code_required", "请输入兑换码。");
      }
      if (req.body.activation_code) {
        licenseService.redeem({ phone: req.body.phone, code: req.body.activation_code });
      }
      provider.completeAuthorization({
        flowId: req.body.flow_id,
        phone: req.body.phone,
        browserDeviceId: req.cookies?.rsav_device || randomUUID(),
        label: req.body.device_label,
      }).then((target) => res.redirect(target)).catch((error) => errorResponse(res, error));
    } catch (error) {
      errorResponse(res, error);
    }
  });

  app.use(mcpAuthRouter({
    provider,
    issuerUrl: publicBaseUrl,
    resourceServerUrl: new URL("/mcp", publicBaseUrl),
    scopesSupported: ["mcp:tools"],
    resourceName: "Juqing Skill 剧情带货工作流",
  }));

  const auth = requireBearerAuth({
    verifier: provider,
    requiredScopes: ["mcp:tools"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL("/mcp", publicBaseUrl)),
  });
  app.post("/mcp", auth, async (req, res) => {
    const server = createProtectedMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  app.post("/admin/codes", (req, res) => {
    if (req.get("x-admin-api-key") !== adminApiKey) return res.status(401).json({ error: "unauthorized" });
    try {
      res.status(201).json(licenseService.createActivationCode(req.body));
    } catch (error) {
      errorResponse(res, error);
    }
  });
  app.post("/admin/grants", (req, res) => {
    if (req.get("x-admin-api-key") !== adminApiKey) return res.status(401).json({ error: "unauthorized" });
    try {
      res.status(201).json(licenseService.grant(req.body));
    } catch (error) {
      errorResponse(res, error);
    }
  });
  app.post("/admin/revoke", (req, res) => {
    if (req.get("x-admin-api-key") !== adminApiKey) return res.status(401).json({ error: "unauthorized" });
    try {
      licenseService.revokeCustomer(req.body);
      res.status(204).end();
    } catch (error) {
      errorResponse(res, error);
    }
  });
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  return app;
}

if (require.main === module) {
  createApp().listen(port, host, () => console.log(`License and MCP server listening on ${publicBaseUrl}`));
}

module.exports = { createApp };
