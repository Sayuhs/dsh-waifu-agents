/**
 * 按 key 串行的任务队列，外加每个 key 的单调世代计数。
 *
 * ## 为什么需要它
 *
 * 记忆的写路径是「读 - 改 - 写」：读出文件、追加一条、整份写回。它被多个
 * 互不相识的调用方并发触发（同一个会话的两个回合、面板的编辑与清空、团队
 * 记忆的收尾），而当两次「读」都落在任何一次「写」之前时，后写的那一份会
 * 把先写的那一份整份抹掉 —— 磁盘与内存里都没有，用户视角就是「她忘了刚才
 * 那句话」。所以这条路径必须在**临界区内重读**，而不只是加一把锁。
 *
 * ## 世代（generation）
 *
 * 锁只能让任务排队，无法表达「这一批任务已经作废」。用户点「清空记忆」时，
 * 有些写入已经启动但还排在队里；它们拿到锁之后会把刚刚被清掉的内容整份写
 * 回去。所以每个 key 带一个单调计数：调用方在**启动那一刻**取一次世代，
 * 在**锁内**再取一次比对，不一致就丢弃这次写入。
 *
 * 世代在清空被调用的同一瞬间递增（而不是等清空的删除操作拿到锁），否则
 * 「按下清空之后、删除执行之前」启动的任务会被判成新任务。
 *
 * 递增之后启动的任务取到的是新世代，因此照常写入 —— 清空只作废它之前
 * 启动的工作，不作废之后的工作。
 *
 * ## 已知风险
 *
 * **R1（跨进程写入，未修，P0 级）**：这把锁只在一个进程内有效。两个 DSH 实例
 * （两个 profile 同时活着，或热重载期间的两个 fiber）各有一份自己的 `slots`，
 * 所以「同一人设/同一会话的两次读改写」在两个进程之间仍可能互相覆盖 —— 那种
 * 情形下最后落盘的那一份是赢家，先落盘的那一份连同它追加的条目一起消失。
 * 本插件**不**宣称支持多进程并发写入。这条风险不会因为双实例面板套件
 * （`selftest-dual.mjs` 的 T5）变绿而消失：那条用例跑在同一进程里，只证明
 * 扫描读共享账本，与写入路径无关。要真正闭合需要文件级租约（跨进程锁文件 +
 * 陈旧检测），属于独立工作项。
 *
 * 这不是一个「配置出错才会撞上」的情形：人设目录的默认解析结果是
 * `<home>/personas`，而 `<home>` 是 DSH 主目录（`DSH_PROFILE_DIR` 的祖父目录
 * 或 `DSH_HOME`），**两个 profile 默认落在同一处** —— `teams.json`、
 * `overrides.json`、`persona-memory/` 也都在那儿。所以同时开两个 profile 就
 * 足以让两个进程写同一份数据。
 *
 * key 的粒度由调用方决定（`persona:<id>`、`team:<session>::<team>`）。不同
 * key 的任务完全并行，所以一个人设的写入不会拖住另一个人设的回合，也不会
 * 拖住用户可见的回复流。
 */

/**
 * key -> { tail, gen }。
 *
 * `tail` 是队尾（永远 resolve，从不 reject），`null` 表示队列空闲。
 * `gen` 是世代的当前值，没有任务时不清零 —— 清零会让一个刚刚被作废的写入
 * 重新变成「新任务」。
 */
const slots = new Map();

/**
 * 空闲槽位的回收阈值。
 *
 * 槽位只在**空闲**时被回收，而回收不改变任何正在等待或正在执行的任务的
 * 判断：取世代与入队是同步相连的，中间没有 await，所以不可能出现「取完
 * 世代、还没入队」的窗口。回收因此不会让世代语义失效。
 */
const IDLE_SLOT_LIMIT = 1024;

function slotOf(key) {
  let slot = slots.get(key);
  if (slot === undefined) {
    slot = { tail: null, gen: 0 };
    slots.set(key, slot);
  }
  return slot;
}

function pruneIdle() {
  if (slots.size <= IDLE_SLOT_LIMIT) return;
  for (const [key, slot] of slots) {
    if (slots.size <= IDLE_SLOT_LIMIT) break;
    if (slot.tail === null) slots.delete(key);
  }
}

/**
 * 在 `key` 的队列里跑一次 `fn`：同一个 key 依次执行，不同 key 互不等待。
 *
 * 前一个任务抛错**不会**污染队列 —— 队尾存的是「无论成败都 resolve」的那
 * 一条，所以后来的任务照常拿到自己的执行机会。`fn` 自己的结果（或错误）由
 * 返回的 promise 原样交给调用方。
 *
 * 不可重入：在同一个 key 的 `fn` 里再调一次 `runExclusive(key, ...)` 会自己
 * 等自己。需要嵌套的场合必须换一个 key。
 *
 * @template T
 * @param {string} key 串行粒度
 * @param {() => T | Promise<T>} fn 临界区
 * @returns {Promise<T>}
 */
export function runExclusive(key, fn) {
  const name = String(key ?? "");
  if (name === "") {
    /* 没有 key 就没有可串行的东西：照常跑，但绝不悄悄并进别人的队列。 */
    return Promise.resolve().then(() => fn());
  }
  const slot = slotOf(name);
  const previous = slot.tail ?? Promise.resolve();
  const run = previous.then(() => fn());
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  slot.tail = tail;
  tail.then(() => {
    if (slot.tail === tail) slot.tail = null;
    pruneIdle();
  });
  return run;
}

/** 这个 key 当前的世代。没有记录过就是 0。 */
export function generationOf(key) {
  return slots.get(String(key ?? ""))?.gen ?? 0;
}

/**
 * 递增一个 key 的世代，并返回新值。
 *
 * 调用方应当在「用户按下清空」的那一刻调用它，而不是在删除操作的队列里 ——
 * 语义是「从这一刻起，先前启动的写入一律作废」。
 */
export function bumpGeneration(key) {
  const slot = slotOf(String(key ?? ""));
  slot.gen += 1;
  return slot.gen;
}
