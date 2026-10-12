// dsh-anywhere 服务核心：端口代理 + Cloudflare 隧道 / 自定义外部公网通道

import { networkInterfaces } from 'node:os';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createPocketProxy } from './proxy.mjs';
import { startQuickTunnel, startNamedTunnel } from './tunnel.mjs';
import { isValidIpv4 } from './ip.mjs';

const require = createRequire(import.meta.url);

export async function qrDataUrl(text, { width = 220, margin = 1 } = {}) {
  if (!text) return null;
  const QRCode = require('qrcode');
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin, width, type: 'image/png' });
}

const PRIVATE_IPV4_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/;
const PHYSICAL_IFACE_RE = /^(?:wlan|wi-?fi|wireless|ethernet|eth\d|en\d|wlp\d|以太网|有线|无线|本地连接)/i;
const VPN_IFACE_RE = /(?:radmin|tailscale|zerotier|easytier|et_|tun|tap|vpn|vethernet|virtual|vmware|virtualbox|wsl|docker|teredo|hamachi|bluetooth|bridge)/i;

export function selectLanIPv4(interfaces) {
  const candidates = [];
  for (const [name, addrs] of Object.entries(interfaces ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;

      let score = 0;
      if (PRIVATE_IPV4_RE.test(ip)) score += 100;
      if (PHYSICAL_IFACE_RE.test(name)) score += 20;
      else if (VPN_IFACE_RE.test(name)) score -= 50;

      candidates.push({ ip, score, order: candidates.length });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates[0]?.ip ?? null;
}

export function detectWsl() {
  try {
    const v = readFileSync('/proc/version', 'utf8').toLowerCase();
    if (v.includes('microsoft') || v.includes('wsl')) return true;
  } catch { /* 忽略 */ }
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

export function parseIpconfig(text, { includeVpn = false } = {}) {
  const out = [];
  const blocks = String(text ?? '').split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const header = lines[0];
    const isVpn = VPN_IFACE_RE.test(header);
    if (isVpn && !includeVpn) continue;
    for (const line of lines) {
      const m = line.match(/(?:IPv4\s*(?:地址|Address)[^:]*:\s*)([0-9.]+)/i);
      if (m && isValidIpv4(m[1]) && !m[1].startsWith('127.') && !m[1].startsWith('169.254.')) {
        out.push(m[1]);
      }
    }
  }
  return out;
}

function resolveWslWindowsLan(includeVpn = false) {
  return new Promise((resolve) => {
    execFile('ipconfig.exe', { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      resolve(parseIpconfig(stdout, { includeVpn }));
    });
  });
}

export function createPocketService({
  dshPort,
  port = 3083,
  isDesktop = false,
  getLanIp = () => selectLanIPv4(networkInterfaces()),
  getLanOverride = () => '',
  getLanEnabled = () => true,
  getTunnelConfig = () => ({ mode: 'quick', fixedWanUrl: '' }),
  home,
  createProxy = createPocketProxy,
  startTunnel = startQuickTunnel,
  startNamed = startNamedTunnel,
  injectHtml,
  auth,
  launchToken,
  onTunnelReady,
  log,
} = {}) {
  const isWsl = detectWsl();
  const logInfo = log?.info?.bind(log) ?? console.log;
  const logWarn = log?.warn?.bind(log) ?? console.warn;

  async function getLan() {
    const override = getLanOverride();
    if (override && isValidIpv4(override)) return override;
    if (isWsl) {
      const wslIps = await resolveWslWindowsLan(false);
      if (wslIps.length > 0) return wslIps[0];
    }
    return getLanIp();
  }

  async function getLanCandidates() {
    const out = [];
    if (isWsl) {
      const wslIps = await resolveWslWindowsLan(true);
      out.push(...wslIps);
    }
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal && a.address && !a.address.startsWith('127.')) {
          out.push(a.address);
        }
      }
    }
    return [...new Set(out)];
  }

  let proxy = null;
  let tunnel = null;
  let tunnelAbort = null;
  let tunnelPromise = null;
  const tunnelState = { phase: 'idle', detail: '', startedAt: null };

  const qrCache = new Map();
  async function qrCached(url) {
    if (!url) return null;
    const hit = qrCache.get(url);
    if (hit) return hit;
    const data = await qrDataUrl(url).catch(() => null);
    if (data) {
      qrCache.set(url, data);
      if (qrCache.size > 20) qrCache.delete(qrCache.keys().next().value);
    }
    return data;
  }

  const autoStatePath = home ? join(home, 'dsh-anywhere', 'tunnel-auto.json') : null;
  let autoStateQueue = Promise.resolve();
  function persistAutoTunnel() {
    if (!autoStatePath) return;
    autoStateQueue = autoStateQueue.then(async () => {
      try {
        await mkdir(dirname(autoStatePath), { recursive: true });
        await writeFile(autoStatePath, JSON.stringify({ at: Date.now() }), 'utf8');
      } catch { /* 忽略 */ }
    });
    return autoStateQueue;
  }
  function clearAutoTunnel() {
    if (!autoStatePath) return;
    autoStateQueue = autoStateQueue.then(async () => {
      try { await rm(autoStatePath, { force: true }); } catch { /* 忽略 */ }
    });
    return autoStateQueue;
  }

  // 严格端口判定：桌面端 3082，无头端 3083
  const targetPort = isDesktop ? 3082 : (port || 3083);

  return {
    dshPort,
    targetPort,
    async startProxy() {
      if (proxy) return proxy;
      try {
        proxy = await createProxy({
          port: targetPort,
          host: '0.0.0.0',
          upstream: { host: '127.0.0.1', port: dshPort },
          ...(injectHtml ? { injectHtml } : {}),
          ...(auth ? { auth } : {}),
          lanAccessEnabled: () => getLanEnabled(),
          ...(launchToken ? { launchToken } : {}),
        });
        logInfo(`dsh-anywhere: proxy running strictly on port ${targetPort} | 局域网代理就绪在 ${targetPort}`);
      } catch (err) {
        if (err?.code === 'EADDRINUSE') {
          logWarn(`dsh-anywhere: port ${targetPort} busy, trying graceful takeover or fallback | 端口 ${targetPort} 被占用`);
          // 备用端口一次性容错，不再漂移遍历
          const fallbackPort = targetPort === 3082 ? 3083 : 3082;
          proxy = await createProxy({
            port: fallbackPort,
            host: '0.0.0.0',
            upstream: { host: '127.0.0.1', port: dshPort },
            ...(injectHtml ? { injectHtml } : {}),
            ...(auth ? { auth } : {}),
            lanAccessEnabled: () => getLanEnabled(),
            ...(launchToken ? { launchToken } : {}),
          });
          logInfo(`dsh-anywhere: proxy started on fallback port ${fallbackPort}`);
        } else {
          throw err;
        }
      }
      return proxy;
    },

    async startTunnel() {
      await this.startProxy();
      if (tunnel) return tunnel.url;
      if (tunnelPromise) return tunnelPromise;

      const controller = new AbortController();
      tunnelAbort = controller;
      tunnelState.startedAt = Date.now();
      const onPhase = (phase) => {
        tunnelState.phase = phase;
        if (phase === 'downloading') tunnelState.detail = '极速国内镜像下载 cloudflared（约 20MB）…';
        else if (phase === 'starting') tunnelState.detail = '启动隧道进程…';
        else if (phase === 'registering') tunnelState.detail = '连接边缘节点（通常 5-15 秒）…';
        else if (phase === 'ready') tunnelState.detail = '公网通道就绪';
      };

      const p = (async () => {
        await null;
        try {
          const cfg = typeof getTunnelConfig === 'function' ? (getTunnelConfig() ?? {}) : {};
          
          // 1. 自定义公网/FRP通道（用户自行填写的固定穿透地址）
          if (cfg?.mode === 'fixed') {
            const url = cfg.fixedWanUrl;
            if (!url) {
              throw new Error('未配置自定义公网地址：请在设置中输入完整的公网访问 URL');
            }
            tunnel = {
              url,
              kill: () => {},
              onExit: () => () => {},
            };
            tunnelState.phase = 'ready';
            tunnelState.detail = '自定义公网通道已就绪';
            void persistAutoTunnel();
            try { onTunnelReady?.('fixed'); } catch { /* 忽略 */ }
            return tunnel.url;
          }

          // 2. Cloudflare 命名隧道
          if (cfg?.mode === 'named') {
            if (!cfg.token || !cfg.hostname) {
              throw new Error('命名隧道未配置完整：需要填入 Tunnel Token 和固定域名');
            }
            const result = await startNamed({ token: cfg.token, home, signal: controller.signal, onPhase });
            tunnel = { url: `https://${cfg.hostname}`, kill: result.kill, onExit: result.onExit };
          } else {
            // 3. Cloudflare 快速隧道
            const result = await startTunnel({ port: proxy.port, home, signal: controller.signal, onPhase });
            tunnel = typeof result === 'string' ? { url: result, kill: () => {} } : result;
          }

          tunnelState.phase = 'ready';
          tunnel.onExit?.((code) => {
            if (controller.signal.aborted) return;
            tunnelState.phase = 'error';
            tunnelState.detail = `隧道进程退出（code=${code}）`;
          });
          void persistAutoTunnel();
          try { onTunnelReady?.(cfg?.mode === 'named' ? 'named' : 'quick'); } catch { /* 忽略 */ }
          return tunnel.url;
        } catch (err) {
          if (!controller.signal.aborted) {
            tunnelState.phase = 'error';
            tunnelState.detail = err?.message ?? String(err);
          }
          tunnelState.startedAt = null;
          throw err;
        } finally {
          if (tunnelPromise === p) tunnelPromise = null;
        }
      })();
      tunnelPromise = p;
      return p;
    },

    stopTunnel({ keepAutoMarker = false } = {}) {
      tunnelAbort?.abort();
      tunnelAbort = null;
      tunnelPromise = null;
      if (tunnel) tunnel.kill();
      tunnel = null;
      tunnelState.phase = 'idle';
      tunnelState.detail = '';
      tunnelState.startedAt = null;
      if (!keepAutoMarker) void clearAutoTunnel();
    },

    async restoreTunnelIfNeeded() {
      if (!autoStatePath || tunnel || tunnelPromise) return;
      let has = false;
      try {
        const raw = await readFile(autoStatePath, 'utf8');
        has = /"at"\s*:/.test(raw);
      } catch { return; }
      if (!has) return;
      try {
        await this.startTunnel();
        logInfo('dsh-anywhere: public tunnel auto-restored | 公网通道已自动恢复');
      } catch (err) {
        logWarn('dsh-anywhere: tunnel auto-restore failed: %s', err?.message ?? err);
      }
    },

    async status() {
      const lan = await getLan();
      const proxyPort = proxy?.port ?? null;
      const lanUrl = lan && proxyPort ? `http://${lan}:${proxyPort}` : null;
      const lanIpOverride = getLanOverride();
      const lanCandidates = [...new Set(await getLanCandidates())];
      if (lanIpOverride && !lanCandidates.includes(lanIpOverride)) lanCandidates.push(lanIpOverride);

      const cfg = typeof getTunnelConfig === 'function' ? (getTunnelConfig() ?? {}) : {};
      const currentWanUrl = tunnel?.url ?? (cfg?.mode === 'fixed' && cfg.fixedWanUrl ? cfg.fixedWanUrl : null);

      return {
        proxyRunning: proxy !== null,
        proxyPort,
        lanUrl,
        lanQr: await qrCached(lanUrl),
        lanCandidates,
        lanIpOverride,
        tunnelRunning: tunnel !== null || Boolean(cfg?.mode === 'fixed' && cfg?.fixedWanUrl),
        tunnelUrl: currentWanUrl,
        tunnelQr: await qrCached(currentWanUrl),
        tunnelState: { ...tunnelState },
        tunnelConfig: {
          mode: cfg?.mode ?? 'quick',
          hostname: typeof cfg?.hostname === 'string' ? cfg.hostname : '',
          tokenSet: Boolean(cfg?.token),
          fixedWanUrl: cfg?.fixedWanUrl || '',
        },
        dshPort,
      };
    },

    async dispose() {
      this.stopTunnel({ keepAutoMarker: true });
      if (proxy) {
        const p = proxy;
        proxy = null;
        try { await p.close(); } catch { /* 忽略 */ }
      }
    },
  };
}
