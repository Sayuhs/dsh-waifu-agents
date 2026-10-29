import fs from "node:fs";
import path from "node:path";

/**
 * 人设目录里"属于插件、不属于用户"的那几个文件。
 *
 * 每次升级都要跟着版本走：骨架是提示词的一部分，包里的规则改了而用户目录还
 * 停在上一版，等于同一份插件在不同机器上跑出两套行为，问题也就无从复现。
 * 人设 `*.md`、`persona-memory/`、`teams.json`、`overrides`、`mode.json` 都
 * 不在这个名单里——那些是用户的，一个字节都不动。
 */
export const ASSET_FILES = ["_common.md", "README.md"];

/**
 * 播种标记。记着"这个目录是插件建的"以及上一版写下去的资产指纹。
 *
 * 没有它，插件无法区分"用户自己挑的目录"和"我们播种出来的目录"：前者往里
 * 放 README 和骨架是侵入，后者不更新就是失职。它也是个 `.json`，所以
 * `listFiles()` 的 `*.md` 过滤不会把它当成人设列出来。
 */
export const SEED_MARKER = "_seed.json";

/** 读文本，读不到就是 `null`——不存在与读不出在这里是同一件事。 */
function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * 先写暂存再 `rename`：升级中途断电不该留下半份骨架。
 *
 * 与 `index.js` 里的 `writeAtomic` 同一套理由，只是这里不能依赖那边——
 * 这个模块要能被单独的测试拿着临时目录跑。
 */
function writeAtomic(file, text) {
  const stage = `${file}.stage-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(stage, text, "utf8");
    fs.renameSync(stage, file);
  } catch (error) {
    try {
      fs.rmSync(stage, { force: true });
    } catch {
      /* 留下一个零散暂存文件好过让升级失败 */
    }
    throw error;
  }
}

/** `20261029T192500`——本地时间，直接可读，排序也正确。 */
export function stampOf(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function readMarker(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return null;
    if (parsed.seededBy !== "dsh-waifu-agents") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 这个目录是不是插件播种出来的？
 *
 * 两种证据，按强弱排：
 * 1. 有播种标记（插件自己写的，最硬）。
 * 2. `README.md` 与包里那份逐字节相同——旧版本播种过、那时还没有标记。
 *    用户自己建的目录几乎不可能恰好带着我们这份说明，所以这条足够安全。
 *
 * 其余一律当作"用户的目录"：不写资产、也不留标记。
 */
export function looksSeeded(dir, packageDir) {
  if (readMarker(path.join(dir, SEED_MARKER)) !== null) return "marker";
  const shipped = readText(path.join(packageDir, "personas", "README.md"));
  const local = readText(path.join(dir, "README.md"));
  if (shipped !== null && local !== null && shipped === local) return "readme";
  return null;
}

/**
 * 把插件资产刷到当前版本。
 *
 * - 用户目录（不是我们播种的）→ 什么都不做。
 * - 资产缺失 → 从包里补回来（用户删了不该等于永久失去）。
 * - 资产与包里一致 → 无事可做。
 * - 资产与包里不同 → **整份换成包里的**，旧内容先另存为
 *   `<文件名>.bak-<时间戳>`。这是"全量更新"与"不丢用户改动"同时成立的
 *   唯一做法：新版生效，但原来的东西还在旁边，可查可回滚。
 *
 * 人设文件与记忆数据不在 `ASSET_FILES` 里，因此永远不会被这个函数碰到。
 *
 * @param {{ dir: string, packageDir: string, version?: string, now?: Date }} options
 * @returns {{ ok: boolean, owner: 'marker' | 'readme' | null, written: string[], backedUp: string[], kept: string[], error?: string }}
 */
export function refreshAssets(options) {
  const { dir, packageDir, version = "", now = new Date() } = options;
  const result = {
    ok: false,
    owner: null,
    written: [],
    backedUp: [],
    kept: [],
  };
  const owner = looksSeeded(dir, packageDir);
  if (owner === null) return { ...result, ok: true };
  result.owner = owner;

  /*
   * 目录不存在就当无事发生。`looksSeeded` 已经排除了这种情况（标记读不到、
   * README 也读不到），但把它写在这儿是给调用方一个不必先 stat 的保证——
   * 这个函数只负责刷资产，不负责建目录；建目录是 `seedInto` 的事。
   */
  try {
    if (!fs.statSync(dir).isDirectory()) return { ...result, ok: true };
  } catch {
    return { ...result, ok: true };
  }

  const markerFile = path.join(dir, SEED_MARKER);
  const assets = {};
  const stamp = stampOf(now);
  try {
    for (const name of ASSET_FILES) {
      const shipped = readText(path.join(packageDir, "personas", name));
      if (shipped === null) continue;
      const target = path.join(dir, name);
      const current = readText(target);
      if (current === shipped) {
        assets[name] = "same";
        continue;
      }
      if (current !== null) {
        const backup = `${name}.bak-${stamp}`;
        writeAtomic(path.join(dir, backup), current);
        result.backedUp.push(backup);
      }
      writeAtomic(target, shipped);
      result.written.push(name);
      assets[name] = "shipped";
    }
    writeAtomic(
      markerFile,
      `${JSON.stringify(
        {
          seededBy: "dsh-waifu-agents",
          version,
          updatedAt: now.toISOString(),
          assets,
        },
        null,
        2,
      )}\n`,
    );
    return { ...result, ok: true };
  } catch (error) {
    return { ...result, ok: false, error: error?.message ?? String(error) };
  }
}
