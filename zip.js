/**
 * dsh-waifu-agents — a ZIP writer, and nothing else.
 *
 * Why this file exists: the panel used to export a batch by firing one download
 * per persona. A batch of twelve therefore opened twelve save dialogs and could
 * scatter the files across twelve different folders — the same gesture, twelve
 * times, with no way to say "all of them, here". One archive is one dialog and
 * one destination; the browser cannot be told a folder, so the folder has to be
 * implied by a single file.
 *
 * No dependency is added for this. The manifest declares exactly one runtime
 * dependency (`@deepseek-ai/schemastery`) and the plugin manager will happily
 * install anything that is listed — but a zip is ~110 lines of well-specified
 * byte layout, and `node:zlib` is already there for the compression. Keeping it
 * local also keeps it testable: `buildZip` is a pure function over buffers, so
 * `selftest-v3.mjs` can round-trip it without a host, a browser or a DOM.
 *
 * Only the subset a file archive needs is implemented:
 *   - STORE (method 0) and DEFLATE (method 8), chosen per entry by whichever is
 *     smaller — a 300-byte persona is bigger after deflating, a 40 KB one is not
 *   - UTF-8 names (general-purpose flag bit 11), because a persona id may be
 *     Chinese (`后藤一里.md`) and a legacy CP437 reader would mangle it
 *   - no comments, no extra fields, no ZIP64, no encryption, no directories
 * Every limit that follows from that is real: an entry name longer than 65535
 * bytes or an archive over 4 GiB is refused rather than silently truncated.
 */
import zlib from "node:zlib";

/** RFC 1952's CRC-32, the one ZIP uses. Table built once, at load. */
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

/** CRC of one buffer. `0` for empty input, which is what ZIP stores. */
export function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** MS-DOS packed date/time, local time, clamped to the format's 1980 floor. */
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
 * Build a ZIP from `[{ name, data }]`.
 *
 * `data` may be a Buffer or a string (UTF-8). Names are taken as given; the
 * caller decides the folder layout, and a plain flat archive is the point here.
 * `options.date` fixes the timestamp for every entry — tests pass one, the host
 * passes `new Date()`.
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
     * Deflate, but only keep it when it actually helped. A one-paragraph persona
     * grows by a few bytes under deflate, and a store-only entry is also what
     * makes a corrupt-but-readable archive possible for anything hand-inspected.
     */
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.day, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
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
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20); // archive comment

  return Buffer.concat([...locals, centralBuffer, end]);
}

/**
 * Read back what `buildZip` wrote — used by the self-test only, and deliberately
 * strict: it validates the central directory against the local headers instead
 * of trusting one of them, so a writer bug cannot pass by being consistent with
 * itself.
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
