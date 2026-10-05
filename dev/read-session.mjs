import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const file = process.argv[2];
let text;
try {
  text = zstdDecompressSync(readFileSync(file)).toString('utf8');
} catch (err) {
  console.log('解压失败:', err.message);
  process.exit(1);
}
const lines = text.split('\n').filter(Boolean);
console.log('事件数:', lines.length);
console.log('--- 最后 16 条 ---');
for (const line of lines.slice(-16)) {
  try {
    const e = JSON.parse(line);
    console.log(String(e.type).padEnd(24), JSON.stringify(e.data ?? {}).slice(0, 190));
  } catch {
    console.log('raw:', line.slice(0, 150));
  }
}