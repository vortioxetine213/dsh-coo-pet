/**
 * 只读地翻 Electron 的 asar 归档(开发调研用)。
 *
 * DSH 的实现打包在 `D:\dsh\resources\app.asar` 里,普通文件 API 读不到它,
 * 但 asar 的格式很简单:八字节前缀 + header pickle(里面是一份 JSON 目录) + 数据区,
 * 所以这里按目录索引把单个文件读出来。**只读,不写不改。**
 *
 * 用法:
 *   node dev/asar.mjs list <asar> <目录>         # 列一层
 *   node dev/asar.mjs find <asar> <关键字>       # 按路径子串找(最多 40 条)
 *   node dev/asar.mjs cat  <asar> <文件路径>     # 打印文件
 */
import { closeSync, openSync, readSync } from 'node:fs';

function readIndex(asarPath) {
  const fd = openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const headerPickleSize = head.readUInt32LE(4);
    const jsonSize = head.readUInt32LE(8);
    const jsonBuf = Buffer.alloc(jsonSize);
    readSync(fd, jsonBuf, 0, jsonSize, 12);
    return { index: JSON.parse(jsonBuf.toString('utf8')), dataStart: 8 + headerPickleSize };
  } finally {
    closeSync(fd);
  }
}

function walk(index, p) {
  let node = index;
  for (const part of p.split('/').filter(Boolean)) {
    node = node?.files?.[part];
    if (!node) return null;
  }
  return node;
}

function readFileAt(asarPath, dataStart, node) {
  const fd = openSync(asarPath, 'r');
  try {
    const buf = Buffer.alloc(Number(node.size));
    readSync(fd, buf, 0, buf.length, dataStart + Number(node.offset));
    return buf;
  } finally {
    closeSync(fd);
  }
}

function* allPaths(node, prefix = '') {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = `${prefix}/${name}`;
    if (child.files) yield* allPaths(child, p);
    else yield p;
  }
}

const [cmd, asar, target] = process.argv.slice(2);
if (!cmd || !asar) {
  console.error('用法: node dev/asar.mjs list|find|cat <asar> <参数>');
  process.exit(1);
}
const { index, dataStart } = readIndex(asar);

if (cmd === 'list') {
  const node = walk(index, target ?? '/');
  if (!node) {
    console.error('没有这个目录');
    process.exit(1);
  }
  for (const [name, child] of Object.entries(node.files ?? {})) {
    console.log(`${child.files ? 'd' : 'f'}  ${name}${child.files ? '' : `  (${child.size})`}`);
  }
} else if (cmd === 'find') {
  const needle = String(target ?? '').toLowerCase();
  let n = 0;
  for (const p of allPaths(index)) {
    if (p.toLowerCase().includes(needle)) {
      console.log(p);
      if (++n >= 40) {
        console.log('…(还有更多)');
        break;
      }
    }
  }
  if (!n) console.log('没找到');
} else if (cmd === 'cat') {
  const node = walk(index, target);
  if (!node || node.files) {
    console.error('没有这个文件');
    process.exit(1);
  }
  process.stdout.write(readFileAt(asar, dataStart, node));
} else {
  console.error(`不认识的命令:${cmd}`);
  process.exit(1);
}
