// kill-orphan-engines.mjs — 清理遗留的 zcode app-server 引擎进程（不碰桌面版自身的 ZCode.exe）
import { execSync } from 'node:child_process';

const ps = `Get-CimInstance Win32_Process -Filter "Name='ZCode.exe'" | Where-Object { $_.CommandLine -like '*app-server*' } | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine.Substring(0,[Math]::Min(100,$_.CommandLine.Length)))" }`;
const encoded = Buffer.from(ps, 'utf16le').toString('base64');
let out = '';
try {
  out = execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { encoding: 'utf8' });
} catch (e) {
  console.error('枚举失败:', e.message.slice(0, 150));
  process.exit(1);
}
let killed = 0;
for (const line of out.split(/\r?\n/)) {
  if (!line.trim()) continue;
  const pid = line.split('|')[0].trim();
  if (!/^\d+$/.test(pid)) continue;
  console.log('杀掉引擎 PID', pid, '←', line.split('|')[1]);
  try { execSync(`taskkill /PID ${pid} /F`); killed += 1; } catch { /* ignore */ }
}
console.log('共清理', killed, '个孤儿引擎进程');
