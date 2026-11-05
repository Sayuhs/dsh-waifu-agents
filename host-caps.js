/**
 * 宿主能力探测与死行自愈（host capability probe & dead-row pruning）。
 *
 * `template.json` 的每个工具行都指向宿主（或 profile 依赖目录）里的一个
 * cordis 插件包。宿主升级一旦改名、挪包或删掉子路径导出，模板里的死行会让
 * `dsh-agent-preset-registry` 的 `auditRows` 把整条预设报成激活失败——
 * 每一份人设都会炸，而插件作者只能在真机上追着宿主版本一条条对。
 *
 * 这里的修法是 **在运行时对着当前宿主探测**：加载模板时逐一确认每个启用的
 * 行名能否在宿主模块根里找到；确认找不到的行自动补上 `disabled: true`。
 * 宿主把行报成「有意停用」而不是「导入失败」，预设照常激活，用户少的工具
 * 只是安静地缺席。模板文件本身不动盘——哪天宿主又把包加回来了，行会自己
 * 活过来。
 *
 * 探测只认 **正面证据**：只有当至少一个模块根里能看到锚点包
 * `@deepseek-ai/dsh-agent-preset`（本插件赖以运行的服务，宿主必带）时才
 * 允许判死。找不到根、找不到锚点、或包存在但子路径无法判定（无 `exports`
 * 字段）时一律放行——宁可多带一行等宿主报错，也绝不误杀整套工具集。
 *
 * 模块根按现在的宿主布局收：
 *  - `<resources>/app.asar`（Electron 桌面宿主；自带微型 asar 索引器，
 *    不依赖 Electron 的 fs 补丁，纯 node 也能读）
 *  - `<resources>/app.asar.unpacked`
 *  - 本插件所在的 node_modules 目录（profile 依赖，如 `@deepseek-ai/cosmokit`）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 判死依据的锚点包：宿主运行本插件就必然提供它。 */
const ANCHOR = "@deepseek-ai/dsh-agent-preset";

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 探测结论缓存：null = 尚未探测；否则 { usable, packages: Map<pkg, {kind, root, file?}> } */
let probeCache = null;

/**
 * 微型 asar 索引器：解析文件头里的目录树，返回
 * `{ files: 内部路径 -> { offset, size }, base: 数据区起始偏移 }`。
 * 只用普通文件读，不依赖 Electron 的 asar fs 补丁；解析失败返回 null。
 * @param {string} asarPath
 * @returns {{ files: Map<string, { offset: number, size: number }>, base: number } | null}
 */
function asarIndex(asarPath) {
  let fd;
  try {
    fd = fs.openSync(asarPath, "r");
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) !== 16) return null;
    const headerSize = head.readUInt32LE(12);
    if (!Number.isInteger(headerSize) || headerSize <= 0 || headerSize > 64 * 1024 * 1024)
      return null;
    const buf = Buffer.alloc(headerSize);
    if (fs.readSync(fd, buf, 0, headerSize, 16) !== headerSize) return null;
    const text = buf.toString("utf8");
    const start = text.indexOf("{");
    if (start < 0) return null;
    const header = JSON.parse(text.slice(start));
    const files = new Map();
    (function walk(node, parts) {
      if (node !== null && typeof node === "object" && node.files) {
        for (const key of Object.keys(node.files)) walk(node.files[key], parts.concat(key));
      } else if (node !== null && typeof node === "object" && node.offset !== undefined) {
        const offset = Number(node.offset);
        if (Number.isFinite(offset) && node.size > 0)
          files.set(parts.join("/"), { offset, size: node.size });
      }
    })(header, []);
    return { files, base: 16 + headerSize };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // 已尽力关闭
      }
    }
  }
}

/**
 * 从包名定位它在各模块根里的落点。
 *
 * asar 根里同时存在 `dsh/node_modules/...` 与顶层 `node_modules/...` 两种
 * 布局，所以按「任意 node_modules 段之后的剩余路径」匹配，而不是写死前缀。
 * @param {Map<string, { offset: number, size: number }>} files
 * @param {string} pkg
 * @returns {{ file: string, entry: { offset: number, size: number } } | null}
 */
function asarPackage(files, pkg) {
  const suffix = `/${pkg}/package.json`;
  for (const [file, entry] of files) {
    if (file.endsWith(suffix) && file.includes("/node_modules/")) return { file, entry };
  }
  return null;
}

/**
 * 收集可用的模块根。找不到任何根、或根里看不到锚点包时返回
 * `{ usable: false }`——探测放行，模板原样使用。
 * @returns {{ usable: boolean, packages: Map<string, { kind: "asar" | "dir", root: string, file: string, entry?: { offset: number, size: number } }> }}
 */
function discover() {
  if (probeCache !== null) return probeCache;
  const packages = new Map();
  /** @type {{ kind: "asar", root: string, files: Map<string, { offset: number, size: number }>, base: number }[]} */
  const asars = [];
  /** @type {{ kind: "dir", root: string }[]} */
  const dirs = [];

  const resourceDirs = [];
  if (typeof process !== "undefined" && typeof process.resourcesPath === "string" && process.resourcesPath !== "")
    resourceDirs.push(process.resourcesPath);
  if (typeof process !== "undefined" && typeof process.execPath === "string" && path.basename(path.dirname(process.execPath)) !== "node_modules") {
    // 普通 node 进程（自测）时 execPath 指向 node.exe，拼出来的目录多半不存在，
    // 由 existsSync 挡掉；Electron 主进程里这就是 resources 目录。
    resourceDirs.push(path.join(path.dirname(process.execPath), "resources"));
  }

  for (const res of resourceDirs) {
    const asar = path.join(res, "app.asar");
    if (fs.existsSync(asar)) {
      const index = asarIndex(asar);
      if (index !== null) asars.push({ kind: "asar", root: asar, ...index });
    }
    const unpacked = path.join(res, "app.asar.unpacked");
    if (fs.existsSync(unpacked)) dirs.push({ kind: "dir", root: unpacked });
  }
  // 本插件所在的 node_modules 目录（真实安装时是 profile 依赖目录）。
  const siblings = path.resolve(PLUGIN_DIR, "..");
  if (path.basename(siblings) === "node_modules" && fs.existsSync(siblings))
    dirs.push({ kind: "dir", root: siblings });

  let anchorSeen = false;
  const readPackageJson = (hit) => {
    try {
      if (hit.kind === "asar") {
        const raw = Buffer.alloc(hit.entry.size);
        const fd = fs.openSync(hit.root, "r");
        try {
          fs.readSync(fd, raw, 0, hit.entry.size, hit.base + hit.entry.offset);
        } finally {
          fs.closeSync(fd);
        }
        return JSON.parse(raw.toString("utf8"));
      }
      return JSON.parse(fs.readFileSync(hit.file, "utf8"));
    } catch {
      return null;
    }
  };

  const noteDirPkg = (dirRoot, pkg) => {
    const file = path.join(dirRoot, pkg, "package.json");
    if (fs.existsSync(file)) {
      packages.set(pkg, { kind: "dir", root: dirRoot, file });
      return true;
    }
    return false;
  };

  const probe = (pkg) => {
    if (packages.has(pkg)) return packages.get(pkg);
    for (const asar of asars) {
      const hit = asarPackage(asar.files, pkg);
      if (hit !== null) {
        const found = { kind: "asar", root: asar.root, file: hit.file, entry: hit.entry, base: asar.base };
        packages.set(pkg, found);
        if (pkg === ANCHOR) anchorSeen = true;
        return found;
      }
    }
    for (const dir of dirs) {
      if (noteDirPkg(dir.root, pkg)) {
        if (pkg === ANCHOR) anchorSeen = true;
        return packages.get(pkg);
      }
    }
    return null;
  };

  // 先只探锚点：看不到锚点的环境（自测、异构宿主）整体放行，不做任何判死。
  probe(ANCHOR);
  probeCache = { usable: anchorSeen, packages, probe, readPackageJson };
  return probeCache;
}

/**
 * 拆行名：`@scope/pkg/sub/path` → 包 `@scope/pkg` + 子路径 `./sub/path`；
 * `pkg/sub` → 包 `pkg` + 子路径 `./sub`；裸包名没有子路径。
 * @param {string} name
 * @returns {{ pkg: string, sub: string | null } | null}
 */
export function splitPluginName(name) {
  if (typeof name !== "string" || name === "" || name.startsWith("cordis:")) return null;
  const segments = name.split("/");
  if (name.startsWith("@")) {
    if (segments.length < 2) return null;
    return { pkg: segments.slice(0, 2).join("/"), sub: segments.length > 2 ? `./${segments.slice(2).join("/")}` : null };
  }
  if (segments.length < 1 || segments[0] === "") return null;
  return { pkg: segments[0], sub: segments.length > 1 ? `./${segments.slice(1).join("/")}` : null };
}

/**
 * 子路径是否被包的 `exports` 字段放行。
 * 严格按 npm 语义近似：精确键命中，或通配键（`*`）模式命中。
 * 无 `exports` 字段时返回 null（无法判定，放行）。
 * @param {Record<string, unknown> | undefined} exportsField
 * @param {string} sub
 * @returns {boolean | null}
 */
export function exportsAllow(exportsField, sub) {
  if (exportsField === undefined || exportsField === null || typeof exportsField !== "object")
    return null;
  if (Object.prototype.hasOwnProperty.call(exportsField, sub)) return true;
  for (const key of Object.keys(exportsField)) {
    if (!key.includes("*")) continue;
    const pattern = new RegExp(
      `^${key.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "(.*)")}$`,
    );
    if (pattern.test(sub)) return true;
  }
  return false;
}

/**
 * 探测一个行名在当前宿主里能否解析。返回 null 表示「无法判定，放行」。
 * @param {string} name
 * @returns {true | null} true = 确认死行
 */
export function isDeadPluginName(name) {
  const parsed = splitPluginName(name);
  if (parsed === null) return null;
  const state = discover();
  if (!state.usable) return null;
  const hit = state.probe(parsed.pkg);
  if (hit === null) return true; // 包在所有根里都不存在：确认死行
  if (parsed.sub === null) return null;
  const pkgJson = state.readPackageJson(hit);
  if (pkgJson === null) return null; // 读不到 package.json：无法判定
  return exportsAllow(pkgJson.exports, parsed.sub) === false ? true : null;
}

/**
 * 递归剪除模板里的死行：确认解析不了的启用行补 `disabled: true`。
 * 不改输入对象（需要停用时浅拷贝出新行）；`cordis:group` 与已停用行原样保留。
 * @param {unknown} rows
 * @param {{ isDead?: (name: string) => true | null }} [deps] 自测注入点
 * @returns {{ rows: unknown[], disabled: { id: string, name: string }[] }}
 */
export function pruneTemplateRows(rows, deps = {}) {
  const isDead = deps.isDead ?? isDeadPluginName;
  /** @type {{ id: string, name: string }[]} */
  const disabled = [];

  const walk = (list) =>
    list.map((row) => {
      if (row === null || typeof row !== "object") return row;
      const verdict = row.disabled === true ? null : isDead(row.name);
      if (verdict === true) {
        disabled.push({ id: String(row.id ?? ""), name: String(row.name ?? "") });
        return { ...row, disabled: true };
      }
      if (Array.isArray(row.config)) return { ...row, config: walk(row.config) };
      return row;
    });

  const next = Array.isArray(rows) ? walk(rows) : [];
  return { rows: next, disabled };
}

/** 最近一次剪除的记录（供诊断读取；空数组 = 没有判死任何行）。 */
let lastPrune = { at: 0, disabled: [] };

/**
 * 读模板后的统一入口：剪死行、记日志（同一行只警告一次）。
 * @param {unknown[]} rows
 * @returns {unknown[]}
 */
export function hostPrunedRows(rows) {
  const { rows: pruned, disabled } = pruneTemplateRows(rows);
  if (disabled.length > 0) {
    const fresh = disabled.filter(
      (row) => !lastPrune.disabled.some((old) => old.name === row.name && old.id === row.id),
    );
    for (const row of fresh) {
      console.warn(
        `dsh-waifu-agents: 宿主里解析不到能力行 ${row.id} (${row.name})，已自动停用，` +
          `预设不再因此激活失败。若宿主恢复该包，它会自动复活。`,
      );
    }
    lastPrune = { at: Date.now(), disabled };
  }
  return pruned;
}

/** 诊断读取：最近一次剪除了哪些行。 */
export function pruneReport() {
  return lastPrune;
}

/** 仅自测用：清空探测与报告缓存。 */
export function resetHostCapsForTest() {
  probeCache = null;
  lastPrune = { at: 0, disabled: [] };
}
