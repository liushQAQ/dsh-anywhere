// cloudflared 隧道与公网通道管理
//
// 三条路径：
//   - 快速隧道 startQuickTunnel：URL 由 cloudflared 随机分配，内置二进制免配置即用
//   - 命名隧道 startNamedTunnel：用户自带 Cloudflare Tunnel Token + 固定域名，重启地址不变
//   - 自定义公网通道：支持用户自行配置 FRP / 异地组网 / 反向代理公网 URL

import { spawn, execSync } from 'node:child_process';
import { mkdir, access, chmod, rm, stat, rename, cp, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';

export const QUICK_TUNNEL_URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;

export function firstMeaningfulErrorLine(buf) {
  const lines = String(buf ?? '').trim().split(/\r?\n/);
  const usageIdx = lines.findIndex((l) => /^(?:Incorrect Usage|flag provided but not defined|unknown flag|unknown command)/i.test(l.trim()));
  if (usageIdx >= 0) return lines[usageIdx].trim().slice(0, 500);
  return lines.slice(-4).join('\n').trim().slice(0, 500);
}

function platformBinary() {
  const archMap = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' };
  const a = archMap[process.arch] ?? process.arch;
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
  return { os, a, ext: os === 'windows' ? '.exe' : '' };
}

export function platformAssets() {
  const { os, a } = platformBinary();
  if (os === 'windows') return [`cloudflared-windows-${a}.exe`];
  if (os === 'darwin') return [`cloudflared-darwin-${a}.tgz`];
  return [`cloudflared-linux-${a}`, `cloudflared-linux-${a}.tgz`];
}

// 国内高可用镜像优先，官方源垫底
const CLOUDFLARED_MIRRORS = [
  (asset) => `https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://gh.ddlc.top/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
];

const TUNA_BOTTLES = 'https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/';
const PARALLEL_SEGMENTS = 6;
const MIN_PARALLEL_SIZE = 8 * 1024 * 1024;
const PROBE_SIZE = 1 * 1024 * 1024;
const SLOW_SPEED_THRESHOLD = 0.3;

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

async function mergeParts(partFiles, dest) {
  const { createReadStream } = await import('node:fs');
  const out = createWriteStream(dest);
  try {
    for (const f of partFiles) {
      await new Promise((resolve, reject) => {
        const rs = createReadStream(f);
        rs.on('error', reject);
        rs.pipe(out, { end: false });
        rs.on('end', resolve);
      });
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
}

export async function downloadFile(url, dest, { signal, segments = PARALLEL_SEGMENTS } = {}) {
  let head = null;
  try { head = await fetch(url, { method: 'HEAD', signal }); } catch { head = null; }
  const len = head ? Number(head.headers.get('content-length') || 0) : 0;
  const acceptsRanges = head ? String(head.headers.get('accept-ranges') || '').toLowerCase() === 'bytes' : false;

  if (!head || !acceptsRanges || len < MIN_PARALLEL_SIZE) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    return len || 0;
  }

  const probeBytes = Math.min(PROBE_SIZE, len);
  const probeStart = Date.now();
  try {
    const probeRes = await fetch(url, { signal, headers: { Range: `bytes=0-${probeBytes - 1}` } });
    if (!probeRes.ok) throw new Error(`HTTP ${probeRes.status} (probe)`);
    const probeBody = await probeRes.arrayBuffer();
    const probeMs = Date.now() - probeStart;
    const probeSpeed = probeMs > 0 ? probeBytes / probeMs : Infinity;
    if (probeMs < 500 || probeSpeed >= SLOW_SPEED_THRESHOLD) {
      const { createWriteStream } = await import('node:fs');
      const w = createWriteStream(dest);
      await new Promise((resolve, reject) => {
        w.on('error', reject);
        w.write(Buffer.from(probeBody));
        w.end(resolve);
      });
      const restRes = await fetch(url, { signal, headers: { Range: `bytes=${probeBytes}-${len - 1}` } });
      if (!restRes.ok) throw new Error(`HTTP ${restRes.status} (rest)`);
      await pipeline(Readable.fromWeb(restRes.body), createWriteStream(dest, { flags: 'a' }));
      return len;
    }
    await rm(dest, { force: true }).catch(() => {});
  } catch (err) {
    await rm(dest, { force: true }).catch(() => {});
    if (!/HTTP|fetch/i.test(String(err?.message ?? ''))) throw err;
  }

  const parts = [];
  const chunk = Math.ceil(len / segments);
  for (let i = 0; i < segments; i++) {
    const start = i * chunk;
    const end = i === segments - 1 ? len - 1 : Math.min(start + chunk - 1, len - 1);
    if (start > end) break;
    parts.push({ start, end, file: `${dest}.part${i}` });
  }
  try {
    await Promise.all(parts.map(async (p) => {
      const res = await fetch(url, { signal, headers: { Range: `bytes=${p.start}-${p.end}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status} (range ${p.start}-${p.end})`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(p.file));
    }));
    await mergeParts(parts.map((p) => p.file), dest);
  } finally {
    await Promise.all(parts.map((p) => rm(p.file, { force: true }).catch(() => {})));
  }
  return len;
}

export async function tsinghuaBottleUrl({ os, a }) {
  if (os !== 'darwin') return null;
  let res;
  try {
    res = await fetch(TUNA_BOTTLES, { signal: AbortSignal.timeout(15_000) });
  } catch { return null; }
  if (!res.ok) return null;
  let html;
  try { html = await res.text(); } catch { return null; }
  const MACOS_CODES = 'monterey|ventura|sonoma|sequoia|tahoe';
  const pattern = new RegExp(`cloudflared-([0-9.]+)\\.${a === 'arm64' ? 'arm64_' : ''}(${MACOS_CODES})\\.bottle\\.tar\\.gz`, 'g');
  let best = null;
  let bestV = '';
  for (const m of html.matchAll(pattern)) {
    if (m[1] > bestV) { bestV = m[1]; best = m[0]; }
  }
  return best ? `${TUNA_BOTTLES}${best}` : null;
}

async function downloadCloudflared(binPath, callerSignal) {
  const { os, a, ext } = platformBinary();
  const dir = dirname(binPath);
  const tmpFile = join(dir, `cloudflared.download`);
  const isWindows = os === 'windows';

  const bottle = os === 'darwin' ? await tsinghuaBottleUrl({ os, a }).catch(() => null) : null;
  const assets = platformAssets();
  let lastErr = null;
  let usedAsset = null;

  for (let ai = 0; ai < assets.length && usedAsset === null; ai++) {
    const asset = assets[ai];
    const sources = [];
    if (bottle && asset.endsWith('.tgz')) {
      sources.push({ url: bottle, host: 'mirrors.tuna.tsinghua.edu.cn' });
    }
    for (const m of CLOUDFLARED_MIRRORS) sources.push({ url: m(asset), host: hostOf(m(asset)) });

    for (let i = 0; i < sources.length; i++) {
      if (callerSignal?.aborted) throw new Error('下载已取消');
      const { url, host } = sources[i];
      console.log(`⬇️  下载 cloudflared（${asset}，国内加速源 ${i + 1}/${sources.length}：${host}）…`);
      
      // 每个源独立 25 秒超时，绝不级联 abort 全局！
      const perSourceSignal = callerSignal
        ? AbortSignal.any([callerSignal, AbortSignal.timeout(25_000)])
        : AbortSignal.timeout(25_000);

      try {
        await downloadFile(url, tmpFile, { signal: perSourceSignal });
        const st = await stat(tmpFile);
        if (st.size < 1024 * 1024) throw new Error(`文件异常小（${st.size} 字节），可能非二进制`);
        usedAsset = asset;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await rm(tmpFile, { force: true }).catch(() => {});
        console.warn(`  ⚠️ 源 ${i + 1} (${host}) 失败：${err?.message ?? err}，迅速尝试下一个镜像…`);
      }
    }
  }

  if (usedAsset === null) {
    throw new Error(
      `cloudflared 自动下载失败：所有加速源均未能连通（${lastErr?.message ?? lastErr}）。`
      + (isWindows
        ? `请将 cloudflared.exe 复制到 ${dir} 目录后重试，或直接使用「固定公网通道」`
        : `请在 settings.json 中配置 "cloudflaredPath"，或直接使用「固定公网通道」`),
    );
  }

  let extracted = join(dir, `cloudflared${ext}`);
  if (!usedAsset.endsWith('.tgz')) {
    await rename(tmpFile, extracted).catch(async () => {
      await cp(tmpFile, extracted).catch(() => {});
    });
  } else {
    const extractDir = join(dir, `.extract-${process.pid}-${Date.now()}`);
    await mkdir(extractDir, { recursive: true });
    try {
      await new Promise((resolve, reject) => {
        const child = spawn('tar', ['-xzf', tmpFile, '-C', extractDir], { stdio: 'ignore' });
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`解压失败（code=${code}）`)));
        child.once('error', reject);
      });
      const direct = join(extractDir, `cloudflared${ext}`);
      let found = null;
      try { if ((await stat(direct)).isFile()) found = direct; } catch { /* 继续 */ }
      if (!found) throw new Error('解压后未找到二进制');
      await rename(found, extracted).catch(async () => { await cp(found, extracted).catch(() => {}); });
    } finally {
      await rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (!isWindows) await chmod(extracted, 0o755);
  await rm(tmpFile, { force: true }).catch(() => {});
  return extracted;
}

function cloudflaredOnPath() {
  try {
    execSync(process.platform === 'win32' ? 'where cloudflared' : 'command -v cloudflared', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let downloading = null;

/**
 * 智能解析可用的 cloudflared 二进制路径（本地优先，零下载秒开）。
 */
export async function resolveCloudflared({ home, onPhase = () => {}, signal } = {}) {
  // 1. 显式环境变量
  const explicit = process.env.DSH_ANYWHERE_CLOUDFLARED ?? process.env.DSH_ANYWHERE_CLOUDFLARED;
  if (explicit) {
    try {
      await access(explicit);
      return explicit;
    } catch { /* 路径不可读，继续回退 */ }
  }

  // 2. 本地包内自带的二进制（E:\desktop\所有skill\packages\dsh-anywhere\bin\cloudflared.exe）
  const { os, a, ext } = platformBinary();
  const bundledBin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', `cloudflared${ext}`);
  try {
    await access(bundledBin);
    return bundledBin;
  } catch { /* 忽略 */ }

  // 3. 系统 PATH
  if (cloudflaredOnPath()) return 'cloudflared';

  // 4. 历史缓存目录与本地目录
  const dshHome = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const candidates = [
    join(dshHome, 'dsh-anywhere', 'bin', `cloudflared${ext}`),
    join(dshHome, 'dsh-anywhere', 'bin', `cloudflared${ext}`),
    join(dshHome, 'dsh-anywhere', 'bin', `cloudflared-${os}-${a}${ext}`),
  ];

  for (const bin of candidates) {
    try {
      await access(bin);
      return bin;
    } catch { /* 继续 */ }
  }

  // 5. 必须在线下载（极速国内镜像）
  onPhase('downloading');
  const targetDir = join(dshHome, 'dsh-anywhere', 'bin');
  await mkdir(targetDir, { recursive: true });
  if (!downloading) {
    downloading = downloadCloudflared(join(targetDir, `cloudflared${ext}`), signal).finally(() => { downloading = null; });
  }
  return downloading;
}

function forceKillChild(child) {
  if (!child) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      execSync(`taskkill /F /PID ${child.pid} /T`, { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try { child.kill(); } catch { /* 忽略 */ }
  }
}

export async function startNamedTunnel({ token, home, signal, onPhase = () => {} }) {
  const bin = await resolveCloudflared({ home, onPhase, signal });
  onPhase('starting');
  const child = spawn(bin, ['--no-autoupdate', 'tunnel', 'run', '--protocol', 'http2'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TUNNEL_TOKEN: String(token ?? '') },
  });
  let cleanup = null;
  let rejectErr = null;

  child.on('error', (err) => {
    cleanup?.();
    onPhase?.('error');
    rejectErr?.(new Error(`cloudflared 启动失败：${err?.message ?? err}`));
  });
  onPhase('registering');

  await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += String(chunk);
      if (/Registered tunnel connection/i.test(buf)) {
        cleanup();
        onPhase('ready');
        resolve();
      }
    };
    const onExit = (code) => {
      cleanup();
      const tail = firstMeaningfulErrorLine(buf);
      reject(new Error(`cloudflared 退出（code=${code}）${tail ? '：' + tail : ''}`));
    };
    cleanup = () => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.stdout.resume();
      child.stderr.resume();
    };
    const onAbort = () => {
      cleanup();
      forceKillChild(child);
      reject(new Error('已取消'));
    };
    const timer = setTimeout(() => {
      cleanup();
      forceKillChild(child);
      reject(new Error('cloudflared 启动超时（30s）——请检查网络连接或 Token 是否有效'));
    }, 30_000);

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    rejectErr = reject;
  });

  const exitListeners = new Set();
  child.on('exit', (code) => {
    for (const cb of exitListeners) cb(code);
  });

  return {
    url: null,
    kill: () => forceKillChild(child),
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
  };
}

export async function startQuickTunnel({ port, home, signal, onPhase = () => {} }) {
  const bin = await resolveCloudflared({ home, onPhase, signal });
  onPhase('starting');
  const child = spawn(bin, ['--no-autoupdate', 'tunnel', '--url', `http://127.0.0.1:${port}`, '--protocol', 'http2'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.on('error', (err) => {
    cleanup?.();
    onPhase?.('error');
    rejectErr?.(new Error(`cloudflared 启动失败：${err?.message ?? err}`));
  });
  onPhase('registering');

  let cleanup = null;
  let rejectErr = null;
  const url = await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += String(chunk);
      const m = buf.match(QUICK_TUNNEL_URL_RE);
      if (m) {
        cleanup();
        onPhase('ready');
        resolve(m[0]);
      }
    };
    const onExit = (code) => {
      cleanup();
      const tail = firstMeaningfulErrorLine(buf);
      reject(new Error(`cloudflared 退出（code=${code}）${tail ? '：' + tail : ''}`));
    };
    cleanup = () => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.stdout.resume();
      child.stderr.resume();
    };
    const onAbort = () => {
      cleanup();
      forceKillChild(child);
      reject(new Error('已取消'));
    };
    const timer = setTimeout(() => {
      cleanup();
      forceKillChild(child);
      reject(new Error('cloudflared 快速隧道连接超时（30s）——Cloudflare 边缘节点可能受阻，建议改用「固定公网通道」'));
    }, 30_000);

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    rejectErr = reject;
  });

  const exitListeners = new Set();
  child.on('exit', (code) => {
    for (const cb of exitListeners) cb(code);
  });

  return {
    url,
    kill: () => forceKillChild(child),
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
  };
}
