// test-disk-install.mjs — 验证自定义盘符安装/卸载（用户报障回归）
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

const SETUP = 'C:/Users/11797/AppData/Local/Temp/ZP53-Setup.exe';
const REGKEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZCodeProxy';
const log = (...a) => console.log('[t]', ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 0. 清理：停应用 + 删注册表（模拟全新机器）
spawnSync('taskkill', ['/F', '/IM', 'ZCodeProxy.exe'], { stdio: 'ignore' });
spawnSync('reg', ['delete', REGKEY, '/f'], { stdio: 'ignore' });

// 1. 全新 + /D 指定 D 盘
let r = spawnSync(SETUP, ['/S', '/D=D:\\ZCodeProxyTest'], { timeout: 600000 });
log('安装 exit:', r.status);
await wait(15000);
log('✅ D 盘安装:', existsSync('D:/ZCodeProxyTest/ZCodeProxy.exe'));
r = spawnSync('reg', ['query', REGKEY, '/v', 'InstallDir'], { encoding: 'utf8' });
log('注册表 InstallDir:', (r.stdout || '').split('\n').filter((l) => l.includes('REG_SZ')).join('').trim());

// 2. 卸载 → 校验：除 config.json 外全部删除 + 注册表清除
r = spawnSync('D:/ZCodeProxyTest/Uninstall.exe', ['/S'], { timeout: 600000 });
log('卸载 exit:', r.status);
await wait(30000);
const leftover = [];
try {
  for (const f of readdirSync('D:/ZCodeProxyTest')) {
    if (f === 'resources') { // resources/app/config.json = 按设计保留的用户配置
      const inner = readdirSync('D:/ZCodeProxyTest/resources/app');
      if (inner.length === 1 && inner[0] === 'config.json') continue;
    }
    leftover.push(f);
  }
} catch { /* 目录不存在 */ }
log('卸载后残留:', leftover.length ? leftover.join(',') : '（无）');
const cfgKept = existsSync('D:/ZCodeProxyTest/resources/app/config.json');
log('用户配置已保留:', cfgKept);
r = spawnSync('reg', ['query', REGKEY], { encoding: 'utf8' });
log('注册表已清:', !(r.stdout || '').includes('DisplayName'));

// 3. 结论
const pass = leftover.length === 0 && cfgKept && !(r.stdout || '').includes('DisplayName');
log(pass ? '✅ D 盘安装/卸载周期全部符合预期' : '❌ 存在问题');
process.exit(pass ? 0 : 1);
