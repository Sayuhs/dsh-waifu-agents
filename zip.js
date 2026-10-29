/**
 * dsh-waifu-agents —— 一个 ZIP 写入器，仅此而已。
 *
 * 这个文件为什么存在：面板过去导出批量时给每个人设各发一次下载。一批十二个
 * 因此会弹出十二个保存对话框，还可能把文件散落到十二个不同文件夹 —— 同一个
 * 动作重复十二次，还没有办法说"全部都要，放这里"。一个压缩包就是一次对话框、
 * 一个目的地；浏览器没法被告知文件夹，所以文件夹只能由单个文件来暗示。
 *
 * 不为此新增任何依赖。manifest 只声明了一个运行时依赖
 * （`@deepseek-ai/schemastery`），插件管理器会很乐意装下列出的任何东西 ——
 * 但一个 zip 不过是约 110 行规定明确的字节布局，而 `node:zlib` 本来就在那儿
 * 管压缩。把它留在本地也让它可测：`buildZip` 是缓冲区上的纯函数，
 * `selftest-v3.mjs` 不需要宿主、浏览器或 DOM 就能往返验证它。
 *
 * 只实现了文件归档所需的子集：
 *   - STORE（方法 0）与 DEFLATE（方法 8），逐条目选更小的那个 —— 300 字节
 *     的人设压缩后反而更大，40 KB 的则不会
 *   - UTF-8 文件名（通用标志位 11），因为人设 id 可能是中文（`后藤一里.md`），
 *     老式 CP437 读取器会把它弄坏
 *   - 无注释、无附加字段、无 ZIP64、无加密、无目录
 * 由此带来的每条限制都是真的：条目名超过 65535 字节或压缩包超过 4 GiB 会被
 * 拒绝，而不是静默截断。
 */
import zlib from "node:zlib";

/** RFC 1952 的 CRC-32，也就是 ZIP 用的那个。表在加载时一次性构建。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** 一个缓冲区的 CRC。空输入得 `0`，ZIP 存的就是这个值。 */
export function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** MS-DOS 打包的日期/时间，本地时间，钳制到该格式 1980 年的下限。 */
function dosStamp(date) {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const MAX_UINT32 = 0xffffffff;
const MAX_UINT16 = 0xffff;

/**
 * 从 `[{ name, data }]` 构建一个 ZIP。
 *
 * `data` 可以是 Buffer 或字符串（UTF-8）。名字按原样采用；目录布局由调用方
 * 决定，这里要的就是一个纯平铺的压缩包。`options.date` 固定所有条目的时间戳
 * —— 测试传一个固定值，宿主传 `new Date()`。
 */
export function buildZip(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("zip: 没有要打包的文件");
  }
  if (entries.length > MAX_UINT16) {
    throw new Error(`zip: 一次最多 ${MAX_UINT16} 个文件`);
  }
  const date = options.date instanceof Date ? options.date : new Date();
  const stamp = dosStamp(date);

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = String(entry?.name ?? "");
    if (name === "") throw new Error("zip: 条目没有名字");
    const nameBytes = Buffer.from(name, "utf8");
    if (nameBytes.length > MAX_UINT16) throw new Error(`zip: 文件名太长：${name}`);
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ""), "utf8");
    if (raw.length > MAX_UINT32) throw new Error(`zip: 单个文件超过 4 GiB：${name}`);

    /*
     * 做 deflate，但只有真变小了才保留它。一段话的人设经过 deflate 会涨几个
     * 字节，而仅 store 的条目也正是让人工检视时能有一个"损坏但可读"压缩包的
     * 原因。
     */
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // 所需版本
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // 附加字段长度
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // 生成方版本
    central.writeUInt16LE(20, 6); // 所需版本
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.day, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // 附加字段
    central.writeUInt16LE(0, 32); // 注释
    central.writeUInt16LE(0, 34); // 磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + body.length;
    if (offset > MAX_UINT32) throw new Error("zip: 打包结果超过 4 GiB");
  }

  const centralBuffer = Buffer.concat(centrals);
  const centralOffset = offset;
  if (centralOffset + centralBuffer.length > MAX_UINT32) {
    throw new Error("zip: 打包结果超过 4 GiB");
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(0, 4); // 本磁盘
  end.writeUInt16LE(0, 6); // 中央目录所在磁盘
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20); // 压缩包注释

  return Buffer.concat([...locals, centralBuffer, end]);
}

/**
 * 读回 `buildZip` 写出的内容 —— 仅自测使用，且有意严格：它用本地头去校验
 * 中央目录，而不是信任其中任何一个，所以写入器的 bug 无法靠"自己和自己
 * 一致"蒙混过关。
 */
export function readZip(buffer) {
  const endAt = buffer.length - 22;
  if (endAt < 0 || buffer.readUInt32LE(endAt) !== SIG_END) throw new Error("zip: 没有找到 EOCD");
  const count = buffer.readUInt16LE(endAt + 10);
  const centralSize = buffer.readUInt32LE(endAt + 12);
  const centralAt = buffer.readUInt32LE(endAt + 16);
  if (centralAt + centralSize !== endAt) throw new Error("zip: 中央目录长度对不上");

  const files = [];
  let cursor = centralAt;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== SIG_CENTRAL) throw new Error("zip: 中央目录签名不对");
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const packed = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localAt = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    if (buffer.readUInt32LE(localAt) !== SIG_LOCAL) throw new Error(`zip: ${name} 的本地头签名不对`);
    const localNameLength = buffer.readUInt16LE(localAt + 26);
    const localExtraLength = buffer.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localNameLength + localExtraLength;
    const stored = buffer.subarray(dataAt, dataAt + packed);
    const data = method === METHOD_DEFLATE ? zlib.inflateRawSync(stored) : Buffer.from(stored);
    if (data.length !== size) throw new Error(`zip: ${name} 的长度对不上`);
    if (crc32(data) !== checksum) throw new Error(`zip: ${name} 的 CRC 对不上`);

    files.push({ name, data, method });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralAt + centralSize) throw new Error("zip: 中央目录没读完");
  return files;
}
