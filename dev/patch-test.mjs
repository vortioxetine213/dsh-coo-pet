/**
 * 拿本机装的 Coopanion 里的真实 `pet-app.js` 试打一遍补丁。
 *
 * 用来回答两个问题:三个补丁现在还打得上吗?打完的代码语法还是对的吗?
 * (Coopanion 升级后锚点可能失效,这个脚本就是给它体检的。)
 *
 *   node dev/patch-test.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCooRoot, patchPetApp, PET_PKG } from '../lib/assets.mjs';

const root = findCooRoot();
if (!root) {
  console.error('找不到 Coopanion 的安装目录');
  process.exit(1);
}
const src = join(root, PET_PKG, 'web', 'pet-app.js');
const original = readFileSync(src, 'utf8');
const { text, notes } = patchPetApp(original);

console.log(`源文件: ${src}`);
console.log(`字节: ${original.length} → ${text.length}`);
for (const note of notes) {
  const mark = note.endsWith('已打上') ? '✅' : note.endsWith('已有') ? '·' : '⚠️';
  console.log(`  ${mark} ${note}`);
}

const out = fileURLToPath(new URL('./patch-test.out.js', import.meta.url));
writeFileSync(out, text);
console.log(`打过补丁的版本写出: ${out}(用 node --check 验语法)`);
