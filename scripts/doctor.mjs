#!/usr/bin/env node
/*
 * 安装目录体检：判断这个目录「作为一个整体」是否自洽。
 *
 * 存在的理由是一次真实事故：把手写的 0.3.0 文件逐个覆盖进一个 0.2.4 的
 * `node_modules/dsh-waifu-agents` 之后，DSH 起不来。两种形态都会当场抛错，
 * 且都发生在插件加载阶段——宿主看不到「哪个文件新哪个文件旧」，只看到
 * import 失败：
 *
 *   1. 新 index.js 落进旧目录 → ERR_MODULE_NOT_FOUND（tool-filter.js 等
 *      10 个模块旧版本根本没有）。
 *   2. 只有一个旧模块混回来 → does not provide an export named 'renderSilence'。
 *
 * 逐文件的 sha 校验抓不到这两种：每个文件各自都是完整的，坏的是目录。
 * 所以这里查的是「目录」：静态 import 是否都能落下、与源码相比缺了谁、
 * 哪些文件内容对不上（= 混版本）。
 *
 * 用法：
 *   node scripts/doctor.mjs                      # 查默认安装副本
 *   node scripts/doctor.mjs <目录>                # 查指定目录
 *   node scripts/doctor.mjs <目录> --source . --import
 *   node scripts/doctor.mjs <目录> --quiet        # 只报问题
 *
 * `--import` 会真的 import 一次 index.js。默认不做：那是执行代码。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_INSTALL = path.join(
  process.env.USERPROFILE ?? process.env.HOME ?? "",
  ".dsh",
  "profiles",
  "desktop",
  "node_modules",
  "dsh-waifu-agents",
);

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.filter((a) => !a.startsWith("--"));
const dir = path.resolve(positional[0] ?? DEFAULT_INSTALL);
const sourceAt = argv.indexOf("--source");
const source = path.resolve(sourceAt >= 0 ? argv[sourceAt + 1] ?? "." : ".");
const quiet = flags.has("--quiet");
const doImport = flags.has("--import");

const problems = [];
const notes = [];
/** 其中「依赖没装」占了几条——它和「目录坏了」的收尾结论不一样。 */
let depProblems = 0;

function say(line) {
  if (!quiet) console.log(line);
}
function bad(line) {
  problems.push(line);
  console.log(`✗ ${line}`);
}
function ok(line) {
  say(`✓ ${line}`);
}

if (!fs.existsSync(dir)) {
  bad(`目录不存在：${dir}`);
  process.exit(1);
}

/* ---------------- 1. 这个目录是谁的 ---------------- */

let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  say(`目录：${dir}`);
  say(`包：${pkg.name ?? "(无名)"} v${pkg.version ?? "(无版本)"}`);
} catch (error) {
  bad(`读不出 package.json：${error.message}`);
}

/* ---------------- 2. 静态 import 是否都落得下来 ---------------- */

const jsFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
if (jsFiles.length === 0) bad("这个目录里没有 .js");

/* 只认 `from "./x.js"` 与 `import("./x.js")` 两种相对引用。 */
const RELATIVE = /(?:from\s*|import\s*\(\s*)["'](\.\.?\/[^"']+)["']/g;

let edges = 0;
for (const file of jsFiles) {
  const text = fs.readFileSync(path.join(dir, file), "utf8");
  const seen = new Set();
  for (const hit of text.matchAll(RELATIVE)) {
    const target = hit[1];
    if (seen.has(target)) continue;
    seen.add(target);
    edges += 1;
    const resolved = path.resolve(dir, target);
    if (!fs.existsSync(resolved)) {
      bad(`${file} → ${target} 不存在（这个目录缺文件，DSH 起不来）`);
    }
  }
}
if (problems.length === 0) ok(`${jsFiles.length} 个模块、${edges} 条相对引用全部落得下来`);

/* ---------------- 3. 与源码相比缺谁、多谁 ---------------- */

let sourceJs = [];
let sourceVersion = "";
try {
  sourceJs = fs.readdirSync(source).filter((f) => f.endsWith(".js"));
  sourceVersion = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")).version ?? "";
} catch {
  notes.push(`源码目录读不到（${source}），跳过版本比对`);
}

if (sourceJs.length > 0) {
  const here = new Set(jsFiles);
  const there = new Set(sourceJs);
  const missing = sourceJs.filter((f) => !here.has(f));
  const extra = jsFiles.filter((f) => !there.has(f));

  /* 两边都有的文件内容不一致 = 混版本。这是唯一会「同一个目录里既有新又有旧」
     的判据：旧版本整目录旧是正常的，新版本整目录新也是正常的，只有混着才必然
     在加载阶段抛错。 */
  const differing = [];
  for (const file of jsFiles) {
    if (!there.has(file)) continue;
    const a = fs.readFileSync(path.join(dir, file));
    const b = fs.readFileSync(path.join(source, file));
    if (!a.equals(b)) differing.push(file);
  }

  const sameVersion = (pkg?.version ?? "") !== "" && pkg?.version === sourceVersion;
  const uniform = differing.length === 0 || differing.length === jsFiles.length;

  if (missing.length === 0 && differing.length === 0) {
    ok(`模块清单与内容都和源码一致（v${sourceVersion}）`);
  } else if (!uniform) {
    bad(
      `混版本：${differing.length}/${jsFiles.length} 个模块与源码不同，其余相同` +
        `（${differing.join("、")}）→ 加载时要么缺模块，要么某模块缺导出`,
    );
    if (missing.length > 0) bad(`同时少 ${missing.length} 个模块：${missing.join("、")}`);
  } else if (sameVersion) {
    bad(`package.json 写的是 v${pkg.version}，但内容和源码不同（${differing.length} 个模块、少 ${missing.length} 个）`);
  } else {
    /* 整目录同版本，只是旧：本身自洽，能装能跑，只是没有今天的改动。 */
    notes.push(
      `整目录是 v${pkg?.version ?? "?"}，源码是 v${sourceVersion}：` +
        `少 ${missing.length} 个模块、${differing.length} 个模块内容不同。这是旧版本，自洽，不会导致启动失败`,
    );
  }
  if (extra.length > 0) notes.push(`目录里多出 ${extra.length} 个模块：${extra.join("、")}`);
}

/* ---------------- 4. 真的 import 一次（可选） ---------------- */

if (doImport) {
  const entry = path.join(dir, pkg?.exports?.["."] ?? pkg?.main ?? "./index.js");
  try {
    await import(pathToFileURL(entry).href);
    ok(`import ${path.relative(dir, entry)} 通过`);
  } catch (error) {
    /*
     * 两种 `ERR_MODULE_NOT_FOUND` 说的不是一件事：找不到**相对路径**的模块
     * 是这个目录缺文件（就是本脚本要抓的混版本/缺模块），而找不到**裸包名**
     * 是依赖没装——比如刚解包、还没 `npm i`。报成同一句会把「装一下依赖」
     * 误诊成「这个目录坏了」。
     */
    const spec = /Cannot find package '([^']+)'/.exec(error.message ?? "")?.[1] ?? "";
    const isDep =
      error.code === "ERR_MODULE_NOT_FOUND" &&
      spec !== "" &&
      Object.keys(pkg?.dependencies ?? {}).some((name) => spec === name || spec.startsWith(`${name}/`));
    if (isDep) {
      depProblems += 1;
      bad(`import 失败：依赖 ${spec} 没装。先在这个目录跑一次 npm i / pnpm i，再复查。`);
    } else {
      bad(`import 失败：${error.code ?? ""} ${error.message}`);
    }
  }
}

/* ---------------- 收尾 ---------------- */

for (const note of notes) say(`· ${note}`);
if (problems.length > 0) {
  console.log(
    depProblems === problems.length
      ? `\n${problems.length} 个问题，都是依赖没装。装好依赖再复查——目录本身没坏。`
      : `\n${problems.length} 个问题。这个目录现在装上，DSH 会在加载插件这一步失败。`,
  );
  process.exit(1);
}
console.log("\n目录自洽。");
