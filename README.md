# dsh-anywhere

**随身协同 · 实时同屏** —— 手机、平板、多终端扫码即同步访问电脑上的 DeepSeek Harness（局域网 + 公网，多设备同时收发、锁屏切回秒级自愈）。

---

## ✨ 核心特性

1. **多终端实时同屏与无缝切换（Fast-Resume）**
   - 支持电脑、iPhone、iPad、安卓等多台设备同时在线连接同一会话。
   - 任意终端发送消息，其余终端实时同步滚动与流式输出，互不踢线。
   - 针对移动端切后台 / 锁屏深度优化：唤醒后 0.25 秒内自动静默重连并拉齐历史流，告别白屏假死。

2. **双端口严格隔离（重启不漂移）**
   - **桌面客户端（GUI）**：严格绑定 `3082` 端口。
   - **后台无头服务（Web）**：严格绑定 `3083` 端口。
   - 彻底解决多实例共存或软件重启时端口来回跳变的问题。

3. **三层通用稳定外网方案**
   - **方案一：零配置快速隧道（默认开箱即用）**
     - 内置国内多源并发分片加速下载 `cloudflared`（亦支持直接放入 `bin/cloudflared.exe` 免下载启动）。
     - 强制启用 `--protocol http2` 传输，大幅降低国内运营商对 UDP/QUIC 的阻断与丢包。
   - **方案二：Cloudflare 命名隧道（永久固定域名）**
     - 在设置面板切换至「固定域名」，填入 Cloudflare Zero Trust 的 `Tunnel Token` 与自定义域名，重启后外网地址永久不变。
   - **方案三：自定义公网 / FRP / 异地组网直通（`fixedWanUrl`）**
     - 支持结合 SakuraFrp、OpenFrp、自建 FRP、Tailscale、ZeroTier 等任意穿透工具，在 `~/.dsh/dsh-anywhere/settings.json` 中配置 `fixedWanUrl` 与 `"tunnelMode": "fixed"`，自动生成二维码并由代理层接管访问认证。

4. **安全防爆破保护**
   - 公网与局域网独立密码开关，支持自定义固定密码。
   - 内置单 IP 防暴力破解限制：连续输错 5 次密码自动封禁该 IP 24 小时。

---

## 🚀 安装与启用

在你的 DSH Profile 目录（例如 `~/.dsh/profiles/desktop`）下安装并启用：

```bash
pnpm add <本仓库地址或本地路径>
```

并在 `settings.yaml` 的 `plugins` 中启用 `dsh-anywhere`：

```yaml
plugins:
  dsh-anywhere:
    enabled: true
```

---

## ⚙️ 配置文件说明（`~/.dsh/dsh-anywhere/settings.json`）

首次运行会自动生成配置，所有字段均为通用配置，不包含任何硬编码个人地址：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `lanEnabled` | `boolean` | `true` | 是否开启局域网访问 |
| `lanAuthEnabled` | `boolean` | `true` | 局域网访问是否需要密码验证 |
| `tunnelMode` | `string` | `"quick"` | `"quick"`（随机隧道）/ `"named"`（CF固定域名）/ `"fixed"`（自定义外部公网URL） |
| `tunnelHostname` | `string` | `""` | `named` 模式下的自定义完整域名 |
| `tunnelToken` | `string` | `""` | `named` 模式下的 Cloudflare Tunnel Token |
| `fixedWanUrl` | `string` | `""` | `fixed` 模式下的自定义公网穿透完整地址 |

---

## 📄 License

MIT
