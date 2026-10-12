// dsh-anywhere 设置持久化（$DSH_HOME/dsh-anywhere/settings.json）
//
// 核心配置：
//   - lanEnabled        局域网访问总开关（默认开启）
//   - lanAuthEnabled    局域网访问密码开关（默认开启，局域网与公网独立）
//   - publicPinCustom   公网密码是否自定义（自定义后不自动轮换）
//   - lanPinCustom      局域网密码是否自定义
//   - tunnelMode        公网模式：'quick'（默认，Cloudflare 随机隧道）| 'named'（Cloudflare 命名隧道）| 'fixed'（自定义外部公网/FRP通道）
//   - fixedWanUrl       自定义公网通道 URL（用户自行填写的 FRP、异地组网或公网 IP 地址）
//   - tunnelToken       Cloudflare 命名隧道 Token
//   - tunnelHostname    Cloudflare 命名隧道固定域名
//   - proxyPort         局域网代理端口（桌面端固定 3082，无头端固定 3083）
//   - cloudflaredPath   cloudflared 本地路径

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { isValidIpv4 } from './ip.mjs';

const settingsRel = join('dsh-anywhere', 'settings.json');
export function settingsPath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), settingsRel);
}

function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    // 兼容读取旧版 settings 作为初始迁移
    try {
      const oldPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-anywhere', 'settings.json');
      const oldRaw = JSON.parse(readFileSync(oldPath, 'utf8'));
      if (oldRaw && typeof oldRaw === 'object') return oldRaw;
    } catch { /* 忽略 */ }
  }
  return {};
}

function writeSettings(s) {
  try {
    mkdirSync(dirname(settingsPath()), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2), { mode: 0o600 });
  } catch { /* 忽略 */ }
  return s;
}

/** 局域网访问总开关：默认开启。 */
export function lanEnabled() {
  return readSettings().lanEnabled !== false;
}

export function setLanEnabled(on) {
  const s = readSettings();
  s.lanEnabled = !!on;
  writeSettings(s);
  return s.lanEnabled;
}

/** 局域网访问密码开关：默认开启。 */
export function lanAuthEnabled() {
  return readSettings().lanAuthEnabled !== false;
}

export function setLanAuthEnabled(on) {
  const s = readSettings();
  s.lanAuthEnabled = !!on;
  writeSettings(s);
  return s.lanAuthEnabled;
}

/** 局域网地址手动覆盖：默认空字符串 = 自动选择。 */
export function lanIpOverride() {
  return readSettings().lanIpOverride ?? '';
}

export function setLanIpOverride(value) {
  const ip = String(value ?? '').trim();
  if (ip && !isValidIpv4(ip)) {
    throw new Error('局域网地址必须是 IPv4 地址 | LAN address must be an IPv4 address');
  }
  const s = readSettings();
  if (ip) s.lanIpOverride = ip;
  else delete s.lanIpOverride;
  writeSettings(s);
  return ip;
}

const PIN_CUSTOM_KEYS = { public: 'publicPinCustom', lan: 'lanPinCustom' };

export function pinCustom(which) {
  const key = PIN_CUSTOM_KEYS[which];
  if (!key) return false;
  return readSettings()[key] === true;
}

export function setPinCustom(which, on) {
  const key = PIN_CUSTOM_KEYS[which];
  if (!key) return false;
  const s = readSettings();
  s[key] = !!on;
  writeSettings(s);
  return !!on;
}

export function resetSettings() {
  try {
    rmSync(settingsPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 默认自定义公网通道：通用版默认留空（由用户自行配置或使用内置 Cloudflare 隧道）
 */
export const DEFAULT_FIXED_WAN_URL = '';

/** 获取自定义公网通道 URL */
export function fixedWanUrl() {
  const v = readSettings().fixedWanUrl;
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : DEFAULT_FIXED_WAN_URL;
}

/** 设置自定义公网通道 URL */
export function setFixedWanUrl(url) {
  const v = String(url ?? '').trim();
  const s = readSettings();
  if (v) s.fixedWanUrl = v;
  else delete s.fixedWanUrl;
  writeSettings(s);
  return fixedWanUrl();
}

/** 隧道模式：'quick'（默认，免配置 Cloudflare 隧道）| 'named'（Cloudflare 命名隧道）| 'fixed'（自定义外部公网/FRP通道）。 */
export function tunnelMode() {
  const s = readSettings();
  const m = s.tunnelMode;
  if (m === 'fixed' || m === 'named' || m === 'quick') return m;
  if (typeof s.fixedWanUrl === 'string' && s.fixedWanUrl.trim().length > 0) return 'fixed';
  return 'quick';
}

export function setTunnelMode(mode) {
  if (mode !== 'fixed' && mode !== 'quick' && mode !== 'named') {
    throw new Error('隧道模式必须是 fixed、quick 或 named | tunnel mode must be fixed, quick, or named');
  }
  const s = readSettings();
  if (mode === 'quick') delete s.tunnelMode;
  else s.tunnelMode = mode;
  writeSettings(s);
  return tunnelMode();
}

export function tunnelToken() {
  const v = readSettings().tunnelToken;
  return typeof v === 'string' ? v : '';
}

export function setTunnelToken(value) {
  const v = String(value ?? '').trim();
  if (v && (v.length < 20 || !/^[A-Za-z0-9+/_=-]+$/.test(v))) {
    throw new Error('Tunnel Token 格式不对（应为 Cloudflare 后台复制的完整 Token）');
  }
  const s = readSettings();
  if (v) s.tunnelToken = v;
  else delete s.tunnelToken;
  writeSettings(s);
  return v;
}

export function tunnelHostname() {
  const v = readSettings().tunnelHostname;
  return typeof v === 'string' ? v : '';
}

export function setTunnelHostname(value) {
  let v = String(value ?? '').trim().toLowerCase();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#\s]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  if (v) {
    const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
    const IS_IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
    if (IS_IPV4.test(v) || !v.includes('.') || !HOSTNAME_RE.test(v)) {
      throw new Error('固定域名格式不对（如 dsh.example.com）');
    }
  }
  const s = readSettings();
  if (v) s.tunnelHostname = v;
  else delete s.tunnelHostname;
  writeSettings(s);
  return v;
}

/** 代理端口（0 = 自动根据桌面端/无头端分配 3082/3083）。 */
export function proxyPort() {
  const v = Number(readSettings().proxyPort);
  return Number.isInteger(v) && v >= 1 && v <= 65535 ? v : 0;
}

export function setProxyPort(value) {
  const n = Number(value);
  const s = readSettings();
  if (Number.isInteger(n) && n >= 1 && n <= 65535) s.proxyPort = n;
  else delete s.proxyPort;
  writeSettings(s);
  return proxyPort();
}

/** cloudflared 自定义路径 */
export function cloudflaredPath() {
  return readSettings().cloudflaredPath ?? '';
}

export function setCloudflaredPath(value) {
  const v = String(value ?? '').trim();
  const s = readSettings();
  if (v) s.cloudflaredPath = v;
  else delete s.cloudflaredPath;
  writeSettings(s);
  return v;
}
