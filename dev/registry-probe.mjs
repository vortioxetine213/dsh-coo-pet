import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const PET_PKG = join('resources', 'app', 'node_modules', 'cortico-world-desktop-pet');
const found = [];
for (const hive of ['HKCU', 'HKLM']) {
  const key = `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`;
  try {
    const text = execFileSync('reg', ['query', key, '/s', '/f', 'Coopanion'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:InstallLocation|DisplayIcon)\s+REG_\w+\s+(.+?)\s*$/i);
      if (!m) continue;
      found.push(m[1].replace(/^"|"$/g, '').replace(/,\d+$/, '').replace(/\\[^\\]+\.exe$/i, ''));
    }
  } catch {}
}
console.log('注册表给的位置:', JSON.stringify(found));
for (const c of found) {
  console.log(' ', c, '→ 素材在吗:', existsSync(join(c, PET_PKG, 'web', 'pet.html')));
}