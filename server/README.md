# islet-server 部署

小岛的记忆库 v1 + 角色的自由时间。设计见 [DESIGN.md](DESIGN.md)。

这份说明是写给 **VPS 上的 Claude Code** 的。Mimi 可以直接对它说：「照着 `server/README.md` 部署 islet-server」。

## 前提

- Ubuntu / Debian 的 VPS，有 root 权限（HostHatch）
- 防火墙开放 80 和 443（Caddy 申请证书和提供 https 需要用到）
- 不需要域名，用 `<IP>.sslip.io`

## 步骤

### 1. 装 Node 22 和 Caddy

```bash
apt-get update
apt-get install -y curl git debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
node -v   # 应为 v22 或更高
```

### 2. 拉代码，建专用用户

```bash
useradd --system --home /opt/islet --shell /usr/sbin/nologin islet || true
git clone https://github.com/GinaGu666/islet /opt/islet
chown -R root:root /opt/islet   # 代码只读，服务用户只能写 /var/lib/islet-server
```

### 3. 写配置（钥匙只在这台机器上，不进仓库）

```bash
KEY=$(openssl rand -hex 24)
cat > /etc/islet-server.env <<EOF
ISLET_KEY=$KEY
OPENROUTER_KEY=填 Mimi 的 OpenRouter Key
ALLOWED_ORIGIN=https://ginagu666.github.io
EOF
chmod 600 /etc/islet-server.env
echo "门禁钥匙：$KEY"   # 交给 Mimi 填进小岛设置，别贴到任何公开的地方
```

`ALLOWED_ORIGIN` 只写协议加域名（`https://ginagu666.github.io`），不带 `/islet` 路径。

### 4. 启动服务

```bash
cp /opt/islet/server/islet-server.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now islet-server
systemctl status islet-server --no-pager
curl -s http://127.0.0.1:8787/health   # 应返回 {"ok":true,"freeTime":true}
```

### 5. 配置 https

```bash
IP=$(curl -s -4 https://api.ipify.org)
HOST=$(echo $IP | tr . -).sslip.io
sed "s/203-0-113-7.sslip.io/$HOST/" /opt/islet/server/Caddyfile.example > /etc/caddy/Caddyfile
systemctl reload caddy
sleep 10 && curl -s https://$HOST/health
echo "服务器地址：https://$HOST"   # 交给 Mimi 填进小岛设置
```

### 6. 交给 Mimi

告诉她两样东西：**服务器地址**（`https://<IP>.sslip.io`）和**门禁钥匙**。她在小岛的设置里填好，再到 Saturn 的记忆设置里打开「记忆库 · 自由时间」。

## Mimi 的记忆库（claude.ai 连接器）

和 Saturn 的数据分开，用另一把钥匙。放的是关于 Mimi 的事、她和 Claude 之间的关系记忆。claude.ai 通过自定义连接器读写，Mimi 在 `/claude` 页面上查看和修改。

### 开启

```bash
cd /opt/islet && git pull
MEMKEY=$(openssl rand -hex 24)
echo "CLAUDE_MEM_KEY=$MEMKEY" >> /etc/islet-server.env
systemctl restart islet-server
journalctl -u islet-server -n 3 --no-pager   # 应看到「记忆库已开启」
echo "记忆库钥匙：$MEMKEY"   # 交给 Mimi，别贴到公开的地方
```

### 在 claude.ai 里添加连接器（Mimi 自己操作）

1. 在 claude.ai 的连接器设置里，选择**添加自定义连接器**。
2. 地址填 `https://<IP>.sslip.io/mcp`。
3. 认证选**不登录**，再添加一个请求头：`Authorization`，值为 `Bearer <记忆库钥匙>`。
   如果找不到添加请求头的地方，可以把地址改成 `https://<IP>.sslip.io/mcp/k/<记忆库钥匙>`，不加请求头。（钥匙会出现在地址里，不要把这个地址给别人看。）
4. 保存后，在对话里打开这个连接器。

### 查看和修改

用浏览器打开 `https://<IP>.sslip.io/claude`，输入记忆库钥匙。

- 每一条都标明是你写的还是 Claude 写的。
- **锁定**的条目，Claude 只能读，不能改也不能删。
- Claude 删除的条目会进**回收区**，可以恢复；只有你能彻底删除。
- 每次修改都保留之前的 5 个版本，可以改回去。

数据在 `/var/lib/islet-server/claude-memory/memory.json`。

## 日常

- 看日志：`journalctl -u islet-server -n 50`（日志不含记忆内容和读书笔记正文）
- 更新代码：`cd /opt/islet && git pull && systemctl restart islet-server`
- 手动让某个角色读一次（测试用）：
  `curl -X POST -H "X-Islet-Key: $KEY" https://$HOST/own/<角色id>/read-now`
- 数据目录在 `/var/lib/islet-server`。要备份，就把这个目录整个拷走。

## 安全

- SSH 只用密钥登录，关掉密码登录。
- 防火墙只开 22、80、443。服务本身只监听 127.0.0.1:8787，不直接对外。
- 换钥匙：改 `/etc/islet-server.env` 里的 `ISLET_KEY` → `systemctl restart islet-server` → 小岛设置里同步改掉。
