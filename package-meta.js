/**
 * 这个包是谁，以及正在运行的是它的哪一份拷贝。
 *
 * 从 `index.js` 拆出只有一个原因：`self-update.js` 需要同样三个答案，而模块
 * 不能导入导入自己的那个模块。这里全是对文件的纯读取 —— 无 cordis、无服务
 * —— 所以本包里任何东西都可以毫无顺序顾虑地导入它。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 本包自己的目录 —— 资源从这里解析，而不是从 profile。 */
export const PACKAGE_DIR = fileURLToPath(new URL(".", import.meta.url));

/** 本包自己的名字，拼写与 registry 和 profile 的写法一致。 */
export const PACKAGE_NAME = "dsh-waifu-agents";

/**
 * 本份拷贝自己的版本，加载时读取一次。
 *
 * 只读一次正是全部意义所在：自更新会在本模块仍处于加载状态时替换磁盘上的
 * `node_modules/dsh-waifu-agents`，于是磁盘上的文件不再描述正在运行的代码。
 * 只有在这里捕获的值才能区分"已安装 0.2.0，重启才能真正拿到"和"正在运行
 * 0.2.0"。
 */
export const RUNNING_VERSION = readOwnVersion();

/** @returns {string | null} 磁盘上那份拷贝的版本，读不到则为 null */
export function readOwnVersion() {
  try {
    const text = fs.readFileSync(
      path.join(PACKAGE_DIR, "package.json"),
      "utf8",
    );
    const version = JSON.parse(text).version;
    return typeof version === "string" && version !== "" ? version : null;
  } catch {
    return null;
  }
}
