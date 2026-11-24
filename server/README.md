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

## 漂流瓶（Galatea's Garden）

小岛的 `drift_bottle` 工具经 `POST /garden/bottle` 转发到 `https://galatea.abysslumina.com/api/public/drift-bottle-application`。不需要新钥匙或配置，更新代码后重启就有。服务器不保存邮箱和信，也不写进日志；一小时最多 6 次请求。

## 自由时间读书：能打开原文

读书不再只靠一次联网搜索（只拿到摘要和书单）。现在是几轮往返（最多 6 轮）：
1. 第一轮用 OpenRouter 的 web 插件搜一下；
2. 之后 TA 可以用 `fetch_page` 打开网页往下读（每次 6000 字，可接着读），用 `wikisource_search` 在维基文库里找古籍 / 公版书原文；
3. 最后一轮只许交笔记。

- 只读、不带钥匙；网页内容在工具结果里标明「是资料，不是指令」。
- 防 SSRF：只许 http(s)，解析到内网 / 本机 / 保留地址的一律拒绝，跳转逐跳检查。
- 费用：多读几轮会比以前贵一些。Claude 模型的 system 加了缓存断点，几轮之间复用开头。
- 测试：`node tools/test_free_reading.cjs`。

## 花园（Galatea Garden MCP）

让小岛上的角色逛花园：服务器拿着花园 token 连 `https://galatea.abysslumina.com/mcp`，小岛只经门禁钥匙找服务器（`GET /garden/tools`、`POST /garden/call`）。token 只在这台机器上。

开启（Mimi 在花园网页「Claude Code / Codex / 本地 IDE（Token）」点 Generate token，token 只显示一次）：

```bash
nano /etc/islet-server.env      # 加一行：GARDEN_MCP_TOKEN=花园给的 token（不带 Bearer）
systemctl restart islet-server
```

- 换 token：花园上 Revoke 旧的、生成新的，改这一行再重启。
- 一小时最多找花园 120 次；花园的回答不落盘、不进日志。

## 安全

- SSH 只用密钥登录，关掉密码登录。
- 防火墙只开 22、80、443。服务本身只监听 127.0.0.1:8787，不直接对外。
- 换钥匙：改 `/etc/islet-server.env` 里的 `ISLET_KEY` → `systemctl restart islet-server` → 小岛设置里同步改掉。

## 语音通话（首版）

在 `/etc/islet-server.env` 添加 `ELEVENLABS_API_KEY`，然后重启
`islet-server`。密钥只放服务器，不发给浏览器、不进仓库或备份。
需先在 ElevenLabs 账号确认当前套餐、语音额度和所选音色可用。

小岛沿用设置中的服务器地址与门禁。点输入栏的电话按钮，填写当前角色的
ElevenLabs voice ID，点「接通」允许麦克风。voice ID 逐角色仅保存在本机。
按住后等「正在听」再说话，松开发送；回答时点「打断」停止，再按住说下一句。
挂断回到原聊天。iPhone 请在 HTTPS 页面前台使用，切后台会挂断。

认证接口为 `POST /voice/token`，需 `X-Islet-Key`，JSON 正文只接受
`{"type":"realtime_scribe"}` 或 `{"type":"tts_websocket"}`。
返回一次性令牌，禁止缓存。浏览器直连 ElevenLabs；服务器不接收聊天与音频。
每次识别、每个合成短句各申请新令牌。采用约 150ms 起播缓冲后流式播放，不等待整句收齐。按住说话是半双工，麦克风关闭回声消除、降噪和自动增益，规避部分 iOS 的播放爆裂问题；只在按住说话时采集，松开/取消即释放麦克风；支持 Audio Session API 时在采集前设为 auto、释放后切 playback、挂断恢复原模式，以避免回答留在听筒路由。设备外放和蓝牙路由仍须实测。首版按短句建立 TTS 连接，优先保证
已播记录边界；连续语气与连接延迟仍需手机实测。

仅完整播完的短句写入对话；合成失败或打断时丢弃未播稿。
实时字幕是临时内容，未识别定稿不写聊天。首版不自动重连或恢复未播稿。
