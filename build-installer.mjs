// build-installer.mjs — 一键编译 ZCodeProxy-Setup.exe
// 步骤：①vendor/node/node.exe（缺则复制本机 Node）
//       ②Electron 运行时（vendor/electron，缺则从 npmmirror 下载解压；electron.exe 改名 ZCodeProxy.exe）
//       ③布置 resources/app（后端 js + desktop 壳 + renderer）
//       ④makensis 编译 installer/zcode-proxy.nsi → ZCodeProxy-Setup.exe
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(ROOT, 'vendor');
const ELECTRON_VERSION = '31.7.7';
const log = (...a) => console.log('[build]', ...a);

// ① 便携 node.exe（CLI 回退用）
const nodeVendor = path.join(VENDOR, 'node', 'node.exe');
if (!existsSync(nodeVendor)) {
  const candidates = ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe'].filter(existsSync);
  if (!candidates.length) {
    console.error('[build] 未找到 node.exe 可复制。请安装 Node.js 或手动放置到 vendor/node/node.exe');
    process.exit(1);
  }
  mkdirSync(path.dirname(nodeVendor), { recursive: true });
  copyFileSync(candidates[0], nodeVendor);
  log(`已复制 node.exe: ${candidates[0]}`);
}

// ② Electron 运行时
const electronDir = path.join(VENDOR, 'electron');
const electronExe = path.join(electronDir, 'ZCodeProxy.exe');
if (!existsSync(electronExe)) {
  const zip = path.join(VENDOR, 'electron.zip');
  if (!existsSync(zip)) {
    log(`下载 Electron ${ELECTRON_VERSION}（npmmirror）...`);
    const r = await fetch(`https://npmmirror.com/mirrors/electron/${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-win32-x64.zip`, { redirect: 'follow' });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.slice(0, 2).toString() !== 'PK') throw new Error('下载内容不是 zip');
    writeFileSync(zip, buf);
    log(`已下载 ${(buf.length / 1048576).toFixed(1)}MB`);
  }
  log('解压 Electron...');
  const rr = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path "${zip}" -DestinationPath "${electronDir}" -Force`], { stdio: 'inherit' });
  if (rr.status !== 0 || !existsSync(path.join(electronDir, 'electron.exe'))) throw new Error('Electron 解压失败');
}
// 改名 electron.exe → ZCodeProxy.exe（保持版本文件原位）
if (existsSync(path.join(electronDir, 'electron.exe')) && !existsSync(electronExe)) {
  copyFileSync(path.join(electronDir, 'electron.exe'), electronExe);
  log('electron.exe → ZCodeProxy.exe');
}

// ③ 布置 resources/app（每次构建重建，保证最新）
const appDir = path.join(electronDir, 'resources', 'app');
rmSync(appDir, { recursive: true, force: true });
mkdirSync(path.join(appDir, 'desktop', 'renderer'), { recursive: true });
const backendFiles = ['server.js', 'engine.js', 'adapter.js', 'login-manager.js', 'account-manager.js', 'admin-ui.js', 'config.example.json'];
for (const f of backendFiles) copyFileSync(path.join(ROOT, f), path.join(appDir, f));
copyFileSync(path.join(ROOT, 'package.json'), path.join(appDir, 'package.json'));
copyFileSync(path.join(ROOT, 'desktop', 'main.js'), path.join(appDir, 'desktop', 'main.js'));
copyFileSync(path.join(ROOT, 'desktop', 'preload.js'), path.join(appDir, 'desktop', 'preload.js'));
copyFileSync(path.join(ROOT, 'desktop', 'renderer', 'index.html'), path.join(appDir, 'desktop', 'renderer', 'index.html'));
log('resources/app 已布置:', readdirSync(appDir).join(', '));

// ④ makensis（NSIS 编译器）：本地已有 → 直接用；否则自动获取（无需手动下载）
// 注意：electron-builder-binaries 的 3.0.5.0 精简版无法编译中文安装器（Bad text encoding），不可用
const NSIS_ZIP_VERSION = '3.10';
const toolsDir = path.join(ROOT, 'tools');

const makensisCandidates = [
  path.join(toolsDir, `nsis-${NSIS_ZIP_VERSION}`, 'makensis.exe'),
  'C:\\Program Files (x86)\\NSIS\\makensis.exe',
  'C:\\Program Files\\NSIS\\makensis.exe',
];
let makensis = makensisCandidates.find(existsSync);
if (!makensis) {
  log(`未找到 makensis，自动获取 NSIS ${NSIS_ZIP_VERSION} 完整版...`);
  mkdirSync(toolsDir, { recursive: true });

  // 自检脚本：含中文 + MUI，编译通过才算 makensis 可用（精简版发行包会在此暴露）
  const selfTestNsi = path.join(toolsDir, '_selftest.nsi');
  const selfTestExe = path.join(toolsDir, '_selftest.exe');
  writeFileSync(selfTestNsi, '\ufeffOutFile "' + selfTestExe.replace(/\\/g, '/') + '"\n!include "MUI2.nsh"\n!insertmacro MUI_PAGE_INSTFILES\n!insertmacro MUI_LANGUAGE "SimpChinese"\nSection "t"\n  DetailPrint "ok"\nSectionEnd\n', 'utf8');
  const selfTestOk = (mk) => {
    const r = spawnSync(mk, [selfTestNsi], { encoding: 'utf8', timeout: 120000 });
    try { if (existsSync(selfTestExe)) rmSync(selfTestExe, { force: true }); } catch {}
    return r.status === 0;
  };

  // 来源① SourceForge 官方 zip（3 次重试 × 2 个直链）
  if (!makensis) {
    try {
      const zipPath = path.join(toolsDir, `nsis-${NSIS_ZIP_VERSION}.zip`);
      if (!existsSync(zipPath)) {
        const urls = [
          `https://prdownloads.sourceforge.net/nsis/nsis-${NSIS_ZIP_VERSION}.zip?download`,
          `https://downloads.sourceforge.net/project/nsis/NSIS%203/${NSIS_ZIP_VERSION}/nsis-${NSIS_ZIP_VERSION}.zip`,
        ];
        let ok = false;
        for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
          for (const url of urls) {
            try {
              log(`下载（第 ${attempt} 次）${url.slice(0, 70)}...`);
              const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
              const buf = Buffer.from(await r.arrayBuffer());
              if (r.status !== 200 || buf.slice(0, 2).toString() !== 'PK' || buf.length < 1000000) {
                log(`候选源不可用（HTTP ${r.status}，${(buf.length / 1048576).toFixed(1)}MB）`);
                continue;
              }
              writeFileSync(zipPath, buf);
              log(`已下载 ${(buf.length / 1048576).toFixed(1)}MB`);
              ok = true;
              break;
            } catch (err) { log(`下载失败: ${err.message}`); }
          }
          if (!ok && attempt < 3) await new Promise((r) => setTimeout(r, 5000));
        }
        if (!ok) throw new Error('所有下载源均失败');
      }
      const rr = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path "${zipPath}" -DestinationPath "${toolsDir}" -Force`], { stdio: 'pipe', timeout: 180000 });
      makensis = makensisCandidates.find(existsSync);
      if (!makensis) throw new Error('解压失败');
      if (!selfTestOk(makensis)) throw new Error('makensis 自检未通过（无法编译中文脚本）');
    } catch (err) {
      log(`SourceForge zip 源失败: ${err.message}`);
    }
  }

  // 来源② winget 安装系统版 NSIS（可能弹出 UAC 提权确认）
  if (!makensis) {
    try {
      log('尝试通过 winget 安装 NSIS（如弹出 UAC 提权请确认）...');
      const rr = spawnSync('winget', ['install', 'NSIS.NSIS', '--accept-source-agreements', '--accept-package-agreements', '--silent'], { stdio: 'pipe', timeout: 600000, windowsHide: true });
      if (rr.status !== 0) throw new Error(`winget exit ${rr.status}`);
      makensis = makensisCandidates.find(existsSync);
      if (!makensis) throw new Error('安装后仍未找到 makensis');
      if (!selfTestOk(makensis)) throw new Error('makensis 自检未通过');
    } catch (err) {
      log(`winget 源失败: ${err.message}`);
    }
  }

  try { if (existsSync(selfTestNsi)) rmSync(selfTestNsi, { force: true }); } catch {}

  if (!makensis) {
    console.error('[build] 自动获取 NSIS 失败。请手动下载 nsis-3.10.zip 解压到 tools/ 目录，或安装系统版 NSIS。');
    process.exit(1);
  }
  log('makensis:', makensis);
}
// NSIS Unicode 脚本要求 UTF-8 BOM
const nsiPath = path.join(ROOT, 'installer', 'zcode-proxy.nsi');
{
  const fs = await import('node:fs');
  const raw = fs.readFileSync(nsiPath);
  const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  if (!hasBom) {
    fs.writeFileSync(nsiPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]));
    log('已为 .nsi 添加 UTF-8 BOM');
  }
}

const r = spawnSync(makensis, ['installer\\zcode-proxy.nsi'], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
if (r.status !== 0) {
  console.error('[build] 编译失败，退出码', r.status);
  process.exit(r.status ?? 1);
}
log('完成 → ' + path.join(ROOT, 'ZCodeProxy-Setup.exe'));
