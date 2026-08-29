# Juqing Skill 服务端部署

公开 GitHub 仓库只包含 Codex 插件薄壳。两份核心工作流正文和授权数据库必须放在服务器上。

## 服务器目录

```text
/www/wwwroot/juqing-skill/
/www/wwwroot/juqing-skill-data/
/www/wwwroot/juqing-skill-workflows/
  reverse-to-drama-commerce.md
  seedance-drama-container.md
```

把本地根目录的两份原始 Markdown 分别上传并改名为上面两个英文文件名。不要把它们放入 GitHub。

## 启动服务

```bash
cd /www/wwwroot/juqing-skill
npm ci --omit=dev
cp .env.example .env
nano .env
npm start
```

生产环境必须修改 `PUBLIC_BASE_URL`、`ADMIN_API_KEY`、`DATA_DIR` 和 `WORKFLOW_DIR`。建议用宝塔 Supervisor 或 systemd 保持 Node 进程运行，Nginx 反代到 `127.0.0.1:8787` 并启用 HTTPS。

## 验证

```bash
curl https://your-domain.example/healthz
```

返回 `{"ok":true}` 后，把插件中的 MCP 地址设置为 `https://juqing.073955.com/mcp`，再提交 GitHub。

管理后台地址为 `https://juqing.073955.com/admin`，浏览器会弹出 Basic Auth，用户名固定为 `admin`，密码是 `.env` 中的 `ADMIN_API_KEY`。
