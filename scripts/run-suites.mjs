#!/usr/bin/env node
/*
 * 跑离线断言套件。
 *
 * 存在的理由很朴素：`package.json` 里的 `test` / `eval` 原先直接写
 * `node selftest-v3.mjs && ...`，而那些文件**不进仓库、也不进发布包**
 * （见 `.gitignore` 与 `package.json` 的 `files`）。于是任何从 npm 装下来的人
 * 执行 `npm test`，得到的是 `MODULE_NOT_FOUND`——一句话里没有一个字说得清
 * 「这些套件只在源码仓库里」。装的人不该为了读懂一个 ENOENT 去翻源码。
 *
 * 所以这里做两件事：
 *
 *   1. 缺文件时给出人话，并以退出码 2 与「测试真的挂了」（1）区分开；
 *   2. 有文件时按固定顺序逐个跑，第一个失败就停——与 shell 的 `&&` 同语义。
 *
 * 用法：
 *   node scripts/run-suites.mjs          # 六个 selftest
 *   node scripts/run-suites.mjs eval     # 打分用的 harness（需要 eval/ 里的参考稿）
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* 顺序 = 依赖顺序：v3 是协议主干，其余是它的旁支。改这里要连着改文档。 */
const SUITES = [
  "selftest-v3.mjs",
  "selftest-dual.mjs",
  "selftest-r5.mjs",
  "selftest-memory.mjs",
  "selftest-memory-ops.mjs",
  "selftest-tool-filter.mjs",
  "selftest-seed.mjs",
];

const wanted = process.argv[2] ?? "";
const files = wanted === "eval" ? ["eval-v3.mjs"] : SUITES;

const missing = files.filter((one) => !fs.existsSync(path.join(root, one)));
if (missing.length > 0) {
  console.log(`这些套件不在这里：${missing.join("、")}`);
  console.log(`（当前目录：${root}）`);
  console.log(
    "\n断言套件只活在源码仓库里：它们是维护者本机的验收工具，既不进 git，也不进发布包，" +
      "因为插件运行时一个都不 import。装下来的包里没有它们，这不是安装坏了。",
  );
  console.log("想知道这个副本能不能跑：npm run doctor");
  process.exit(2);
}

for (const file of files) {
  console.log(`\n── ${file} ${"─".repeat(Math.max(0, 56 - file.length))}`);
  const run = spawnSync(process.execPath, [file], { cwd: root, stdio: "inherit" });
  if (run.error !== undefined) {
    console.log(`跑不起来：${run.error.message}`);
    process.exit(1);
  }
  if (run.status !== 0) {
    console.log(`\n${file} 失败（退出码 ${run.status ?? "signal"}），后面的套件没有跑。`);
    process.exit(run.status ?? 1);
  }
}

console.log(`\n${files.length} 个套件全部通过。`);
