/**
 * dsh-waifu-agents — Host half.
 *
 * Scans one persona directory and registers every `*.md` in it as an agent
 * preset ("wife"). All presets share one capability list (`template.json`,
 * 20 rows); only the `@deepseek-ai/dsh-persona` row's `prefix` is replaced by
 * the file's markdown body, so the persona text lives in plain files while the
 * tool set comes from one place.
 *
 * Identity is the **id** (the file name), never the display name: `rename`
 * moves the file and re-registers it under the new id. `order` is assigned by
 * the host (`nextOrder`) unless a file already carries one. An id may be
 * Chinese (`ID_OK`), so a wife can be called `后藤一里` outright instead of
 * carrying a transliterated alias forever.
 *
 * Operations, reachable two ways: the `/persona <json>` command (which needs
 * a session), and `POST /waifu-agents/api` carrying the same JSON body (which
 * needs only a loopback peer). The settings panel uses the route: that slot has
 * empty owner props, so it never receives a session id.
 *   list        the directory, every file, and which ids this plugin owns
 *   get         one wife, answer style included
 *   create      new file + registration; `id` may be blank (derived from `name`), `order` may be blank
 *   update      edit name / summary / answer style (id changes go through `rename`)
 *   rename      move a wife to a new id (the file name *is* the preset id)
 *   remove      unregister, then archive the file as `<id>.md.off`
 *   import      take a whole markdown file, front matter included, and store it
 *   export      return one file's exact text
 *   exportAll   return every file's exact text
 *   refresh     rescan the directory and adopt newly added files
 *   setDir      write `config.dir` back through the configEditor service
 *   updateCheck which version runs, which one is installed, which one the registry has
 *   updateApply install the newest published version through the pluginManager service
 *
 * The id is invisible. It only has to be unique on disk, so it is the slug of
 * the display name and `update` MOVES the file when that name changes: the file
 * name, the `name` field and the row title are then one and the same thing, and
 * no screen ever asks a user for an id. A name that no file name can carry
 * (spaces, punctuation, `/`) keeps this by being slugified instead.
 *
 * `updateApply` is what makes a published fix reachable without a shell: the
 * panel posts it, `latestVersion` asks the registry, and the install goes
 * through the very service the Plugins page uses — `pnpm add <name>@<version>`,
 * which also REWRITES the profile's version range. That range, not the plugin,
 * is what keeps an old copy installed: `^0.0.1` can never resolve `0.1.0`, so
 * every release used to need a hand-edited spec. An already-installed package
 * is never hot-reloaded — the manager answers `restart-required`, and so does
 * this op, which is why the panel says so out loud.
 *
 * No configuration is required: `resolveDir` picks the directory from the row
 * config, then from `<home>/personas`, then — on a machine that does not have it
 * yet — seeds that path from this package's own `personas/`, so the wives the
 * user edits are never the ones an upgrade would overwrite; only then does it
 * fall back to the packaged directory itself. `<home>` is `$DSH_HOME`, else the
 * system home plus `.dsh`: those variables are shell facts, and the Host process
 * a plugin runs in need not export them.
 *
 * Public contracts used here:
 *   - `ctx.agentPresets.register` / `.list`  (service `agentPresets`)
 *   - `ctx.commands.register`                (service `commands`)
 *   - `ctx.get('configEditor')`              (service `configEditor`, optional)
 *   - `ctx.webServer.register`                (service `webServer`, lazily injected)
 *   - `node:fs` for the files themselves      (same as the shipped bundle example)
 * Nothing outside `node:` builtins is imported except `@deepseek-ai/schemastery`,
 * which the `Config` export needs and which the manifest declares as a dependency.
 * No peer dependency is declared on purpose: the plugin manager refuses an
 * install whose declared DSH peer range is unsatisfied, and none is needed.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";

/** Cordis plugin name. */
export const name = "waifu-agents";
/**
 * Every registry this plugin contributes to. `configEditor` (the directory and
 * the default persona) and `pluginManager` (the self-update) are both optional
 * and are reached through `ctx.get` / `ctx.inject`: a profile without them must
 * still get its personas.
 */
export const inject = ["agentPresets", "commands", "systemPrompt"];

/** Row config schema. Declaring this is what gives the row a configure control. */
export const Config = z.object({
  dir: z.string(),
  template: z.string(),
  registry: z.string(),
  /** Off turns the mid-session switch notice off; see `withSwitchNotice`. */
  switchNotice: z.boolean(),
  /**
   * Off turns the per-turn identity snapshot off; see `identityNoticeOf`.
   *
   * On by default because it is the only channel that actually re-anchors a
   * mid-session switch: the persona itself is a system prompt, and a model that
   * has already answered twice as the previous wife defends those answers
   * rather than re-reading the top of the prompt. See the measurement in
   * `identityNoticeOf`.
   */
  identityReminder: z.boolean(),
  /**
   * On makes `/waifu-change` move the session's own preset label too; see
   * `rememberSessionPreset`.
   *
   * The chip above a conversation renders `projectionValues.agentPreset`, and
   * the platform refuses to move it for a session that has already started a
   * turn (`agent-preset/locked`) — because moving it "for real" means remounting
   * the whole preset tree, tools included. So switching a running session used
   * to leave the label naming the wife the session was BORN with, which reads as
   * 「切了但标签没变」. This appends the selection event alone, which moves the
   * label and nothing else; the persona itself is served by the override either
   * way. Off leaves the label alone.
   */
  syncSessionChip: z.boolean(),
});

/** This package's own directory — resources resolve from here, not from the profile. */
const PACKAGE_DIR = fileURLToPath(new URL(".", import.meta.url));

/** This package's own name, spelled the way the registry and the profile spell it. */
const PACKAGE_NAME = "dsh-waifu-agents";

/** Where a self-update asks for the newest version, unless the row overrides it. */
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

/** Bounded, so a wedged registry cannot hold a panel request open forever. */
const LOOKUP_TIMEOUT_MS = 8000;

/**
 * This copy's own version, read ONCE at load.
 *
 * Reading it once is the whole point: a self-update replaces
 * `node_modules/dsh-waifu-agents` on disk while this module stays loaded, so
 * the file on disk stops describing the code that is running. Only a value
 * captured here can tell "0.2.0 is installed, restart to actually get it" apart
 * from "0.2.0 is running".
 */
const RUNNING_VERSION = readOwnVersion();

/** @returns {string | null} the version of the copy on disk, or null if unreadable */
function readOwnVersion() {
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

/**
 * Is `candidate` a later release than `current`?
 *
 * Three numeric parts, and a prerelease sorts before its own release
 * (`1.0.0-rc.1` < `1.0.0`). Anything unparseable answers `false`: an odd version
 * string must never turn into an update prompt.
 * @param {unknown} candidate
 * @param {unknown} current
 * @returns {boolean}
 */
export function isNewer(candidate, current) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(
      String(value ?? "").trim(),
    );
    if (match === null) return null;
    return {
      nums: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] ?? "",
    };
  };
  const a = parse(candidate);
  const b = parse(current);
  if (a === null || b === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a.nums[index] !== b.nums[index]) return a.nums[index] > b.nums[index];
  }
  if (a.pre === b.pre) return false;
  if (a.pre === "") return true;
  if (b.pre === "") return false;
  return a.pre > b.pre;
}

/**
 * The newest version the registry publishes for this package.
 *
 * Only `dist-tags.latest` is read, through the abbreviated metadata document, so
 * one small GET answers it. `AbortSignal.timeout` keeps a black-holed
 * connection from hanging the panel: this is called from a click handler.
 * @param {string} [registry] registry base URL; the row config may override it
 * @returns {Promise<{ version: string, registry: string }>}
 */
async function latestVersion(registry) {
  const base = String(registry ?? "").trim() || DEFAULT_REGISTRY;
  if (typeof fetch !== "function")
    throw new Error(`这个 Node 没有 fetch，只能手动装：${PACKAGE_NAME}@latest`);
  const url = new URL(PACKAGE_NAME, base.endsWith("/") ? base : `${base}/`)
    .href;
  const response = await fetch(url, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`${base} 对 ${PACKAGE_NAME} 返回 HTTP ${response.status}`);
  const meta = await response.json();
  const latest = meta?.["dist-tags"]?.latest;
  if (typeof latest !== "string" || latest === "")
    throw new Error(`${base} 没有给出 dist-tags.latest`);
  return { version: latest, registry: base };
}

/**
 * The shared skeleton: a reserved name in the persona directory that is never a
 * wife. It is the frame a `template:`-using persona is poured into, with
 * `[[body]]` marking where her own text goes and `[[name]]` standing in for the
 * display name.
 */
const SKELETON_FILE = "_common.md";

/** Names in the directory that are not wives. */
const SKIP = new Set(["README.md", "_template.json", SKELETON_FILE]);

/**
 * Our placeholders are deliberately NOT `{{…}}`.
 *
 * `{{…}}` belongs to the prompt renderer: it resolves that syntax when the
 * system prompt is rendered, and it THROWS on any name it does not know —
 * `dsh-system-prompt` registers exactly provider/model/cwd. This row is
 * registered with `complete: true`, so the rendered prefix IS the whole system
 * prompt: one stray `{{char}}` would not degrade a paragraph, it would fail the
 * prompt and the session would not start.
 */
const PROMPT_VARIABLES = new Set(["provider", "model", "cwd"]);

/**
 * The prompt variable every persona row points at instead of literal text.
 *
 * It is deliberately NOT in `PROMPT_VARIABLES`: that set validates what a
 * *persona* is allowed to write. This name is written by the plugin itself, and
 * it is resolved by the provider registered in `apply`.
 */
export const PERSONA_PLACEHOLDER = "{{waifu_persona}}";

/**
 * Where the per-session overrides live.
 *
 * Inside the persona directory whenever that directory is writable, so this
 * plugin owns exactly ONE path on disk and an uninstall can be checked by
 * looking at it. `OVERRIDE_FILE` is only the fallback for a read-only
 * (in-package) directory. `LEGACY_OVERRIDE_FILE` is the same fallback under the
 * package's pre-rename name (`dsh-persona-waifu`): an install upgrading from
 * 0.3.x/0.4.x left its session overrides there, and `foldLegacyOverrides` folds
 * them into the current directory on first apply. Never write the legacy name.
 */
const OVERRIDE_FILE = "dsh-waifu-agents.overrides.json";
const LEGACY_OVERRIDE_FILE = "persona-waifu.overrides.json";
const OVERRIDE_FILE_IN_DIR = "overrides.json";

/** Bounded so a long-lived install cannot accumulate dead session ids forever. */
const OVERRIDE_LIMIT = 500;

/** The settings namespace the agent-preset registry stores `selectedDefault` in. */
const REGISTRY_NS = "agent-preset-registry";
const PROMPT_VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Where this plugin's presets sit in the registry's ONE global sort key.
 *
 * The registry sorts every declaration it holds with
 * `(a.order ?? Infinity) - (b.order ?? Infinity) || a.id.localeCompare(b.id)`
 * (`dsh-agent-preset-registry/lib/index.js`), and the shipped presets already
 * occupy 1..4. A persona file's `order:` is a position *inside this directory* —
 * the panel's drag-reorder writes 1..n and nothing else — so handing that number
 * straight to the registry put both families in the same band and the
 * new-task list read 后藤一里 / standard / 大肥鱼 / ptc / 托尔 … : 内置模式与自定义
 * 人设互相穿插。The offset is applied at registration ONLY, so the file keeps the
 * local order the panel edits while the roster reads 内置在上、自定义在下.
 *
 * 10000 rather than 10: `order` is a bare sort key with no documented range, and
 * a band wide enough that no plausible hand-written number reaches it cannot put
 * a persona above a built-in by accident.
 */
export const PERSONA_ORDER_BASE = 10000;

/**
 * A legal preset id; the file name is the preset id.
 *
 * Unicode letters and digits, so a wife can be called `后藤一里` instead of
 * being forced to keep a transliterated alias. The registry puts *no* format
 * rule on `id` — the live code rejects only an empty id and a duplicate one —
 * so this pattern is ours, and its real job is to stay a legal *file name*.
 * Letters and digits already exclude `/ \ : * ? " < > |`, spaces and dots, and
 * refusing a leading `-` keeps an id from ever looking like an option.
 */
export const ID_OK = /^[\p{L}\p{N}][\p{L}\p{N}-]*$/u;

/**
 * `SKIP` is a list of file names, and Windows compares file names
 * case-insensitively, so `readme.md` is the same file as `README.md`.
 */
const RESERVED = new Set([...SKIP].map((entry) => entry.toLowerCase()));

/**
 * Would this id land on a name the scanner deliberately ignores? Such a file
 * would be written and then never registered, so it is refused up front.
 * @param {string} id
 */
function reserved(id) {
  return RESERVED.has(`${id}.md`.toLowerCase());
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Copy this package's shipped `personas/` into `target`, so a first run leaves
 * the user with a writable copy instead of a live directory inside
 * `node_modules` — which the next plugin upgrade would overwrite.
 *
 * Staging and then renaming is not decoration. `resolveDir` reads "the
 * directory exists" as "the user's data lives here", so a directory that
 * appeared but was only half filled would be adopted on the next launch and
 * whatever failed to copy would be missing from the roster for good. The staged
 * name ends in neither `.md` nor `personas`, so no scan can ever adopt it;
 * `rename` then fails instead of merging if something created the target
 * meanwhile, and the caller falls back to the packaged directory.
 *
 * Never overwrites, never throws: a machine where this cannot work must still
 * end up with the shipped wives.
 *
 * @param {string} target absolute directory to create
 * @param {string} from this package's own `personas/`
 * @returns {boolean} true only when the whole directory landed
 */
function seedInto(target, from) {
  let entries;
  try {
    if (!fs.statSync(from).isDirectory()) return false;
    entries = fs
      .readdirSync(from)
      .filter((entry) => fs.statSync(path.join(from, entry)).isFile());
  } catch {
    return false;
  }
  if (entries.length === 0) return false;

  const stage = `${target}.seed-${process.pid}`;
  try {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    for (const entry of entries)
      fs.copyFileSync(path.join(from, entry), path.join(stage, entry));
    fs.renameSync(stage, target);
    return true;
  } catch {
    try {
      fs.rmSync(stage, { recursive: true, force: true });
    } catch {
      /* a stray stage directory beats failing to start */
    }
    return false;
  }
}

/**
 * Decide which directory to serve, with no configuration required.
 *
 * 1. `config.dir` when the row sets it.
 * 2. `<home>/personas` when that directory exists.
 * 3. that same path, *created* from this package's own `personas/` when `seed`
 *    is set, so a machine that has never seen this plugin ends up with writable
 *    wives rather than ones inside `node_modules`.
 * 4. this package's own `personas/`.
 *
 * `<home>` is `DSH_PROFILE_DIR`'s grandparent, else `DSH_HOME`, else the system
 * home plus `.dsh` — `homeFromEnv` always answers one of the three.
 *
 * Only step 3 writes, and it never touches a directory that already exists.
 *
 * @param {{ dir?: string, packageDir?: string, env?: Record<string, string | undefined>, seed?: boolean }} [options]
 * @returns {{ dir: string, source: 'config' | 'DSH_PROFILE_DIR' | 'DSH_HOME' | 'default' | 'seeded' | 'package' }}
 */
/**
 * The DSH home directory, from whichever source this process can see:
 * `DSH_PROFILE_DIR` is `<home>/profiles/<name>`, `DSH_HOME` is the home itself,
 * and the system home plus `.dsh` is the last resort.
 *
 * The two variables are Harness *shell* facts — injected into shell executions,
 * not necessarily into the Host process a plugin runs in. Answering `null` here
 * is what used to send every such machine to the packaged, read-only directory,
 * so this always answers with a path.
 * @param {Record<string, string | undefined>} env
 * @returns {{ home: string, source: 'DSH_PROFILE_DIR' | 'DSH_HOME' | 'default' }}
 */
function homeFromEnv(env) {
  const profileDir = env.DSH_PROFILE_DIR;
  if (profileDir) {
    return {
      home: path.dirname(path.dirname(path.resolve(profileDir))),
      source: "DSH_PROFILE_DIR",
    };
  }
  const home = env.DSH_HOME;
  if (home) return { home: path.resolve(home), source: "DSH_HOME" };
  return {
    home: path.join(env.USERPROFILE || env.HOME || os.homedir(), ".dsh"),
    source: "default",
  };
}

export function resolveDir(options = {}) {
  const {
    dir,
    packageDir = PACKAGE_DIR,
    env = process.env,
    seed = false,
  } = options;
  if (dir) return { dir: path.resolve(dir), source: "config" };
  const { home, source } = homeFromEnv(env);
  const candidate = path.join(home, "personas");
  if (fs.existsSync(candidate)) return { dir: candidate, source };
  if (seed && seedInto(candidate, path.join(packageDir, "personas"))) {
    return { dir: candidate, source: "seeded" };
  }
  return { dir: path.join(packageDir, "personas"), source: "package" };
}

/** Collapse a value onto one line so it survives the flat front-matter format. */
function oneLine(value) {
  return String(value ?? "")
    .replace(/\s*\r?\n\s*/g, " ")
    .trim();
}

/**
 * Flat `key: value` front matter — the same subset the existing persona files use.
 * Only the block at the very start of the file is metadata; anything later is
 * answer style, `---` and colons included.
 * @param {string} input - file text
 * @returns {{ meta: Record<string, string | number>, body: string }}
 */
export function parseFrontMatter(input) {
  const raw = String(input)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n");
  const match = FRONT_MATTER.exec(raw);
  if (!match) return { meta: {}, body: raw.trim() };
  const meta = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    if (!key) continue;
    let value = line.slice(at + 1).trim();
    if (
      value.length > 1 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    meta[key] = key === "order" ? Number(value) : value;
  }
  return { meta, body: raw.slice(match[0].length).trim() };
}

/**
 * Write metadata plus body back in the format `parseFrontMatter` reads.
 *
 * `group` and `template` are carried like the others rather than dropped: a
 * panel save rewrites the whole front matter, so any field this function does
 * not know about is a field the panel would silently delete on the next edit.
 */
export function renderPersona({
  name: displayName,
  order,
  description,
  group,
  template,
  body,
}) {
  const lines = ["---"];
  if (oneLine(displayName)) lines.push(`name: ${oneLine(displayName)}`);
  if (Number.isFinite(order)) lines.push(`order: ${order}`);
  if (oneLine(description)) lines.push(`description: ${oneLine(description)}`);
  if (oneLine(group)) lines.push(`group: ${oneLine(group)}`);
  if (oneLine(template)) lines.push(`template: ${oneLine(template)}`);
  lines.push("---", "", String(body ?? "").trim(), "");
  return lines.join("\n");
}

/** Accept numbers, numeric strings and empty values; return a finite number or undefined. */
function normalizeOrder(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** A short, stable token for one file's exact text. */
export function revision(text) {
  return createHash("sha256")
    .update(String(text ?? ""), "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * Pour one persona into the shared skeleton.
 *
 * Returns `{ ok, text, problems, bodyOffset }`. `problems` is never dropped on
 * the floor: a body that cannot be assembled is refused BEFORE it is written,
 * because a file that cannot be registered would sit in the directory and be
 * invisible in the roster — the one failure mode nobody can diagnose.
 *
 * @param {string} name display name, substituted for `[[name]]`
 * @param {string} body the persona text as stored
 * @param {string | null} skeleton skeleton text, or null when she asks for none
 */
export function assemble(name, body, skeleton) {
  const problems = [];
  let text = String(body ?? "");
  let bodyOffset = 0;
  if (skeleton !== null && skeleton !== undefined) {
    const frame = String(skeleton);
    const slots = frame.split("[[body]]").length - 1;
    if (slots === 0) problems.push("骨架里没有 [[body]]，人设正文没有地方可放");
    else if (slots > 1)
      problems.push(`骨架里有 ${slots} 个 [[body]]，只能有一个`);
    if (problems.length === 0) {
      const head = frame.slice(0, frame.indexOf("[[body]]"));
      bodyOffset = head.replace(/\[\[name\]\]/g, name).length;
      text = frame.split("[[body]]").join(text);
    } else {
      text = `${frame}\n\n${text}`;
    }
  }
  text = text.replace(/\[\[name\]\]/g, name);
  if (problems.length === 0) {
    for (const match of text.matchAll(/\[\[([a-z0-9_]*)\]\]/g)) {
      if (match[1] !== "name" && match[1] !== "body") {
        problems.push(
          `不认识的占位符 [[${match[1]}]]：只支持 [[name]] 与 [[body]]`,
        );
      }
    }
    for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
      const variable = match[1].trim();
      if (
        !PROMPT_VARIABLE_NAME.test(variable) ||
        !PROMPT_VARIABLES.has(variable)
      ) {
        problems.push(
          `正文里的 {{${match[1]}}} 会让整份系统提示词渲染失败（会话起不来）：只支持 ` +
            [...PROMPT_VARIABLES].map((item) => `{{${item}}}`).join(" / "),
        );
      }
    }
  }
  return { ok: problems.length === 0, text, problems, bodyOffset };
}

/** Only one skeleton name is supported; anything else is a typo, not a feature. */
export function templateProblem(meta) {
  const value = oneLine(meta?.template);
  if (!value) return null;
  return value === SKELETON_FILE
    ? null
    : `template: ${value} —— 目前只支持 ${SKELETON_FILE}`;
}

/** The skeleton a persona asks for, or null when she asks for none. */
function skeletonFor(meta, skeleton) {
  return oneLine(meta?.template) === SKELETON_FILE ? skeleton : null;
}

/**
 * What one registration actually mounted, so a later scan can tell "already
 * registered" apart from "registered, but her text has changed since".
 */
export function registrationRev(skeleton, body) {
  const frame =
    skeleton === null || skeleton === undefined ? "" : skeleton.text;
  return revision(`${frame}\u0000${String(body ?? "")}`);
}

/**
 * Resolve one typed argument to a persona id.
 *
 * The rules are deliberately dull: strip one optional `@` and the surrounding
 * whitespace, then exact id, then exact display name, then a UNIQUE prefix.
 * Ambiguity is reported as candidates instead of guessed at — a command must
 * never decide on its own who you are talking to.
 * @param {unknown} query raw argument
 * @param {{ id: string, name?: string }[]} rows the roster
 * @returns {{ ok: true, id: string } | { ok: false, error: string, candidates?: string[] }}
 */
export function matchPersona(query, rows) {
  const raw = oneLine(String(query ?? "").replace(/^@/, ""));
  const needle = raw.toLowerCase();
  if (needle === "") return { ok: false, error: "没有给出人设名。" };
  const byId = rows.find((row) => row.id.toLowerCase() === needle);
  if (byId !== undefined) return { ok: true, id: byId.id };
  const byName = rows.find((row) => oneLine(row.name).toLowerCase() === needle);
  if (byName !== undefined) return { ok: true, id: byName.id };
  const prefixed = rows.filter(
    (row) =>
      row.id.toLowerCase().startsWith(needle) ||
      oneLine(row.name).toLowerCase().startsWith(needle),
  );
  if (prefixed.length === 1) return { ok: true, id: prefixed[0].id };
  const names = (source) => source.map((row) => oneLine(row.name) || row.id);
  if (prefixed.length === 0) {
    return {
      ok: false,
      error: `没有叫「${raw}」的人设。`,
      candidates: names(rows),
    };
  }
  return {
    ok: false,
    error: `「${raw}」能对上 ${prefixed.length} 个，多打几个字：`,
    candidates: names(prefixed),
  };
}

/**
 * The ids one session's text is chosen from, most specific first.
 *
 * The mounted persona comes BEFORE the global default on purpose: the session
 * header records the preset the user picked on the new-task page, and letting
 * the default win would turn the platform's own per-session selector into a
 * decoration. `defaultId` is the rung for a mount that no longer exists.
 * @param {{ overrideId?: unknown, mountedId?: unknown, defaultId?: unknown }} source
 * @returns {string[]} deduplicated, empties dropped
 */
export function orderPersonaIds(source) {
  const seen = new Set();
  const out = [];
  for (const value of [
    source?.overrideId,
    source?.mountedId,
    source?.defaultId,
  ]) {
    const id = oneLine(value);
    if (id !== "" && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Move one id directly in front of another.
 *
 * @param {string[]} ids the current sequence
 * @param {string} movedId the row being dragged
 * @param {string} beforeId the row it was dropped on
 * @returns {string[] | null} the new sequence, or null when the move is a no-op
 */
export function reorderIds(ids, movedId, beforeId) {
  const from = ids.indexOf(movedId);
  const to = ids.indexOf(beforeId);
  if (from < 0 || to < 0 || from === to) return null;
  const next = ids.slice();
  next.splice(from, 1);
  next.splice(next.indexOf(beforeId), 0, movedId);
  return next;
}

/**
 * One preset definition: identity from the front matter, capabilities from the
 * template with only the persona row's `prefix` replaced.
 *
 * The prefix is the PLACEHOLDER, not the text: the row is mounted once and its
 * text is read on every assembly, which is the only way a session can change
 * persona after its first turn. `assemble()` still runs at registration time so
 * an unusable body is refused here rather than at render time.
 *
 * The `order` that leaves here is the LOCAL order shifted into this plugin's own
 * band — see {@link PERSONA_ORDER_BASE}. A wife with no `order:` of her own keeps
 * being unranked (`undefined`), which sorts last in the registry and after every
 * ranked row, exactly as before.
 * @param {string} id - preset id (file name without `.md`)
 * @param {Record<string, unknown>} meta - parsed front matter
 * @param {string} body - the persona text, as stored
 * @param {unknown[]} templateRows - capability list
 * @param {{ text: string } | null} [skeleton] - the shared skeleton, if any
 */
export function buildDefinition(id, meta, body, templateRows, skeleton = null) {
  const name = oneLine(meta.name) || id;
  const localOrder = normalizeOrder(meta.order);
  const poured = assemble(name, body, skeleton === null ? null : skeleton.text);
  return {
    id,
    name,
    description: oneLine(meta.description) || undefined,
    order: localOrder === undefined ? undefined : PERSONA_ORDER_BASE + localOrder,
    // `poured` is still computed: a body the renderer would reject must be
    // refused while the panel is saving it, not after a session has mounted it.
    plugins: templateRows.map((row) =>
      row && row.name === "@deepseek-ai/dsh-persona"
        ? {
            ...row,
            config: { ...(row.config ?? {}), prefix: PERSONA_PLACEHOLDER },
          }
        : row,
    ),
  };
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ dir?: string, template?: string }} [config]
 */
export function apply(ctx, config = {}) {
  const resolved = resolveDir({ dir: config.dir, seed: true });
  const dir = resolved.dir;
  const dirSource = resolved.source;

  /** The packaged directory is replaced wholesale by the next upgrade, so it is read-only. */
  const writable = dirSource !== "package";
  function readOnly() {
    return {
      ok: false,
      error: `当前人设目录在插件包内（${dir}），升级插件会整包替换它，所以这里不能写。请先在面板点「改目录」换成包外的目录，再回来编辑。`,
    };
  }
  const templatePath = path.resolve(
    config.template ?? path.join(PACKAGE_DIR, "template.json"),
  );

  /**
   * Patch ids this row may be known by, for the configEditor lookup.
   *
   * The `persona-waifu` pair is the pre-rename spelling of the same row: a
   * profile created before the package became `dsh-waifu-agents` still carries
   * that id, and the directory / default-persona settings live on it. Matching
   * both spellings keeps those settings reachable across the rename.
   */
  const SELF_IDS = [
    "waifu-agents",
    "include:waifu-agents",
    "persona-waifu",
    "include:persona-waifu",
  ];

  /** preset id -> { dispose, rev }: the disposer, plus what was registered. */
  const owned = new Map();

  const fileFor = (id) => path.join(dir, `${id}.md`);

  /**
   * One parsed file, keyed by path and validated by `(mtimeMs, size)`.
   *
   * `chars` is the length of the body AFTER the front matter is stripped and
   * the text trimmed, so it cannot be derived from the byte size (one CJK
   * character is three bytes) — the cache has to keep the parse, not the bytes.
   * `size` only decides whether that parse is still valid, which is the same
   * judgement the harness makes about a client bundle: mtimeMs/ctimeMs/size,
   * and never a content hash.
   */
  const fileCache = new Map();
  let skeletonCache = null;

  function readPersona(full) {
    const stat = fs.statSync(full);
    const hit = fileCache.get(full);
    if (
      hit !== undefined &&
      hit.mtimeMs === stat.mtimeMs &&
      hit.size === stat.size
    )
      return hit;
    const raw = fs.readFileSync(full, "utf8");
    const { meta, body } = parseFrontMatter(raw);
    const entry = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      rev: revision(raw),
      meta,
      body,
      chars: body.length,
    };
    fileCache.set(full, entry);
    return entry;
  }

  /** The shared skeleton, or null when this directory has none. */
  function readSkeleton() {
    const full = path.join(dir, SKELETON_FILE);
    if (!fs.existsSync(full)) return null;
    const stat = fs.statSync(full);
    if (
      skeletonCache !== null &&
      skeletonCache.file === full &&
      skeletonCache.mtimeMs === stat.mtimeMs &&
      skeletonCache.size === stat.size
    ) {
      return skeletonCache;
    }
    const text = fs.readFileSync(full, "utf8");
    skeletonCache = {
      file: full,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      text,
      chars: text.length,
      rev: revision(text),
    };
    return skeletonCache;
  }

  /**
   * Write one persona file so that what sits on disk is never half of either
   * version: stage beside the target, then `rename` over it. This repository
   * already seeds directories that way (`seedInto`) and for the same reason —
   * `rename` is atomic, a partially written file is not.
   *
   * The previous version is kept as `<name>.bak`: the optimistic lock can tell
   * you that something changed, but it cannot give back what it replaced.
   */
  function writeAtomic(full, text) {
    if (fs.existsSync(full)) {
      try {
        fs.copyFileSync(full, `${full}.bak`);
      } catch {
        // A backup that cannot be taken must not block the write itself.
      }
    }
    const stage = `${full}.stage-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(stage, text, "utf8");
      fs.renameSync(stage, full);
    } catch (error) {
      try {
        fs.rmSync(stage, { force: true });
      } catch {
        // best effort
      }
      throw error;
    }
    fileCache.delete(full);
    skeletonCache = null;
  }

  /* ------------------------------------------- session persona override */

  /**
   * The one path this plugin owns. Inside the persona directory whenever that
   * directory is writable, so "the plugin left something behind" has exactly one
   * answer; beside the profile home only in the read-only fallback.
   */
  const overrideFile = writable
    ? path.join(dir, OVERRIDE_FILE_IN_DIR)
    : path.join(homeFromEnv(process.env).home, OVERRIDE_FILE);
  const legacyOverrideFile = path.join(
    homeFromEnv(process.env).home,
    LEGACY_OVERRIDE_FILE,
  );

  /** session id -> { personaId, at }; loaded once, rewritten atomically. */
  let overrides = null;

  function readOverrides() {
    if (overrides !== null) return overrides;
    const rows = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
      const stored =
        parsed !== null && typeof parsed === "object" ? parsed.overrides : null;
      if (stored !== null && typeof stored === "object") {
        for (const [sessionId, value] of Object.entries(stored)) {
          const personaId = oneLine(value?.personaId);
          if (sessionId !== "" && personaId !== "")
            rows[sessionId] = { personaId, at: Number(value?.at) || 0 };
        }
      }
    } catch {
      // A missing or unreadable file means "no overrides" — never a failed boot.
    }
    overrides = rows;
    return overrides;
  }

  function writeOverrides() {
    const ordered = Object.entries(readOverrides()).sort(
      (a, b) => (b[1].at ?? 0) - (a[1].at ?? 0),
    );
    overrides = Object.fromEntries(ordered.slice(0, OVERRIDE_LIMIT));
    try {
      fs.mkdirSync(path.dirname(overrideFile), { recursive: true });
      const stage = `${overrideFile}.stage-${process.pid}`;
      fs.writeFileSync(
        stage,
        JSON.stringify({ version: 1, overrides }, null, 2),
        "utf8",
      );
      fs.renameSync(stage, overrideFile);
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 覆盖记录写不进去：${error?.message ?? error}`,
      );
    }
  }

  function overrideOf(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") return null;
    const hit = readOverrides()[sessionId];
    return hit === undefined ? null : hit.personaId;
  }

  /** Point one session at one persona, or — with `null` — clear it. */
  function setOverride(sessionId, personaId) {
    if (typeof sessionId !== "string" || sessionId === "") return false;
    const rows = readOverrides();
    if (personaId === null || oneLine(personaId) === "") delete rows[sessionId];
    else rows[sessionId] = { personaId: oneLine(personaId), at: Date.now() };
    writeOverrides();
    return true;
  }

  /**
   * Collect the 0.3.x override file that sat beside the profile home, then
   * delete it.
   *
   * Reading only the new path would silently drop every per-session choice made
   * before the upgrade, and leaving the old file behind is exactly the residue an
   * uninstall gets judged on. Runs once, at `apply`; a read-only directory has no
   * new path to fold into and is skipped.
   * @returns {boolean} whether a legacy file was found and removed
   */
  function foldLegacyOverrides() {
    if (!writable || legacyOverrideFile === overrideFile) return false;
    let parsed;
    try {
      if (!fs.existsSync(legacyOverrideFile)) return false;
      parsed = JSON.parse(fs.readFileSync(legacyOverrideFile, "utf8"));
    } catch {
      return false;
    }
    const stored =
      parsed !== null && typeof parsed === "object" ? parsed.overrides : null;
    if (stored !== null && typeof stored === "object") {
      const rows = readOverrides();
      for (const [sessionId, value] of Object.entries(stored)) {
        const personaId = oneLine(value?.personaId);
        if (
          sessionId === "" ||
          personaId === "" ||
          rows[sessionId] !== undefined
        )
          continue;
        rows[sessionId] = { personaId, at: Number(value?.at) || 0 };
      }
      writeOverrides();
    }
    try {
      fs.rmSync(legacyOverrideFile, { force: true });
      ctx.logger?.info?.(
        `dsh-waifu-agents: 会话覆盖已收进 ${overrideFile}，旧的 ${legacyOverrideFile} 已删除。`,
      );
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 旧覆盖文件删不掉：${error?.message ?? error}`,
      );
    }
    return true;
  }
  foldLegacyOverrides();

  /**
   * One persona's assembled text as the disk has it right now.
   * @returns {{ ok: boolean, text: string, name: string, problems: string[] } | null}
   */
  function personaText(id) {
    const full = fileFor(id);
    let parsed;
    try {
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
      parsed = readPersona(full);
    } catch {
      return null;
    }
    const name = oneLine(parsed.meta.name) || id;
    const skeleton = readSkeleton();
    const poured = assemble(
      name,
      parsed.body,
      skeletonFor(parsed.meta, skeleton) === null ? null : skeleton.text,
    );
    if (poured.ok) return { ok: true, text: poured.text, name, problems: [] };
    return {
      ok: false,
      text: String(parsed.body ?? ""),
      name,
      problems: poured.problems,
    };
  }

  /**
   * Text that is safe to hand to the renderer, or null.
   *
   * A persona still carrying an illegal `{{…}}` would take the whole system
   * prompt down at interpolation time — the one failure this plugin must never
   * cause. An unusable candidate is skipped, never sent.
   */
  function safeText(id) {
    const candidate = personaText(id);
    if (candidate === null) return null;
    if (candidate.ok) return candidate;
    const check = assemble(candidate.name, candidate.text, null);
    if (!check.ok) return null;
    return { ok: true, text: check.text, name: candidate.name, problems: [] };
  }

  /** Last text each session was actually served — the final rung, never empty. */
  const lastGood = new Map();

  /**
   * The display names a session has already been served, oldest first.
   *
   * This exists because the system prompt is NOT the strongest identity signal in
   * a request. Measured on a real conversation: after a switch the loop rewrites
   * the prompt in place (the previous system node is emptied, only the new persona
   * stays model-visible) and the new text is served correctly — and the model
   * still answered as the FIRST persona it had introduced itself as. Its own
   * earlier turns outrank the system prompt. A revocation that names that identity
   * contradicts those turns; 「其它身份一律作废」 never says which words are wrong,
   * and was measured not to work.
   */
  const servedNames = new Map();
  /** Enough to name every identity the model could still be carrying. */
  const SERVED_NAMES_LIMIT = 4;

  /** Cached global default: the provider is synchronous, this read is not. */
  let cachedDefault = { id: null, field: undefined, source: null, error: null, at: 0 };

  /**
   * Re-read which wife the next session will actually use.
   *
   * The 2-second window below exists because `configEditor.edit()` settles the
   * patch file before the Loader has re-activated the row, so a reread issued
   * immediately after a write can still answer with the PREVIOUS id. Hiding that
   * gap behind a cache is only honest for a write this process just made and has
   * already CONFIRMED — which is why every writer goes through
   * {@link verifyDefault} and only lands here once the live read agrees.
   * `force` is how that verifier reads through the window instead of being fed
   * its own optimism back.
   *
   * @param {{ force?: boolean }} [options] `force` bypasses the post-write window
   */
  async function refreshDefault(options = {}) {
    if (
      options.force !== true &&
      cachedDefault.source === "settings" &&
      Date.now() - cachedDefault.at < 2000
    ) {
      return cachedDefault;
    }
    try {
      const found = await readDefaultId();
      cachedDefault = {
        id: found.id,
        field: found.field,
        source: found.source,
        error: found.error,
        at: Date.now(),
      };
    } catch (error) {
      cachedDefault = {
        id: null,
        field: undefined,
        source: null,
        error: String(error?.message ?? error),
        at: Date.now(),
      };
    }
    return cachedDefault;
  }

  /** Enough attempts, at 50ms, to outlast the Loader re-activating one row. */
  const DEFAULT_VERIFY_TRIES = 12;
  const DEFAULT_VERIFY_WAIT_MS = 50;

  /**
   * Wait for a just-written `selectedDefault` to become what the registry holds.
   *
   * The write is NOT the truth; the reread is. Reporting the write on its own is
   * how the panel and the platform disagree: the roster and the panel readers
   * then name an id the registry does not have, the row the user just moved the
   * default off keeps wearing the active border (直到下一次进入才自愈), and the
   * next new task comes up on the profile default instead of the wife the user
   * had just chosen. Poll briefly instead of guessing.
   *
   * `field` is the explicit `selectedDefault` as the settings face reports it —
   * `null` when it is deliberately unset — and is `undefined` on a profile with
   * no `settings` face at all. Only the first form can confirm a CLEAR; the
   * roster faces resolve 「没指定」 to the profile default and cannot tell the two
   * apart, so they are checked against `previous` instead.
   *
   * @param {string | null} wanted the value the write committed; `null` = 谁都不指定
   * @param {{ previous?: string | null, checkable?: boolean }} [context] what the
   *   read said before the write, and whether any face can confirm the field
   * @returns {Promise<{ id: string | null, verified: boolean, checkable: boolean, attempts: number }>}
   */
  async function verifyDefault(wanted, context = {}) {
    const previous = context.previous ?? null;
    let checkable = context.checkable === true;
    let seen = previous;
    for (let attempt = 1; attempt <= DEFAULT_VERIFY_TRIES; attempt += 1) {
      const found = await refreshDefault({ force: true });
      seen = found.id;
      if (found.field !== undefined) {
        checkable = true;
        if (found.field === wanted)
          return { id: found.id, verified: true, checkable, attempts: attempt };
      } else if (seen !== null) {
        // A roster face that carries `isDefault` resolved SOME id. For a non-null
        // `wanted` that is a real check; for a clear it is the profile default
        // showing through, which is why the clear path stays gated on `field`.
        if (wanted === null) {
          if (seen !== previous)
            return { id: seen, verified: true, checkable, attempts: attempt };
        } else {
          checkable = true;
          if (seen === wanted)
            return { id: seen, verified: true, checkable, attempts: attempt };
        }
      }
      if (attempt < DEFAULT_VERIFY_TRIES)
        await new Promise((resolve) => setTimeout(resolve, DEFAULT_VERIFY_WAIT_MS));
    }
    return { id: seen, verified: false, checkable, attempts: DEFAULT_VERIFY_TRIES };
  }
  /** Which persona one session resolves to right now, and through which rung. */
  function sessionPersona(sessionId, mountedId) {
    const overrideId = overrideOf(sessionId);
    const rungs = orderPersonaIds({
      overrideId,
      mountedId,
      defaultId: cachedDefault.id,
    });
    for (const id of rungs) {
      const found = safeText(id);
      if (found === null) continue;
      const source =
        id === overrideId
          ? "override"
          : id === oneLine(mountedId)
            ? "mounted"
            : "default";
      return { id, source, text: found.text, name: found.name, rungs };
    }
    return { id: null, source: "none", text: null, name: null, rungs };
  }

  /**
   * The switch notice: in front of an overridden persona, and again behind it.
   *
   * The persona text IS a system prompt, but swapping it mid-conversation is a
   * weak signal: the history is already full of the previous voice, so a model
   * that keeps answering as her is the single most-reported "换人没生效". Saying
   * it in the served text is what re-anchors that turn. The mounted case needs no
   * line, because there the text never changed under a running conversation.
   *
   * It is said TWICE on purpose. `@deepseek-ai/dsh-persona` mounts this text as
   * the one `complete: true` section, so the served string is the WHOLE prompt —
   * and an incapable route makes the loop rewrite the FIRST system node in place,
   * i.e. at position 0, ahead of a conversation that already contains the
   * previous wife's turns (measured in `dsh-agent-loop`'s
   * `SystemPromptProjection.project`: the replacement carries
   * `surfaceOp: {op:'replace'}` on the head node). Instructions the model meets
   * once, at the very top, are the ones it drifts away from; the trailer is
   * placed where the settings end and the conversation begins.
   *
   * `previous` names the personas this session was served before now, and they are
   * spelled out for the reason in {@link servedNames}.
   * @param {string} text the assembled persona
   * @param {string} name her display name
   * @param {string[]} [previous] identities served earlier in this session
   * @returns {string} the text to serve
   */
  function withSwitchNotice(text, name, previous = []) {
    if (config.switchNotice === false) return text;
    const names = (Array.isArray(previous) ? previous : []).filter(
      (value) => typeof value === "string" && value !== "" && value !== name,
    );
    const quoted = names.map((value) => `「${value}」`).join("、");
    const revoke =
      names.length === 0
        ? ""
        : `你此前在这个对话里是以${quoted}的身份回答的——那些话从现在起全部作废：你不是${names.join("，也不是")}。`;
    const trailer =
      names.length === 0
        ? `\n\n【本轮身份 · 最后确认】上面整段就是「${name}」的全部设定。从这一轮第一句话起，用她的口气说话、用她的口气思考，不要再退回中立助手腔。`
        : `\n\n【本轮身份 · 最后确认】上面整段就是「${name}」的全部设定。${quoted}都不是你了：别用她们的名字、口气、自称或口头禅，也别再提你「之前」是谁——照上面这一份重来。从这一轮第一句话起，连思考链都用「${name}」的口气走。`;
    return `【人设已切换】你现在是「${name}」。${revoke}下面整段就是她的全部设定；本对话里更早出现的其它身份、语气与自称一律作废，从这一轮起只按这一份来。\n\n${text}${trailer}`;
  }

  /**
   * The persona this session is ACTUALLY anchored to, right now.
   *
   * The session header keeps only the preset the session was born with, and it
   * never moves again. The live answer lives in the `agentPreset` session
   * projection, which every `agent-preset/selected` event advances — the
   * registry says so itself (`dsh-agent-preset-registry/lib/index.js:42`:
   * "Reconstruction reads the `agentPreset` Session projection, never the
   * header"). Reading the header is how a session re-pointed from the UI kept
   * answering as the plugin's global default: the title-bar tag showed the
   * newly chosen name while the prompt still carried the stale one, so every
   * later choice looked like it had not taken.
   *
   * Falls back to the header only when no projection service is reachable; the
   * provider here is synchronous, so this must stay synchronous too.
   * @param {unknown} agent the live agent
   * @returns {string} the anchor preset id, or `""` when there is none
   */
  function anchorOf(agent) {
    const session = agent?.session;
    if (session === undefined || session === null) return "";
    try {
      const projections = ctx.get("sessionProjections", false);
      const projected = oneLine(projections?.stateOf?.(session, "agentPreset"));
      if (projected !== "") return projected;
    } catch {
      // No projection service (or none for this key): the header is the only
      // thing left to read, and "no anchor" beats a throw in this path.
    }
    return oneLine(session.header?.agentPreset);
  }

  /**
   * A service, looked up the two ways a cordis context offers it.
   *
   * `ctx.name` is the declared form and is the one to trust: a name in this
   * plugin's `inject` list is guaranteed present, while a bare `ctx.get(name)`
   * answers only while the providing fiber is ACTIVE — the same trap the
   * plugin-manager lookup documents. Neither form is allowed to throw here,
   * because every caller has a defined "not available" answer.
   *
   * @param {string} name
   * @returns {object | undefined}
   */
  function serviceOf(name) {
    try {
      const declared = ctx[name];
      if (declared !== undefined && declared !== null) return declared;
    } catch {
      /* a strict context refuses the property read; `get` may still answer */
    }
    try {
      return ctx.get(name) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Every Agent this process is currently driving, or `undefined` when the
   * service is not there to ask.
   *
   * `undefined` and `[]` are kept apart on purpose: an empty list means "nobody
   * is live", while a missing service means "this build does not let me look" —
   * and the caller that moves sessions needs to tell those apart to know whether
   * doing nothing was a decision or a failure.
   *
   * @returns {object[] | undefined}
   */
  function liveAgents() {
    const registry = serviceOf("agents");
    return typeof registry?.list === "function" ? registry.list() : undefined;
  }

  /** The live agent for a session id, while this process still has one. */
  function liveAgentFor(sessionId) {
    if (sessionId === "") return undefined;
    const live = liveAgents();
    if (live === undefined) return undefined;
    return live.find((agent) => oneLine(agent?.session?.id) === sessionId);
  }

  /**
   * What a session's chip is showing right now.
   *
   * The projection, not the header: `agentPresetProjectionDefinition.init` reads
   * `header.agentPreset` once and every later move is an `agent-preset/selected`
   * event folded on top, so the two disagree the moment a session has been
   * re-selected — which is the whole subject here. The header is only the
   * fallback for a build whose projections service is not reachable.
   *
   * @param {object} session
   * @returns {string} the id, or "" when nothing names one
   */
  function shownPresetOf(session) {
    try {
      const projections = serviceOf("sessionProjections");
      if (projections !== undefined && typeof projections.stateOf === "function") {
        const value = projections.stateOf(session, "agentPreset");
        if (typeof value === "string" && value !== "") return value;
      }
    } catch {
      /* fall through to the header */
    }
    return oneLine(session?.header?.agentPreset);
  }

  /**
   * Move the session's own preset label onto the wife it is now talking as.
   *
   * The chip above a conversation is not ours: `ui-agent-preset` renders
   * `session.projectionValues.agentPreset` (`presetOf`), and that projection is
   * advanced by exactly one event type —
   *
   *     apply: (state, event) =>
   *       event.type === "agent-preset/selected" ? event.data.agentPreset : state
   *
   * — written by the platform's own `select()`. Which is why a switched session
   * kept showing the wife it was BORN with, and why 「这里能动态调整吗」 had no
   * obvious answer.
   *
   * `select()` itself is unavailable here: for a session that has already opened
   * a turn it throws `agent-preset/locked`, because naming a new preset means
   * rebuilding that preset's whole plugin tree — tools included. This appends the
   * event ALONE, which moves the label and changes nothing about the running
   * tree. The persona is already served by the override, so what the label says
   * and what the model is told finally agree.
   *
   * Two guards, both load-bearing:
   *   - Only a REGISTERED preset may be named. The value is persisted, and a
   *     restored session mounts what its projection names — an id nobody serves
   *     would turn the next resume into a failed restore.
   *   - `syncSessionChip: false` turns the whole thing off, because naming the
   *     wife here is also what makes a resumed session come back as her.
   *
   * @param {unknown} agent the live agent owning the session
   * @param {string} id the persona id to name
   * @returns {boolean} whether the label was moved
   */
  function rememberSessionPreset(agent, id) {
    if (config.syncSessionChip === false) return false;
    const session = agent?.session;
    if (session === undefined || session === null) return false;
    if (!owned.has(id)) return false;
    try {
      session.append("agent-preset/selected", { agentPreset: id });
      return true;
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 会话标签没跟上（${id}）：${error?.message ?? error}`,
      );
      return false;
    }
  }

  /**
   * Put the label back on what this session resolves to with no override: the
   * preset it was mounted with, else the global default.
   *
   * `/waifu-reset` used to leave the chip naming the wife that had just been
   * dropped, which is the same lie in the other direction.
   *
   * @param {unknown} agent the live agent owning the session
   * @returns {boolean} whether the label was moved
   */
  function restoreSessionPreset(agent) {
    if (config.syncSessionChip === false) return false;
    const session = agent?.session;
    if (session === undefined || session === null) return false;
    const mounted = oneLine(session.header?.agentPreset);
    // A mounted id is whatever the session already had, so it is safe by
    // construction. The default is only usable when it is one of ours.
    const resting = mounted !== "" ? mounted : oneLine(cachedDefault.id);
    if (resting === "") return false;
    if (mounted === "" && !owned.has(resting)) return false;
    try {
      session.append("agent-preset/selected", { agentPreset: resting });
      return true;
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 会话标签没复原：${error?.message ?? error}`,
      );
      return false;
    }
  }

  /**
   * Move the unstarted sessions onto the default that was just made theirs.
   *
   * Writing `selectedDefault` only decides what a session created LATER will be
   * stamped with. A session that already exists — including the blank one sitting
   * on the new-task screen, whose chip is the thing the user is actually looking
   * at — keeps the `agentPreset` its header was stamped with at creation, because
   * `agentPresetProjectionDefinition.init` reads the header once and only an
   * `agent-preset/selected` event ever moves it afterwards.
   *
   * That is the second half of what `Settings → Agent Presets` does, and the half
   * a settings write cannot reproduce. Its `save()` runs
   *
   *     await write()            // settings.update(ns, { selectedDefault })
   *     await this.load()        // re-read the roster
   *     await sync(selected.id)  // syncBlankSession → seat.apply() → select()
   *
   * so the official page moves the default AND re-seats the blank session on it,
   * while the plugin used to do only the first. The chip then kept naming the wife
   * the blank session was born with: 「插件里改默认，新会话没跟着变」, with the
   * registry already correct — which is why the Agent-Presets page showed the
   * right badge at the same moment.
   *
   * `select()` is the mover, not a hand-rolled append. For a session that has not
   * opened a turn it re-binds the preset tree and THEN appends the event, which is
   * what keeps the chip and the composition agreeing; an append alone would leave
   * the new label on top of the old tree. It also brings the guard we want for
   * free: a session that has already started a turn is refused with
   * `agent-preset/locked`, so the refusals are the filter instead of a blank test
   * guessed from here.
   *
   * The blast radius is held to sessions that were still following the PREVIOUS
   * default. One the user pointed somewhere else on purpose — a new-task screen
   * already staged onto `minimal`, say — must not be dragged along by a change
   * to the global default.
   *
   * @param {{ to: string, from: string | null }} options the resolved default
   *   after the write, and the resolved default before it
   * @returns {Promise<{ moved: string[], refused: number, reason: string | null }>}
   */
  async function resettleUnstarted({ to, from }) {
    const done = { moved: [], refused: 0, reason: null };
    if (oneLine(to) === "" || from === null || from === "") {
      done.reason = "没有可比的旧默认";
      return done;
    }
    if (oneLine(to) === oneLine(from)) {
      done.reason = "默认没变";
      return done;
    }
    const presets = serviceOf("agentPresets");
    if (presets === undefined || typeof presets.select !== "function") {
      done.reason = "这个环境拿不到 agentPresets.select";
      return done;
    }
    const live = liveAgents();
    if (live === undefined) {
      done.reason = "这个环境拿不到 agents 服务";
      return done;
    }
    for (const agent of live) {
      const session = agent?.session;
      if (session === undefined || session === null) continue;
      if (shownPresetOf(session) !== from) continue;
      try {
        await presets.select(agent, to);
        done.moved.push(oneLine(session.id));
      } catch {
        // `agent-preset/locked` for a session that has already started a turn —
        // the platform refusing is the correct answer, not a failure worth
        // reporting.
        done.refused += 1;
      }
    }
    return done;
  }

  /**
   * The prompt variable every persona row points at; called once per assembly.
   *
   * It must never throw and never return text the renderer would choke on: a
   * throw here means the session cannot start at all, which is a far worse
   * outcome than serving the previous persona one turn too long.
   */
  function resolvePersonaText(context) {
    const agent = context?.agent;
    const raw = agent?.session?.id;
    const sessionId = typeof raw === "string" ? raw : "";
    const mountedId = anchorOf(agent);
    try {
      const found = sessionPersona(sessionId, mountedId);
      if (found.text !== null) {
        const before = sessionId === "" ? [] : (servedNames.get(sessionId) ?? []);
        const served =
          found.source === "override"
            ? withSwitchNotice(found.text, found.name, before)
            : found.text;
        if (sessionId !== "") {
          lastGood.set(sessionId, served);
          servedNames.set(
            sessionId,
            [...before.filter((value) => value !== found.name), found.name].slice(
              -SERVED_NAMES_LIMIT,
            ),
          );
        }
        return served;
      }
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 解析人设失败：${error?.message ?? error}`,
      );
    }
    const previous = sessionId === "" ? undefined : lastGood.get(sessionId);
    if (previous !== undefined) return previous;
    ctx.logger?.warn?.(
      `dsh-waifu-agents: 会话 ${sessionId || "(未知)"} 没有人设可用，这一段提示词会留空。`,
    );
    return "";
  }

  /** Registered once, at apply: it outlives every preset and every session. */
  ctx.systemPrompt.variable("waifu_persona", resolvePersonaText);

  /** Ours alone; `contexts` reject a duplicate name inside one scope. */
  const IDENTITY_CONTEXT_NAME = "waifu-agents:identity";
  /** Last, so the identity is the final line of the snapshot the model reads. */
  const IDENTITY_CONTEXT_ORDER = 900;

  /**
   * The per-turn identity snapshot — the only channel that actually re-anchors a switch.
   *
   * The persona is a system prompt, and swapping a system prompt mid-conversation
   * turned out to be too weak a signal. Measured on this profile
   * (`commandcode` / `deepseek-v4-flash`, `session-b6fb8a2b`):
   *
   *   - three `/waifu-change` calls, and the session surface ended up with a
   *     single system node carrying the NEWEST wife (2084 chars, the only
   *     `system: true` node in `contextBreakdown`, `surfaceOp: {op:'replace'}`,
   *     `cacheReadTokens: 0` — so the request really did carry it);
   *   - and the model answered as the FIRST wife all three times, reasoning
   *     「the system prompt of this session says I'm 宫内光华」 while the request
   *     said otherwise. Its own two earlier answers were the anchor, not the
   *     prompt.
   *
   * So the identity is said again where the model cannot get away from it. A
   * `systemPrompt.context()` contribution is NOT a prompt section: the loop
   * projects it into the session surface as a USER-role snapshot appended AFTER
   * the user's message (`dsh-agent-loop` `preStep` → `RuntimeContextProjection`),
   * wrapped in the platform's own header — 「Current runtime context. This
   * snapshot supersedes earlier runtime-context snapshots.」 And it is re-emitted
   * only when its text CHANGES, which is exactly when the wife changes.
   *
   * Two consequences worth remembering:
   *   - The snapshot name goes through `interpolate()`, so this text must never
   *     contain a `{{…}}` group.
   *   - `@deepseek-ai/dsh-persona` ships in `template.json` with
   *     `includeRuntimeContext: false`, and that suppressor drops EVERY context
   *     in the agent scope — this one included. The template row has to stop
   *     suppressing before any of this is served.
   *
   * Empty for a session nobody switched, on purpose: an untouched session has a
   * single voice and needs no reminder, and staying silent keeps its prompt
   * byte-for-byte what it was before this existed.
   *
   * @param {unknown} agent the live agent
   * @returns {string} the snapshot text, or `''` when there is nothing to say
   */
  function identityNoticeOf(agent) {
    const raw = agent?.session?.id;
    const sessionId = typeof raw === "string" ? raw : "";
    if (sessionId === "") return "";
    try {
      const found = sessionPersona(sessionId, anchorOf(agent));
      if (found.id === null) return "";
      // Only a session that was MOVED needs saying. The mounted case never had a
      // competing voice, so a reminder there would be noise in every request.
      if (found.source !== "override") return "";
      return `【本轮身份 · 运行时确认】这个会话现在的人设是「${found.name}」。上面更早出现的其它人设、以及你自己之前以别人身份说过的话，从现在起全部作废：按「${found.name}」说话、按她的口气思考。不要向用户解释这次变化，也不要提你「之前」是谁。`;
    } catch (error) {
      // Never throw: this runs inside `assemble()`, and a throw there fails the
      // whole request. Serving the previous identity one turn too long is the
      // far smaller loss.
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 组装身份快照失败：${error?.message ?? error}`,
      );
      return "";
    }
  }

  ctx.systemPrompt.context({
    name: IDENTITY_CONTEXT_NAME,
    order: IDENTITY_CONTEXT_ORDER,
    text: (context) =>
      config.identityReminder === false ? "" : identityNoticeOf(context?.agent),
  });

  // The registry writes `selectedDefault` through the settings document, so this
  // is the one signal that keeps the synchronous cache honest.
  ctx.on("settings/document-updated", (namespace) => {
    if (namespace === REGISTRY_NS) void refreshDefault();
  });
  void refreshDefault();

  /**
   * The shadow for a session whose composition carries no persona row at all
   * (profile default `cordis`, say): the placeholder is not in that prompt, so
   * give that one agent a nearer section of its own. The disposer rides the
   * agent's scope, and `/waifu-reset` removes it early when nothing is left to
   * follow.
   */
  const shadows = new Map();

  function ensureShadow(agent) {
    const sessionId = oneLine(agent?.session?.id);
    const agentCtx = agent?.ctx;
    if (
      sessionId === "" ||
      agentCtx === undefined ||
      agentCtx === null ||
      typeof agentCtx.effect !== "function"
    ) {
      return {
        ok: false,
        error:
          '拿不到这个会话的 agent 作用域，没法给"本来没人设"的会话单独挂一个人设。',
      };
    }
    if (shadows.has(sessionId)) return { ok: true };
    try {
      const dispose = agentCtx.effect(
        () =>
          agentCtx.systemPrompt.section({
            name: "deployment:persona-prefix",
            order: agentCtx.systemPrompt.getSectionOrder(
              "DEPLOYMENT_PERSONA_PREFIX",
            ),
            text: () => resolvePersonaText({ agent }),
            complete: true,
          }),
        "waifu-agents: session persona shadow",
      );
      shadows.set(sessionId, dispose);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `挂不上会话人设：${error?.message ?? error}` };
    }
  }

  function dropShadow(sessionId) {
    const dispose = shadows.get(sessionId);
    if (dispose === undefined) return;
    shadows.delete(sessionId);
    try {
      dispose();
    } catch {
      // The agent's scope may already be gone; its effect went with it.
    }
  }

  /** Does this session's composition carry one of our persona rows? */
  function hasPersonaRow(mountedId) {
    const id = oneLine(mountedId);
    if (id === "") return false;
    return owned.has(id) || personaText(id) !== null;
  }

  function readTemplate() {
    const rows = JSON.parse(fs.readFileSync(templatePath, "utf8"));
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(
        `${templatePath}: expected a non-empty array of plugin rows`,
      );
    }
    return rows;
  }

  function listFiles() {
    if (!fs.existsSync(dir)) return [];
    const seen = new Set();
    const out = [];
    const skeleton = readSkeleton();
    for (const entry of fs.readdirSync(dir).sort()) {
      if (!entry.endsWith(".md") || SKIP.has(entry)) continue;
      const full = path.join(dir, entry);
      if (!fs.statSync(full).isFile()) continue;
      seen.add(full);
      const id = path.basename(entry, ".md");
      const parsed = readPersona(full);
      const name = oneLine(parsed.meta.name) || id;
      const poured = assemble(
        name,
        parsed.body,
        skeletonFor(parsed.meta, skeleton) === null ? null : skeleton.text,
      );
      out.push({
        id,
        idOk: ID_OK.test(id),
        name,
        order: normalizeOrder(parsed.meta.order) ?? null,
        description: oneLine(parsed.meta.description) || null,
        group: oneLine(parsed.meta.group) || null,
        template: oneLine(parsed.meta.template) || null,
        chars: parsed.chars,
        charsFull: poured.text.length,
        problems: poured.problems,
        owned: owned.has(id),
        mtimeMs: parsed.mtimeMs,
        size: parsed.size,
      });
    }
    for (const key of [...fileCache.keys()])
      if (!seen.has(key)) fileCache.delete(key);
    return out;
  }

  /** Highest order in the directory plus one — the panel never asks for it. */
  function nextOrder() {
    let max = 0;
    for (const item of listFiles()) {
      if (typeof item.order === "number" && item.order > max) max = item.order;
    }
    return max + 1;
  }

  /**
   * The file name a display name gets: the name slugified, kept unique against
   * every other file in the directory.
   *
   * The id is invisible, so this is the only thing holding "file name, `name`
   * field, row title" together as one thing. `self` is the file being saved:
   * without it, saving an unchanged name would collide with its own file and
   * land on `name-2` — which is exactly how a no-op edit used to fork a wife in
   * two. Unicode survives verbatim, so `后藤一里` is the name *and* the file
   * name; only what a file name cannot carry (spaces, `/`, punctuation) folds
   * to `-`, and a name that folds away to nothing falls back to `persona`, then
   * `persona-2`, `persona-3`…
   * @param {string} name display name
   * @param {string | null} [self] the id that currently holds this wife, if any
   * @returns {string} a legal, currently free id
   */
  function idForName(name, self = null) {
    const slug = oneLine(name)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    const taken = new Set(listFiles().map((item) => item.id));
    if (self !== null) taken.delete(self);
    const base = ID_OK.test(slug) ? slug : "persona";
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  async function unregister(id) {
    const entry = owned.get(id);
    if (entry === undefined) return false;
    owned.delete(id);
    await entry.dispose();
    return true;
  }

  /**
   * Assemble, then register. Validation lives HERE rather than in each caller so
   * that no path — panel, command, or scan — can register a body the prompt
   * renderer would choke on.
   */
  async function registerOne(id, meta, body) {
    const templateIssue = templateProblem(meta);
    if (templateIssue !== null) throw new Error(templateIssue);
    const skeleton = skeletonFor(meta, readSkeleton());
    const name = oneLine(meta.name) || id;
    const poured = assemble(
      name,
      body,
      skeleton === null ? null : skeleton.text,
    );
    if (!poured.ok) throw new Error(poured.problems.join("；"));
    const dispose = await ctx.agentPresets.register(
      buildDefinition(id, meta, body, readTemplate(), skeleton),
    );
    ctx.on("dispose", dispose);
    owned.set(id, { dispose, rev: registrationRev(skeleton, body) });
  }

  /**
   * Register every file that is not already taken by this or another owner, and
   * RE-register the ones whose text changed since they were registered.
   *
   * The second half is what makes 「刷新」 mean something after an edit: a scan
   * that only adopts new files leaves an edited wife answering with her old text
   * until the next restart, which is exactly the surprise the panel gets blamed
   * for.
   */
  async function scan() {
    const taken = new Set();
    try {
      for (const preset of await ctx.agentPresets.list()) taken.add(preset.id);
    } catch (error) {
      return {
        added: [],
        reloaded: [],
        skipped: [],
        problems: [`读不到名册：${error.message ?? error}`],
      };
    }
    const added = [];
    const reloaded = [];
    const skipped = [];
    const problems = [];
    for (const item of listFiles()) {
      if (!item.idOk) {
        problems.push(
          `${item.id}.md: 文件名不是合法的 preset id（只允许字母、数字、连字符，可以中文）`,
        );
        continue;
      }
      if (item.problems.length > 0) {
        problems.push(`${item.id}.md: ${item.problems.join("；")}`);
        continue;
      }
      const parsed = readPersona(fileFor(item.id));
      if (!parsed.body) {
        problems.push(`${item.id}.md: 正文是空的`);
        continue;
      }
      const rev = registrationRev(
        skeletonFor(parsed.meta, readSkeleton()),
        parsed.body,
      );
      const owner = owned.get(item.id);
      if (owner !== undefined) {
        if (owner.rev === rev) continue;
        await unregister(item.id);
        try {
          await registerOne(item.id, parsed.meta, parsed.body);
          reloaded.push(item.id);
        } catch (error) {
          problems.push(`${item.id}: ${error.message ?? error}`);
        }
        continue;
      }
      if (taken.has(item.id)) {
        skipped.push({ id: item.id, reason: "已经有人注册了这个 id" });
        continue;
      }
      try {
        await registerOne(item.id, parsed.meta, parsed.body);
        added.push(item.id);
      } catch (error) {
        problems.push(`${item.id}: ${error.message ?? error}`);
      }
    }
    return { added, reloaded, skipped, problems };
  }

  /**
   * Which wife the next session will actually use.
   *
   * The roster is the authority, but the service exposes it on more than one
   * face and they are not interchangeable:
   *   - `remoteExportList()` returns `AgentPresetRow`, documented with
   *     `isDefault: boolean` ("each marked when it is the default");
   *   - `compositionInventory()` returns `AgentPresetComposition`, which also
   *     declares `isDefault: boolean`;
   *   - `list()` returns `AgentPreset`, whose shape is *not* promised to carry
   *     the flag at all.
   * So probe all three in that order and take the first face that answers.
   * Trusting `list()` alone is exactly how the panel lost the selected row.
   *
   * `source` is the first face that returned rows at all, which is what tells
   * "nobody is the default" apart from "this face does not report it".
   *
   * @returns {Promise<{ id: string | null, source: string | null, error: string | null }>}
   */
  async function readDefaultId() {
    let source = null;
    // The explicit `selectedDefault` as the settings face holds it: a string, or
    // `null` when it is deliberately unset. `undefined` means no face on this
    // profile can express the difference, which is what tells a writer whether a
    // CLEAR is checkable at all.
    let field;
    const failures = [];
    // The field this panel WRITES, read back first. `selectedDefault` is what the
    // registry actually mounts for a new session, so trusting the roster's
    // `isDefault` instead is how the switch and the border ended up disagreeing:
    // the panel wrote one field and displayed another.
    try {
      const settings = ctx.get("settings");
      const described =
        settings === undefined || settings === null
          ? null
          : settings.describe?.();
      if (Array.isArray(described)) {
        if (source === null) source = "settings";
        for (const row of described) {
          if (oneLine(row?.ns) !== REGISTRY_NS) continue;
          const picked = oneLine(row?.value?.selectedDefault);
          field = picked === "" ? null : picked;
          if (picked !== "")
            return { id: picked, source: "settings", error: null, field };
          break;
        }
        // Compatibility net: the registry is the only row that declares this
        // field, but a deployment that moved it must not lose the default.
        for (const row of described) {
          const picked = oneLine(row?.value?.selectedDefault);
          if (picked !== "")
            return { id: picked, source: "settings", error: null, field: picked };
        }
      }
    } catch (error) {
      failures.push(`settings: ${error?.message ?? error}`);
    }
    for (const [face, read] of [
      [
        "remoteExportList",
        async () => (await ctx.agentPresets.remoteExportList?.())?.presets,
      ],
      [
        "compositionInventory",
        async () => await ctx.agentPresets.compositionInventory?.(),
      ],
      ["list", async () => await ctx.agentPresets.list?.()],
    ]) {
      try {
        const rows = await read();
        if (!Array.isArray(rows)) continue;
        if (source === null) source = face;
        const hit = rows.find((row) => row?.isDefault === true);
        if (hit !== undefined && typeof hit.id === "string" && hit.id !== "") {
          return { id: hit.id, source: face, error: null, field };
        }
      } catch (error) {
        failures.push(`${face}: ${error?.message ?? error}`);
      }
    }
    return {
      id: null,
      source,
      error: failures.length > 0 ? failures.join("；") : null,
      field,
    };
  }

  /**
   * Panel state. `defaultId` comes from the LIVE roster rather than from the
   * config file: `selectedDefault` can be stale, or point at a preset that no
   * longer resolves, and the roster is what actually decides the next session.
   */
  async function status() {
    // Live, not straight from the cache: `selectedDefault` can be stale or point
    // at a preset that no longer resolves, and the roster is what actually decides
    // the next session. Reporting the cached id is how the default's active border
    // stayed on a row the user had already moved off.
    await refreshDefault();
    const skeleton = readSkeleton();
    return {
      ok: true,
      dir,
      dirSource,
      writable,
      dirExists: fs.existsSync(dir),
      template: templatePath,
      configurable: Boolean(ctx.get("configEditor")),
      defaultId: cachedDefault.id,
      defaultSource: cachedDefault.source,
      defaultError: cachedDefault.error,
      skeleton: {
        present: skeleton !== null,
        file: skeleton === null ? path.join(dir, SKELETON_FILE) : skeleton.file,
        chars: skeleton === null ? 0 : skeleton.chars,
        slots:
          skeleton === null ? 0 : skeleton.text.split("[[body]]").length - 1,
        rev: skeleton === null ? null : skeleton.rev,
      },
      owned: [...owned.keys()].sort(),
      files: listFiles(),
    };
  }

  /** Everything the editor needs to fill its fields — plus the token it hands back on save. */
  function readOne(request) {
    const id = String(request.id ?? "").trim();
    if (!ID_OK.test(id))
      return { ok: false, error: `id 不合法：${id || "(空)"}` };
    const full = fileFor(id);
    if (!fs.existsSync(full))
      return { ok: false, error: `文件不存在：${full}` };
    const parsed = readPersona(full);
    const name = oneLine(parsed.meta.name) || id;
    const skeleton = skeletonFor(parsed.meta, readSkeleton());
    const poured = assemble(
      name,
      parsed.body,
      skeleton === null ? null : skeleton.text,
    );
    return {
      ok: true,
      id,
      name,
      order: normalizeOrder(parsed.meta.order) ?? null,
      description: oneLine(parsed.meta.description) || "",
      group: oneLine(parsed.meta.group) || "",
      template: oneLine(parsed.meta.template) || "",
      body: parsed.body,
      chars: parsed.chars,
      charsFull: poured.text.length,
      problems: poured.problems,
      skeletonChars: skeleton === null ? 0 : skeleton.chars,
      rev: parsed.rev,
      mtimeMs: parsed.mtimeMs,
      size: parsed.size,
      file: full,
    };
  }

  /** Refuse before touching the disk when another owner already holds the id. */
  async function ensureFree(id) {
    if (owned.has(id)) return null;
    try {
      const taken = new Set(
        (await ctx.agentPresets.list()).map((preset) => preset.id),
      );
      if (taken.has(id))
        return `${id} 已经被别的所有者注册，dsh-waifu-agents 不接管它`;
    } catch {
      // Roster unreadable: let `register` report the duplicate itself.
    }
    return null;
  }

  async function create(request) {
    if (!writable) return readOnly();
    const id = String(request.id ?? "").trim() || idForName(request.name);
    if (!ID_OK.test(id)) {
      return {
        ok: false,
        error: `id 不合法（只允许字母、数字、连字符，可以中文）：${id}`,
      };
    }
    if (reserved(id))
      return { ok: false, error: `「${id}」是保留名字，扫描时会跳过它` };
    const full = fileFor(id);
    if (fs.existsSync(full))
      return { ok: false, error: `已经有一个 wife 用这个 id 了：${id}` };
    const body = String(request.body ?? "").trim();
    if (!body) return { ok: false, error: "「回答方式」不能为空" };
    const available = readSkeleton();
    const order = normalizeOrder(request.order) ?? nextOrder();
    const meta = {
      name: request.name,
      order,
      description: request.description,
      group: request.group,
      // A new persona joins the shared skeleton when one exists, so "just write
      // her personality" is the default rather than something to remember.
      template:
        request.template ?? (available === null ? undefined : SKELETON_FILE),
    };
    const templateIssue = templateProblem(meta);
    if (templateIssue !== null) return { ok: false, error: templateIssue };
    const skeleton = skeletonFor(meta, available);
    const poured = assemble(
      oneLine(meta.name) || id,
      body,
      skeleton === null ? null : skeleton.text,
    );
    if (!poured.ok) return { ok: false, error: poured.problems.join("；") };
    const conflict = await ensureFree(id);
    if (conflict !== null) return { ok: false, error: conflict };
    writeAtomic(full, renderPersona({ ...meta, body }));
    try {
      await registerOne(id, meta, body);
    } catch (error) {
      try {
        fs.unlinkSync(full);
      } catch {
        // Best effort: an orphan file is still visible in `list`.
      }
      return {
        ok: false,
        error: `注册失败（文件已回滚）：${error.message ?? error}`,
      };
    }
    return {
      ok: true,
      id,
      order,
      rev: revision(fs.readFileSync(full, "utf8")),
      file: full,
    };
  }

  /**
   * Edit a wife. The id is invisible, so the file follows the display name: a
   * name change moves `<old>.md` onto the slug of the new name, repoints the
   * default and re-registers under the new id. Anything else is written in
   * place.
   *
   * `idForName` is given `self` so the current file stays out of the collision
   * set: without that, saving an unchanged name would collide with its own file
   * and fork the wife onto `name-2`.
   */
  async function update(request) {
    if (!writable) return readOnly();
    const id = String(request.id ?? "").trim();
    if (!ID_OK.test(id))
      return { ok: false, error: `id 不合法：${id || "(空)"}` };
    const full = fileFor(id);
    if (!fs.existsSync(full))
      return { ok: false, error: `文件不存在：${full}` };
    const original = fs.readFileSync(full, "utf8");
    const current = readPersona(full);
    /*
     * Optimistic lock. An outside editor (or this panel in another window) may
     * have replaced the file since the caller read it, and the caller's draft
     * was built from the OLD text — saving it would silently delete whatever the
     * other writer put there. Refusing is the only honest answer.
     */
    const expected = String(request.rev ?? "").trim();
    if (expected !== "" && expected !== current.rev) {
      return {
        ok: false,
        conflict: true,
        rev: current.rev,
        error:
          `${id}.md 在磁盘上变过（外部编辑器或另一个窗口改过），这次保存没有写入。` +
          "重新打开这一行看一遍，再把两边的改动合并。",
      };
    }
    const next = {
      name:
        request.name !== undefined
          ? oneLine(request.name)
          : oneLine(current.meta.name),
      order:
        request.order !== undefined
          ? normalizeOrder(request.order)
          : normalizeOrder(current.meta.order),
      description:
        request.description !== undefined
          ? oneLine(request.description)
          : oneLine(current.meta.description),
      group:
        request.group !== undefined
          ? oneLine(request.group)
          : oneLine(current.meta.group),
      template:
        request.template !== undefined
          ? oneLine(request.template)
          : oneLine(current.meta.template),
      body: request.body !== undefined ? String(request.body) : current.body,
    };
    if (!next.body.trim()) return { ok: false, error: "「回答方式」不能为空" };
    const templateIssue = templateProblem(next);
    if (templateIssue !== null) return { ok: false, error: templateIssue };
    const skeleton = skeletonFor(next, readSkeleton());
    const poured = assemble(
      oneLine(next.name) || id,
      next.body,
      skeleton === null ? null : skeleton.text,
    );
    if (!poured.ok) return { ok: false, error: poured.problems.join("；") };
    // A cleared name must not move anything: `idForName('')` answers `persona`,
    // and an empty field is not an instruction to rename the file to that. The
    // row then falls back to showing the id, as it does for a file with no name.
    const to = next.name === "" ? id : idForName(next.name, id);
    const moved = to !== id;
    const target = moved ? fileFor(to) : full;
    if (moved && fs.existsSync(target))
      return { ok: false, error: `已经有一个 wife 用这个文件名了：${to}` };
    const conflict = await ensureFree(to);
    if (conflict !== null) return { ok: false, error: conflict };
    // Move first, then write: the file that exists at every moment is one or the
    // other, never a half-written merge of both.
    if (moved) fs.renameSync(full, target);
    writeAtomic(target, renderPersona(next));
    await unregister(id);
    try {
      await registerOne(to, next, next.body);
    } catch (error) {
      if (moved) {
        try {
          fs.rmSync(target, { force: true });
        } catch {
          // A leftover file under the new name is still visible in `list`.
        }
      }
      writeAtomic(full, original);
      try {
        await registerOne(id, current.meta, current.body);
      } catch {
        // The text is on disk either way; a missing registration is a refresh away.
      }
      return {
        ok: false,
        error: `注册失败（文件已还原，点刷新可重试）：${error.message ?? error}`,
      };
    }
    const defaultFollowed = moved ? await repointDefault(id, to) : "unchanged";
    return {
      ok: true,
      id: to,
      previousId: id,
      moved,
      order: normalizeOrder(next.order) ?? null,
      rev: revision(fs.readFileSync(target, "utf8")),
      file: target,
      defaultFollowed,
    };
  }

  /** The id *is* the identity, so renaming means moving the file. */
  async function rename(request) {
    if (!writable) return readOnly();
    const from = String(request.id ?? "").trim();
    const to = String(request.to ?? "").trim();
    if (!ID_OK.test(from))
      return { ok: false, error: `原 id 不合法：${from || "(空)"}` };
    if (!ID_OK.test(to)) {
      return {
        ok: false,
        error: `新 id 不合法（只允许字母、数字、连字符，可以中文）：${to || "(空)"}`,
      };
    }
    if (reserved(to))
      return { ok: false, error: `「${to}」是保留名字，扫描时会跳过它` };
    if (from === to) return { ok: true, id: to, unchanged: true };
    const fromFile = fileFor(from);
    const toFile = fileFor(to);
    if (!fs.existsSync(fromFile))
      return { ok: false, error: `文件不存在：${fromFile}` };
    if (fs.existsSync(toFile))
      return { ok: false, error: `已经有一个 wife 叫 ${to} 了` };
    const conflict = await ensureFree(to);
    if (conflict !== null) return { ok: false, error: conflict };
    const wasOwned = owned.has(from);
    const { meta, body } = parseFrontMatter(fs.readFileSync(fromFile, "utf8"));
    fs.renameSync(fromFile, toFile);
    await unregister(from);
    try {
      await registerOne(to, meta, body);
    } catch (error) {
      fs.renameSync(toFile, fromFile);
      if (wasOwned) {
        try {
          await registerOne(from, meta, body);
        } catch {
          // A failed rollback still leaves both files on disk and readable.
        }
      }
      return {
        ok: false,
        error: `改名失败（已回滚）：${error.message ?? error}`,
      };
    }
    // `selectedDefault` is stored as an id, so it has to follow the move:
    // otherwise the default points at a preset that no longer exists, and every
    // new session fails with `agent-presets/not-found`.
    const defaultFollowed = await repointDefault(from, to);
    return {
      ok: true,
      id: to,
      from,
      order: normalizeOrder(meta.order) ?? null,
      file: toFile,
      defaultFollowed,
    };
  }

  /**
   * Follow a rename in the registry's `selectedDefault`.
   *
   * Best effort, exactly like `setDefault`: without a `configEditor` service
   * there is nothing to write to, and a rename must not fail because of that.
   *
   * @param {string} from - the id the default may currently point at
   * @param {string} to - the id it should point at instead
   * @returns {Promise<'moved' | 'unchanged' | 'unavailable' | 'failed'>}
   */
  async function repointDefault(from, to) {
    const configEditor = ctx.get("configEditor");
    if (configEditor === undefined || configEditor === null)
      return "unavailable";
    let entry;
    try {
      entry = findRegistryEntry(configEditor);
    } catch {
      return "failed";
    }
    if (entry === undefined) return "failed";
    const before = await refreshDefault({ force: true });
    let seen = {};
    try {
      await configEditor.edit(entry, (current) => {
        seen = current ?? {};
        if (seen.selectedDefault !== from) return seen;
        return { ...seen, selectedDefault: to };
      });
    } catch {
      return "failed";
    }
    if (seen?.selectedDefault !== from) return "unchanged";
    /*
     * Same rule as `setDefault`: the write only counts once the live registry
     * agrees with it. Faking the cache here is worse than in `setDefault` — a
     * fabricated id survives the rename, the panel keeps drawing the default on
     * the old row, and the platform mounts a preset that no longer exists.
     */
    const settled = await verifyDefault(to, {
      previous: before.field,
      checkable: before.field !== undefined,
    });
    if (settled.verified) return "moved";
    // An uncheckable profile falls back to the write's own word, exactly as this
    // op behaved before verification existed; a face that actively contradicted
    // the write is the only case worth calling a failure.
    return settled.checkable ? "failed" : "moved";
  }

  /**
   * Retire a wife without losing her: unregister the preset and rename the file
   * to `<id>.md.off`.
   *
   * Deleting the file outright cannot be undone, and simply leaving it in place
   * is not an option either — `scan()` re-registers every `*.md` it finds, so a
   * file that stays put walks straight back into the roster. The `.off` suffix
   * is outside both `listFiles()` and the scanner, so the text survives while
   * the wife leaves the roster. Rename it back to `<id>.md` to revive her.
   */
  async function remove(request) {
    if (!writable) return readOnly();
    const id = String(request.id ?? "").trim();
    if (!ID_OK.test(id))
      return { ok: false, error: `id 不合法：${id || "(空)"}` };
    const full = fileFor(id);
    if (!fs.existsSync(full))
      return { ok: false, error: `文件不存在：${full}` };
    const archived = nextArchiveName(id);
    const wasRegistered = await unregister(id);
    fs.renameSync(full, archived);
    return { ok: true, id, file: full, archived, wasRegistered };
  }

  /**
   * `<id>.md.off`, then `<id>.md.off.2`, `.3` … so archiving twice never
   * overwrites the first copy. A plain `<id>.off.md` would be wrong: it still
   * ends in `.md`, and the scanner would pick it straight back up.
   */
  function nextArchiveName(id) {
    const first = path.join(dir, `${id}.md.off`);
    if (!fs.existsSync(first)) return first;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = path.join(dir, `${id}.md.off.${n}`);
      if (!fs.existsSync(candidate)) return candidate;
    }
    return path.join(dir, `${id}.md.off.${Date.now()}`);
  }

  /** `<id>.md.off`, `<id>.md.off.2`, … — everything the roster cannot see. */
  function hiddenList() {
    if (!fs.existsSync(dir)) return { ok: true, files: [] };
    const files = [];
    for (const entry of fs.readdirSync(dir).sort()) {
      const match = /^(.*)\.md\.off(?:\.(\d+))?$/.exec(entry);
      if (match === null) continue;
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      files.push({
        id: match[1],
        archived: entry,
        seq: match[2] === undefined ? 1 : Number(match[2]),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { ok: true, files };
  }

  /**
   * Bring one hidden wife back: pick a free id, rename the archive to `<id>.md`,
   * then register her again.
   *
   * Picking the id is the part a human gets wrong. `<id>.md` may already belong
   * to a NEWER wife who reused the name, and then the archive has to land on
   * `<id>-2.md` rather than clobber her.
   */
  async function restore(request) {
    if (!writable) return readOnly();
    const archived = path.basename(String(request.archived ?? "").trim());
    if (archived === "" || !/\.md\.off(?:\.\d+)?$/.test(archived)) {
      return { ok: false, error: `不是归档文件：${archived || "(空)"}` };
    }
    const source = path.join(dir, archived);
    if (!fs.existsSync(source))
      return { ok: false, error: `归档不存在：${source}` };
    const base = archived.replace(/\.md\.off(?:\.\d+)?$/, "");
    const id = fs.existsSync(fileFor(base)) ? idForName(base) : base;
    if (!ID_OK.test(id))
      return { ok: false, error: `恢复不了：「${base}」不是合法的 id` };
    const target = fileFor(id);
    if (fs.existsSync(target))
      return { ok: false, error: `已经有一个 wife 用这个 id 了：${id}` };
    const parsed = readPersona(source);
    const templateIssue = templateProblem(parsed.meta);
    if (templateIssue !== null) return { ok: false, error: templateIssue };
    const skeleton = skeletonFor(parsed.meta, readSkeleton());
    const meta = { ...parsed.meta, name: oneLine(parsed.meta.name) || id };
    const poured = assemble(
      meta.name,
      parsed.body,
      skeleton === null ? null : skeleton.text,
    );
    if (!poured.ok) return { ok: false, error: poured.problems.join("；") };
    fs.renameSync(source, target);
    try {
      await registerOne(id, meta, parsed.body);
    } catch (error) {
      fs.renameSync(target, source);
      return {
        ok: false,
        error: `恢复失败（已放回归档）：${error.message ?? error}`,
      };
    }
    return { ok: true, id, archived, file: target, renamed: id !== base };
  }

  /**
   * One action over many wives. Every item goes through the SAME single-item
   * code path, and per-item failures are reported instead of aborting the batch:
   * a batch that stops halfway leaves the caller unable to say what happened.
   */
  async function batch(request) {
    const action = String(request.action ?? "").trim();
    const ids = Array.isArray(request.ids)
      ? request.ids
          .map((value) => String(value ?? "").trim())
          .filter((value) => value !== "")
      : [];
    const archived = Array.isArray(request.archived)
      ? request.archived
          .map((value) => String(value ?? "").trim())
          .filter((value) => value !== "")
      : [];
    const results = [];
    if (action === "hide") {
      if (ids.length === 0) return { ok: false, error: "没有选中任何东西" };
      for (const id of ids) {
        const payload = await remove({ id });
        results.push({
          key: id,
          ok: payload.ok === true,
          error: payload.ok === true ? null : payload.error,
        });
      }
      return { ok: true, action, results };
    }
    if (action === "restore") {
      if (archived.length === 0)
        return { ok: false, error: "没有选中任何归档" };
      for (const name of archived) {
        const payload = await restore({ archived: name });
        results.push({
          key: name,
          ok: payload.ok === true,
          error: payload.ok === true ? null : payload.error,
        });
      }
      return { ok: true, action, results };
    }
    if (action === "group" || action === "order") {
      if (ids.length === 0) return { ok: false, error: "没有选中任何东西" };
      const group =
        request.group === undefined ? undefined : oneLine(request.group);
      let order = normalizeOrder(request.order);
      for (const id of ids) {
        const payload =
          action === "group"
            ? await update({
                id,
                group,
                rev: request.revs === undefined ? undefined : request.revs[id],
              })
            : await update({
                id,
                order,
                rev: request.revs === undefined ? undefined : request.revs[id],
              });
        results.push({
          key: id,
          ok: payload.ok === true,
          error: payload.ok === true ? null : payload.error,
        });
        if (
          payload.ok === true &&
          action === "order" &&
          typeof order === "number"
        )
          order += 1;
      }
      return { ok: true, action, results };
    }
    return {
      ok: false,
      error: `不认识的批量动作：${action || "(空)"}（可用：hide / restore / group / order）`,
    };
  }

  /** The shared skeleton as the panel reads it: raw text, slot count, validation. */
  function skeletonOp() {
    const skeleton = readSkeleton();
    if (skeleton === null) {
      return {
        ok: true,
        present: false,
        file: path.join(dir, SKELETON_FILE),
        chars: 0,
        slots: 0,
        rev: null,
        text: "",
        problems: [],
      };
    }
    const slots = skeleton.text.split("[[body]]").length - 1;
    const problems = [];
    if (slots !== 1)
      problems.push(
        slots === 0 ? "骨架里没有 [[body]]" : `骨架里有 ${slots} 个 [[body]]`,
      );
    for (const match of skeleton.text.matchAll(/\{\{([^{}]*)\}\}/g)) {
      const variable = match[1].trim();
      if (
        !PROMPT_VARIABLE_NAME.test(variable) ||
        !PROMPT_VARIABLES.has(variable)
      ) {
        problems.push(
          `骨架里的 {{${match[1]}}} 会让整份系统提示词渲染失败：只支持 provider / model / cwd`,
        );
      }
    }
    return {
      ok: true,
      present: true,
      file: skeleton.file,
      chars: skeleton.chars,
      slots,
      rev: skeleton.rev,
      text: skeleton.text,
      problems,
    };
  }

  /**
   * Write the shared skeleton, then re-register everyone.
   *
   * Changing the frame changes EVERY assembled prefix, so a skeleton that is
   * saved but not applied is the worst of both worlds: the file says one thing
   * and every live session keeps reading the other.
   */
  async function setSkeleton(request) {
    if (!writable) return readOnly();
    const text = String(request.text ?? "");
    if (text.trim() === "")
      return { ok: false, error: "骨架不能是空的：要删掉它就直接删文件。" };
    const slots = text.split("[[body]]").length - 1;
    if (slots === 0)
      return {
        ok: false,
        error: "骨架里必须有 [[body]]，否则人设正文没有地方可放",
      };
    if (slots > 1)
      return { ok: false, error: `骨架里有 ${slots} 个 [[body]]，只能有一个` };
    for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
      const variable = match[1].trim();
      if (
        !PROMPT_VARIABLE_NAME.test(variable) ||
        !PROMPT_VARIABLES.has(variable)
      ) {
        return {
          ok: false,
          error: `骨架里的 {{${match[1]}}} 会让整份系统提示词渲染失败：只支持 provider / model / cwd`,
        };
      }
    }
    const full = path.join(dir, SKELETON_FILE);
    const current = readSkeleton();
    const expected = String(request.rev ?? "").trim();
    if (expected !== "" && current !== null && expected !== current.rev) {
      return {
        ok: false,
        conflict: true,
        rev: current.rev,
        error:
          "骨架在磁盘上变过（外部编辑器改过），这次保存没有写入。重新打开看一遍。",
      };
    }
    const finalText = text.endsWith("\n") ? text : `${text}\n`;
    writeAtomic(full, finalText);
    const result = await scan();
    // Every persona session re-reads the skeleton on its next turn — that is the
    // price of resolving the text per assembly — so this is "who is about to
    // notice", which is exactly what the panel should say out loud.
    let liveSessions = 0;
    try {
      const registry = ctx.get("agents", false);
      const live = typeof registry?.list === "function" ? registry.list() : [];
      liveSessions = live.filter((agent) => owned.has(anchorOf(agent))).length;
    } catch {
      liveSessions = 0;
    }
    return {
      ok: true,
      liveSessions,
      chars: finalText.length,
      slots,
      rev: revision(finalText),
      reloaded: result.reloaded,
      added: result.added,
      problems: result.problems,
    };
  }

  /**
   * Search the text the MODEL would read, without shipping any of it.
  /**
   * Search the text the MODEL would read, without shipping any of it.
   *
   * The panel only receives the snippet and whether it came from the shared
   * skeleton or from her own part, so a directory full of long personas costs
   * the browser nothing to search.
   */
  function search(request) {
    const needle = String(request.query ?? "").trim();
    if (needle === "")
      return { ok: true, query: needle, hits: [], truncated: false };
    const lower = needle.toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(request.limit ?? 50) || 50));
    const skeleton = readSkeleton();
    const hits = [];
    for (const item of listFiles()) {
      const parsed = readPersona(fileFor(item.id));
      const frame = skeletonFor(parsed.meta, skeleton);
      // Search the two pieces SEPARATELY, so a hit can say where it lives. The
      // assembled text cannot answer that: a match after the body slot is still
      // skeleton text, and comparing offsets against the slot gets it backwards.
      const pieces = [];
      if (frame !== null) pieces.push({ source: "skeleton", text: frame.text });
      pieces.push({ source: "body", text: parsed.body });
      for (const piece of pieces) {
        const haystack = piece.text.toLowerCase();
        let from = 0;
        while (hits.length < limit) {
          const at = haystack.indexOf(lower, from);
          if (at < 0) break;
          const start = Math.max(0, at - 40);
          const end = Math.min(piece.text.length, at + needle.length + 40);
          hits.push({
            id: item.id,
            name: item.name,
            source: piece.source,
            index: at,
            snippet: `${start > 0 ? "…" : ""}${piece.text.slice(start, end)}${end < piece.text.length ? "…" : ""}`,
          });
          from = at + needle.length;
        }
        if (hits.length >= limit) break;
      }
      if (hits.length >= limit) break;
    }
    return { ok: true, query: needle, hits, truncated: hits.length >= limit };
  }

  /**
   * Store a whole markdown file. Front matter is honoured when present, so an
   * exported file imports back unchanged; a file without front matter becomes
   * one long answer style.
   */
  async function importMd(request) {
    const content = String(request.content ?? "");
    if (!content.trim()) return { ok: false, error: "导入的内容是空的" };
    const { meta, body } = parseFrontMatter(content);
    if (!body)
      return { ok: false, error: "这个 md 的 front matter 之后没有内容" };
    const id =
      String(request.id ?? "").trim() || idForName(meta.name || request.name);
    return create({
      id,
      name: meta.name ?? request.name,
      order: meta.order,
      description: meta.description ?? request.description,
      body,
    });
  }

  function exportOne(request) {
    const id = String(request.id ?? "").trim();
    if (!ID_OK.test(id))
      return { ok: false, error: `id 不合法：${id || "(空)"}` };
    const full = fileFor(id);
    if (!fs.existsSync(full))
      return { ok: false, error: `文件不存在：${full}` };
    return {
      ok: true,
      id,
      filename: `${id}.md`,
      content: fs.readFileSync(full, "utf8"),
    };
  }

  /**
   * Every file's exact text in one response.
   *
   * Kept for the `/persona` command and for anything scripting against the
   * route; the PANEL no longer uses it — it lists first and then pulls one file
   * at a time with `export`, so a directory of long personas never becomes one
   * multi-megabyte response. The cap below is what keeps the command path from
   * becoming that by accident: a limit nobody can hit is not a limit.
   */
  const EXPORT_ALL_LIMIT = 8 * 1024 * 1024;

  function exportAll() {
    const files = [];
    let total = 0;
    for (const item of listFiles()) {
      const content = fs.readFileSync(fileFor(item.id), "utf8");
      total += Buffer.byteLength(content, "utf8");
      if (total > EXPORT_ALL_LIMIT) {
        return {
          ok: false,
          truncated: true,
          error: `导出全部超过上限（${Math.round(EXPORT_ALL_LIMIT / 1024 / 1024)}MB）：改用逐条导出，或者直接去目录里拿文件。`,
        };
      }
      files.push({ id: item.id, filename: `${item.id}.md`, content });
    }
    return { ok: true, files, bytes: total };
  }

  /**
   * The persona this package ships, so a user can edit it locally and import it back.
   *
   * The NAME is deliberately not hard-coded. The shipped file is a real persona —
   * it gets renamed whenever a different one is chosen to ship — and a pinned name
   * turns that rename into a button that only ever answers 「包内没有模板」. So the
   * directory decides: the first `*.md` that is not a reserved name, and `RESERVED`
   * already spells those (`README.md`, the legacy `_template.json`).
   */
  function shippedPersona() {
    const home = path.join(PACKAGE_DIR, "personas");
    let entries;
    try {
      entries = fs.readdirSync(home).sort();
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md") || RESERVED.has(entry.toLowerCase())) continue;
      const full = path.join(home, entry);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        // An entry that vanished mid-scan is not a reason to fail the op.
      }
    }
    return null;
  }

  function exportTemplate() {
    const file = shippedPersona();
    if (file === null)
      return {
        ok: false,
        error: `包内 personas/ 里没有可下载的人设文件：${path.join(PACKAGE_DIR, "personas")}`,
      };
    return {
      ok: true,
      filename: path.basename(file),
      content: fs.readFileSync(file, "utf8"),
    };
  }

  /** Write `config.dir` back through the optional configEditor service. */
  async function setDir(request) {
    const configEditor = ctx.get("configEditor");
    if (configEditor === undefined || configEditor === null) {
      return {
        ok: false,
        error:
          "这个环境没有 configEditor 服务，改不了配置；请直接编辑 profile 的补丁文件。",
      };
    }
    const next = String(request.dir ?? "").trim();
    let entry;
    try {
      entry = configEditor
        .entries()
        .find(
          (row) =>
            SELF_IDS.includes(row.id) ||
            row.id === name ||
            row.patchId === name,
        );
    } catch (error) {
      return { ok: false, error: `读不到配置项：${error.message ?? error}` };
    }
    if (entry === undefined)
      return { ok: false, error: `找不到 ${name} 这条配置项` };
    try {
      await configEditor.edit(entry, (current) => {
        const copy = { ...(current ?? {}) };
        if (next) copy.dir = next;
        else delete copy.dir;
        return copy;
      });
    } catch (error) {
      return { ok: false, error: `写入失败：${error.message ?? error}` };
    }
    return {
      ok: true,
      dir: next || null,
      note: "配置已写入；插件会重启并重新扫描目录。",
    };
  }

  /*
   * The default persona lives on the `agent-preset-registry` entry, not on this
   * one: `default` is required, and the volatile `selectedDefault` wins over it.
   * The official agent-preset settings page writes that exact field, and so does
   * this panel — both point at the same place, so the two entry points cannot
   * disagree. `default` itself is left untouched as a fallback.
   */
  const REGISTRY_ENTRY_ID = "agent-preset-registry";
  const REGISTRY_PACKAGE = "@deepseek-ai/dsh-agent-preset-registry";

  /**
   * The profile row that owns `selectedDefault`.
   *
   * `entries()` hands back Loader `Entry` objects, whose addressable fields are
   * `options.id` / `options.name` / `options.config` — the exact shape
   * `dsh-settings` matches on (`row.options.id === ns` in its `write()`). The
   * bare `row.id` / `row.name` / `row.patchId` spellings were never on that
   * class, so they are read second: `row.id` DOES exist, but as a getter that
   * prefixes the owning tree (`include:agent-preset-registry`), which is why the
   * prefixed form is checked too.
   * @param {object} configEditor the configEditor service
   * @returns {object | undefined} the entry, or undefined when nothing matches
   */
  function findRegistryEntry(configEditor) {
    const idsOf = (row) =>
      [row?.options?.id, row?.id].filter((value) => typeof value === "string");
    const namesOf = (row) =>
      [row?.options?.name, row?.name].filter((value) => typeof value === "string");
    return configEditor
      .entries()
      .find(
        (row) =>
          namesOf(row).includes(REGISTRY_PACKAGE) ||
          idsOf(row).includes(REGISTRY_ENTRY_ID) ||
          idsOf(row).includes(`include:${REGISTRY_ENTRY_ID}`) ||
          row?.patchId === REGISTRY_ENTRY_ID,
      );
  }

  /**
   * Which ids the profile actually exposes, for a failure a human can act on.
   *
   * A bare 「找不到 …这条配置项」 cannot be diagnosed: the id may have been
   * renamed, the row may live in a nested Include, or the profile may simply have
   * no loader tree this service can address. Naming what WAS there turns all
   * three into a one-line answer.
   * @param {object} configEditor the configEditor service
   * @returns {string} one line, never a throw
   */
  function describeEntries(configEditor) {
    try {
      const seen = configEditor
        .entries()
        .map((row) => oneLine(row?.options?.id) || oneLine(row?.id) || "?");
      return seen.length === 0 ? "(一个都没有)" : seen.join(" / ");
    } catch (error) {
      return `(读不到：${error?.message ?? error})`;
    }
  }

  /**
   * Write the registry's `selectedDefault` the way the platform itself does.
   *
   * `Settings → Agent Presets` writes through
   * `ctx.remote.settings.update("agent-preset-registry", { selectedDefault })`
   * (`ui-agent-preset`), NOT through `configEditor.edit` — and the difference is
   * not cosmetic. `settings.update()` settles by calling `describe()`, and
   * `describe()` is the ONLY thing that emits `settings/document-updated`.
   * `ui-agent-preset` wires exactly one listener for that event:
   *
   *     ctx.remote.$on("settings/document-updated", (ns) => {
   *       if (ns !== "agent-preset-registry") return;
   *       refresh();   // every seat: the new-task chip, its settings row, …
   *     })
   *
   * A bare `configEditor.edit()` lands the same bytes in the same patch file and
   * emits nothing, so the app keeps answering from its old snapshot: the panel
   * shows the new default, the next new task comes up on the PREVIOUS one, and
   * changing the very same field from the Agent-Presets page works fine. That is
   * 「在插件页面更新默认人设后，新对话没有同步；在 Agent 预设里改就正常」.
   *
   * Routing through the service also removes the need to guess about the write:
   * `settings.write()` re-reads the projected form itself before it settles, so
   * the verifier downstream is checking a value the app has already adopted.
   *
   * The `configEditor.edit()` path stays as the fallback for a profile that has
   * no settings service, or whose registry row is not addressable as an entry id
   * (`settings.write` matches `row.options.id === ns`; `findRegistryEntry` is
   * more forgiving and also matches the package name).
   *
   * @param {{ entry: object, id: string | null }} options `null` clears the field
   * @returns {Promise<{ ok: true, via: string } | { ok: false, error: string }>}
   */
  async function writeDefault({ configEditor, entry, id }) {
    const settings = serviceOf("settings");
    if (settings !== undefined && typeof settings.update === "function") {
      try {
        if (id === null) {
          await settings.mutate(REGISTRY_NS, [
            { op: "unset", path: ["selectedDefault"] },
          ]);
        } else {
          await settings.update(REGISTRY_NS, { selectedDefault: id });
        }
        return { ok: true, via: "settings" };
      } catch (error) {
        // A profile whose registry row is not addressable by entry id cannot use
        // the service at all. Fall through and let the editor path try — it is
        // more forgiving about how the row is named.
        //
        // Say so out loud. This fallback lands the same bytes and wakes nobody,
        // so it reproduces the original bug exactly; degrading into it silently
        // is how a fix stops being one without anything looking wrong.
        const viaEditor = await editDefault({ configEditor, entry, id });
        if (viaEditor.ok) {
          ctx.logger?.warn?.(
            `dsh-waifu-agents: settings.update 走不通（${error?.message ?? error}），` +
              `退回配置编辑器写默认——磁盘会变，但平台收不到通知，新任务页可能不跟。`,
          );
          return { ok: true, via: "configEditor" };
        }
        return {
          ok: false,
          error: `${error?.message ?? error}；改用配置编辑器也不行：${viaEditor.error}`,
        };
      }
    }
    const viaEditor = await editDefault({ configEditor, entry, id });
    return viaEditor.ok ? { ok: true, via: "configEditor" } : viaEditor;
  }

  /**
   * The pre-`settings` write path, kept only as a fallback.
   *
   * It cannot wake the app up — no `settings/document-updated` — which is
   * exactly why it is no longer the first choice. It is still correct on disk.
   *
   * @param {{ configEditor: object, entry: object, id: string | null }} options
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async function editDefault({ configEditor, entry, id }) {
    try {
      await configEditor.edit(entry, (current) => {
        const copy = { ...(current ?? {}) };
        if (id === null) delete copy.selectedDefault;
        else copy.selectedDefault = id;
        return copy;
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /** Point the registry's `selectedDefault` at one wife, or at nobody. */
  async function setDefault(request) {
    const id = String(request.id ?? "").trim();
    // An empty id is 「谁都不指定」 — exactly what the settings row's 关掉 button
    // and a switched-off roster row send. Refusing it is why turning the default
    // off left the previous row's active border on screen behind an error note.
    const clearing = id === "";
    if (!clearing && !ID_OK.test(id))
      return { ok: false, error: `id 不合法：${id}` };
    if (!clearing && !fs.existsSync(fileFor(id)))
      return { ok: false, error: `没有这个 wife：${id}` };
    const configEditor = ctx.get("configEditor");
    if (configEditor === undefined || configEditor === null) {
      return {
        ok: false,
        error: "这个环境没有 configEditor 服务，改不了默认人设。",
      };
    }
    let entry;
    try {
      entry = findRegistryEntry(configEditor);
    } catch (error) {
      return { ok: false, error: `读不到配置项：${error.message ?? error}` };
    }
    if (entry === undefined)
      return {
        ok: false,
        error: `找不到 ${REGISTRY_PACKAGE} 这条配置项（配置里现在有：${describeEntries(configEditor)}）`,
      };
    const before = await refreshDefault({ force: true });
    /*
     * Through the settings service, so the app is told (see `writeDefault`).
     * `configEditor.edit()` alone lands the value and wakes nobody up, which is
     * how the panel and the new-task chip ended up naming different wives.
     */
    const written = await writeDefault({
      configEditor,
      entry,
      id: clearing ? null : id,
    });
    if (!written.ok)
      return { ok: false, error: `写入失败：${written.error}` };
    /*
     * The write is not the truth; the reread is.
     *
     * `configEditor.edit()` settles the patch file before the Loader has
     * re-activated the row, so a read issued right here can still answer with the
     * PREVIOUS id. Believing the write at that point is what made the panel and
     * the platform disagree: the roster kept the active border on the row the
     * user had just moved the default off, and the next new task came up on the
     * profile default instead. So confirm the write against the live registry
     * before saying it moved, and say so out loud when it did not.
     */
    const wanted = clearing ? null : id;
    const settled = await verifyDefault(wanted, {
      previous: before.field,
      checkable: before.field !== undefined,
    });
    if (!settled.verified && settled.checkable) {
      return {
        ok: false,
        error: `写进去了，但读回来还是「${settled.id ?? "（没指定）"}」——这一行没能生效。再点一次；再不行就是这条配置被别处的 patch 覆盖了（profile 的 cordis.patch.yml 与 home patch / 命令行 --patch）。`,
        id: wanted,
        verified: false,
        checkable: true,
        attempts: settled.attempts,
        defaultId: cachedDefault.id,
      };
    }
    /*
     * The write decides what a session created LATER gets. This decides what the
     * session already on screen gets — the new-task chip the user is looking at
     * while they do this. Both are needed; only the first was here.
     */
    const resettled = await resettleUnstarted({
      to: oneLine(cachedDefault.id),
      from: before.id,
    });
    if (resettled.moved.length > 0) {
      ctx.logger?.info?.(
        `dsh-waifu-agents: 默认改成 ${oneLine(cachedDefault.id)}，` +
          `顺手把 ${resettled.moved.length} 个还没开口的会话挪过去（${resettled.moved.join("、")}）。`,
      );
    }
    return {
      ok: true,
      id: wanted,
      verified: settled.verified,
      // `false` = this profile exposes neither `settings` nor an `isDefault`
      // flag, so the write could not be confirmed either way. The panel says so
      // instead of pretending the read agreed.
      checkable: settled.checkable,
      attempts: settled.attempts,
      // The anchor this write committed, already read back from the live
      // registry. The panel lands it after its reread, so a `list` that still
      // answers with the previous id cannot leave the row the user just moved
      // off wearing the active border.
      defaultId: cachedDefault.id,
      defaultSource: cachedDefault.source,
      // How the write reached the config, and whether the blank sessions came
      // along. Both are diagnostics for a report that says the panel and the
      // new-task chip still disagree — they name which half is missing.
      via: written.via,
      resettled: resettled.moved,
      resettleSkipped: resettled.reason,
    };
  }

  /* ------------------------------------------------ self-update (the version trap) */

  /**
   * The plugin-manager service, when this profile has one.
   *
   * `ctx.get` alone is NOT enough, for the same reason the HTTP route needs
   * `ctx.inject`: a strict `get` answers only while the providing fiber is
   * ACTIVE, and the manager may still be starting when this plugin activates.
   * `ctx.inject` starts a separate fiber the moment the service really exists.
   * The direct lookups are the fallback for a profile that has no manager at all
   * — there the op has to say so rather than silently do nothing.
   * @returns {object | null}
   */
  let pluginManager = null;
  ctx.inject(["pluginManager"], (scoped) => {
    pluginManager = scoped.pluginManager ?? null;
    scoped.effect(
      () => () => {
        pluginManager = null;
      },
      "waifu-agents: pluginManager handle",
    );
  });

  function managerOf() {
    if (pluginManager !== null) return pluginManager;
    try {
      return ctx.get("pluginManager", false) ?? null;
    } catch {
      return null;
    }
  }

  /** The last part of a package-manager log, bounded, for a panel one-liner. */
  function tail(value, limit = 2000) {
    const text = String(value ?? "").trim();
    return text.length <= limit ? text : `…${text.slice(-limit)}`;
  }

  /**
   * The installation this plugin started, and what the platform has said about
   * it since. One at a time on purpose: `installBundle` takes a profile-wide
   * lock, so a second start would only queue behind the first while the panel
   * drew two bars and neither of them moved.
   *
   * @type {{ requestId: string, version: string, previous: string | null,
   *   startedAt: number, phase: string, attempt: object | null, log: string,
   *   logTruncated: boolean, pnpmExit: number | null, seenFeed: boolean,
   *   warnedNoFeed: boolean, done: boolean, result: object | null,
   *   error: string | null } | null}
   */
  let activeInstall = null;

  /** How much pnpm output to keep. The panel draws a tail, not a transcript. */
  const INSTALL_LOG_LIMIT = 4000;

  /**
   * Fold an announced phase into the running install.
   *
   * The platform emits `plugin-manager/install-state` from the manager's own
   * context, and ONLY when the caller passed a `requestId`:
   *
   *     const announce = (phase, attempt) => {
   *       if (requestId !== void 0) this.ownerContext.emit(...)
   *     }
   *
   * which is the whole reason `updateApply` mints one. Without it the install
   * runs to completion in total silence, and that silence is exactly the
   * 「装完了也不知道装完没有」 this feed exists to answer.
   *
   * Phases seen in the manager's source: `installing` (once per registry the
   * installation asks, carrying `{registry, index, total}`), `applying` (the
   * config write and reload, announced once), `cancelling` (only if someone
   * asked to stop it — this plugin never does).
   */
  function noteInstallState(progress) {
    const job = activeInstall;
    if (job === null || oneLine(progress?.requestId) !== job.requestId) return;
    const phase = oneLine(progress?.phase);
    if (phase !== "") job.phase = phase;
    const attempt = progress?.attempt;
    if (attempt !== undefined && attempt !== null) {
      job.attempt = {
        registry: oneLine(attempt.registry),
        index: Number(attempt.index ?? 0),
        total: Number(attempt.total ?? 0),
      };
    }
    job.seenFeed = true;
  }

  /**
   * Append one pnpm chunk, keeping only the tail the panel will draw.
   *
   * A chunk carries `{requestId, jobId, argv, cwd, stream, text, exitCode}`;
   * the last one for a command arrives with empty `text` and the exit code.
   * The accumulation is NOT `tail(log + text)` — that helper trims, and
   * trimming a still-running log would eat the newline boundaries and glue two
   * unrelated lines together.
   */
  function noteInstallLog(chunk) {
    const job = activeInstall;
    if (job === null || oneLine(chunk?.requestId) !== job.requestId) return;
    const text = String(chunk?.text ?? "");
    if (text !== "") {
      const joined = job.log + text;
      if (joined.length > INSTALL_LOG_LIMIT) {
        job.logTruncated = true;
        job.log = joined.slice(-INSTALL_LOG_LIMIT);
      } else {
        job.log = joined;
      }
    }
    if (chunk?.exitCode !== undefined && chunk?.exitCode !== null) {
      job.pnpmExit = Number(chunk.exitCode);
    }
    job.seenFeed = true;
  }

  /*
   * The platform's own install telemetry, published for whoever asks — its own
   * Plugins page listens to this same pair through `ctx.remote.$on`
   * (`ui-plugin-manager`). Subscribing costs nothing while nothing is
   * installing: both handlers return on their first line unless the id matches
   * the job this plugin started, and this plugin starts at most one at a time.
   */
  ctx.on("plugin-manager/install-state", noteInstallState);
  ctx.on("plugin-manager/install-log", noteInstallLog);

  /**
   * Running version, installed version, published version.
   *
   * All three are needed because they can all differ: `pnpm add` swaps the file
   * on disk while the old module keeps running, so "installed" and "running"
   * disagree exactly between an update and the restart that applies it.
   */
  async function updateCheck() {
    // Read the disk ONCE: two reads could straddle a running install and report
    // a version that never existed.
    const installed = readOwnVersion();
    let latest = null;
    let registry = null;
    let error = null;
    try {
      const found = await latestVersion(config.registry);
      latest = found.version;
      registry = found.registry;
    } catch (failure) {
      // A registry that cannot be reached is not a failed op: the panel still
      // wants to show which version is installed, and offline is normal.
      error = String(failure?.message ?? failure);
    }
    return {
      ok: true,
      name: PACKAGE_NAME,
      running: RUNNING_VERSION,
      installed,
      latest,
      registry,
      // Judged against what is on DISK: the banner has to go away the moment the
      // new version is installed, even though the old one keeps running.
      updateAvailable:
        latest !== null && isNewer(latest, installed ?? RUNNING_VERSION),
      // Judged against what is RUNNING, which is the only thing a restart changes.
      restartPending:
        installed !== null &&
        RUNNING_VERSION !== null &&
        installed !== RUNNING_VERSION,
      canInstall: managerOf() !== null,
      error,
    };
  }

  /**
   * Install the newest published version, through the same service the Plugins
   * page uses.
   *
   * The exact version is passed, never a range. That matters twice over:
   * `pnpm add <name>@<version>` is what REWRITES the profile's declared range to
   * `^<version>` (a stale `^0.0.1` can never resolve `0.1.0`, which is the whole
   * reason a fresh release used to install nothing), and a pinned version keeps
   * the resolver from having to pick one out of a moving range.
   *
   * Pinning buys nothing from the 24h `minimumReleaseAge` policy: the install
   * has to record the release in the workspace's `minimumReleaseAgeExclude`
   * first (this profile has carried both a `dsh-waifu-agents@0.2.0` and a
   * `dsh-waifu-agents@0.2.1` entry ever since those installs), and with no
   * entry covering it the lockfile check refuses the install outright with
   * `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`. So a fresh release can still be
   * held back here for up to 24h; surface that failure rather than promising a
   * bypass.
   *
   * Returns as soon as the install is STARTED, not when it finishes, and hands
   * back the `requestId` that makes the platform publish progress for it. The
   * panel then polls `updateProgress` — see the comment on the launch below for
   * why holding this response open was the wrong shape.
   */
  async function updateApply(request) {
    const manager = managerOf();
    if (manager === null) {
      return {
        ok: false,
        error: `这个环境没有 pluginManager 服务，装不了；请在插件页手动安装 ${PACKAGE_NAME}@latest。`,
      };
    }
    /*
     * One at a time. `installBundle` serialises on a profile-wide lock anyway,
     * so a second call would only wait in that queue — while the panel, told
     * 「started」, drew a bar that never moved. Naming the running one is more
     * use than pretending to start another.
     */
    if (activeInstall !== null && activeInstall.done !== true) {
      return {
        ok: false,
        error: "上一次更新还在进行，等它结束再试。",
        requestId: activeInstall.requestId,
        running: true,
      };
    }
    let version = String(request.version ?? "").trim();
    try {
      if (version === "")
        version = (await latestVersion(config.registry)).version;
    } catch (failure) {
      return {
        ok: false,
        error: `查不到最新版本：${failure?.message ?? failure}`,
      };
    }
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
      return { ok: false, error: `版本号不合法：${version}` };
    }
    const before = readOwnVersion();
    if (before === version) {
      /*
       * Nothing to install, and said in the shape the panel already draws a
       * FINISHED job in — so 「已经是最新的」 lands in the same progress window
       * as a real install instead of needing a second code path in the client.
       */
      return {
        ok: true,
        started: false,
        requestId: "",
        version,
        previous: before,
        done: true,
        result: {
          ok: true,
          version,
          previous: before,
          application: "current",
          changed: false,
          installed: before,
          log: "",
        },
      };
    }
    /*
     * The id is minted here, or accepted from the panel when it sent one. It
     * exists because the platform publishes progress ONLY for an installation
     * that carries one (`noteInstallState`). The panel prefers to mint it
     * itself: a chunk that arrives before this response comes back still finds
     * the job it belongs to. The fallback keeps a direct caller (a script, or
     * `curl` against this route) working just as well.
     */
    const requestId = String(request.requestId ?? "").trim() || randomUUID();
    const job = {
      requestId,
      version,
      previous: before,
      startedAt: Date.now(),
      phase: "starting",
      attempt: null,
      log: "",
      logTruncated: false,
      pnpmExit: null,
      seenFeed: false,
      warnedNoFeed: false,
      done: false,
      result: null,
      error: null,
    };
    activeInstall = job;
    /*
     * Deliberately NOT awaited: pnpm can take a minute, and holding this HTTP
     * response open for the whole of it is exactly what made 「到底装完了没有」
     * unanswerable — the panel had one blocking call and nothing to draw until
     * it returned. The install carries on here while the panel polls
     * `updateProgress`, which keeps answering with the final result after the
     * job settles.
     */
    void (async () => {
      try {
        const outcome = await manager.installBundle(
          `${PACKAGE_NAME}@${version}`,
          { enabled: true, requestId },
        );
        job.done = true;
        if (outcome?.application === "failed") {
          job.error = `安装失败：${outcome.error?.message ?? outcome.error?.code ?? JSON.stringify(outcome.error)}`;
          // The manager's own transcript is the useful half of this failure,
          // and it is only here if the streaming feed never spoke.
          if (job.log === "") job.log = String(outcome?.packageResult?.output ?? "");
          return;
        }
        job.result = {
          ok: true,
          version,
          previous: before,
          // The manager never hot-swaps an already-installed package, so this
          // is `restart-required` in practice. Its own word is passed through
          // rather than a promise this code cannot keep.
          application: outcome?.application ?? null,
          changed: outcome?.changed === true,
          installed: readOwnVersion(),
          log: String(outcome?.packageResult?.output ?? ""),
        };
      } catch (failure) {
        job.done = true;
        job.error = `调用 pluginManager 失败：${failure?.message ?? failure}`;
      }
    })();
    return { ok: true, started: true, requestId, version, previous: before };
  }

  /**
   * What the panel draws while it waits.
   *
   * Plain data on purpose: the panel polls this over HTTP, and a job that has
   * already finished KEEPS answering with its result until the next install
   * replaces it — so a poll that lands after the last chunk sees the outcome
   * instead of racing it into 「idle」.
   */
  function updateProgress(request) {
    const job = activeInstall;
    const wanted = String(request?.requestId ?? "").trim();
    if (job === null || (wanted !== "" && wanted !== job.requestId)) {
      return { ok: true, idle: true, requestId: wanted === "" ? null : wanted };
    }
    const elapsed = Date.now() - job.startedAt;
    /*
     * Warn once if the platform's feed never answers while the install is
     * clearly running. That is the only way this plugin can fail to see
     * progress — the events are emitted on the manager's own context, so a
     * build that scoped them somewhere else would leave the bar sitting on
     * 「准备中」 while pnpm worked. The panel says as much in words; this line is
     * what a log reader gets.
     */
    if (
      job.done !== true &&
      job.seenFeed !== true &&
      job.warnedNoFeed !== true &&
      elapsed > 8000
    ) {
      job.warnedNoFeed = true;
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 更新已经跑了 ${Math.round(elapsed / 1000)} 秒，但一直没收到 plugin-manager 的进度事件；进度条只能显示「进行中」。`,
      );
    }
    return {
      ok: true,
      idle: false,
      requestId: job.requestId,
      version: job.version,
      previous: job.previous,
      phase: job.phase,
      attempt: job.attempt,
      elapsedMs: elapsed,
      // The streamed transcript wins; the manager's returned output is the
      // fallback for a run that never streamed (an older manager, or a feed
      // this build does not publish).
      log: job.log !== "" ? job.log : String(job.result?.log ?? ""),
      logTruncated: job.logTruncated,
      pnpmExit: job.pnpmExit,
      seenFeed: job.seenFeed,
      done: job.done,
      result: job.result,
      error: job.error,
    };
  }

  /**
   * The live roster. This is the only way to see whether a wife actually
   * mounted: `register()` reports an activation failure as `broken` on the
   * record instead of removing it, so "the file exists" never proves "the
   * preset works".
   */
  async function roster() {
    try {
      // Same reason as `status()`: a reader that answers from the cache can mark
      // the wrong row as the default, and this is the face that draws the border.
      await refreshDefault();
      const presets = await ctx.agentPresets.list();
      return {
        ok: true,
        count: presets.length,
        defaultId: cachedDefault.id,
        defaultSource: cachedDefault.source,
        defaultError: cachedDefault.error,
        // Does the persisted default name a preset this registry actually holds?
        // The new-task chip stages `presets.find(p => p.isDefault)?.id ??
        // presets[0].id` (`ui-agent-preset`), so a default that resolves to
        // nothing silently comes up on the FIRST row — 「我在面板设了默认，新对话
        // 却不是她」 with no error anywhere. This flag is what lets the panel say
        // so instead of leaving the user to guess.
        //
        // `null` when no face named a default at all: that means 「不知道」, not
        // 「指不到人」. Reporting `false` there would accuse a profile that simply
        // has nothing set — and `readDefaultId` resolves the registry's own
        // `selectedDefault ?? config.default` fallback through the roster faces
        // anyway, so a real default is normally never `null`.
        defaultResolves:
          cachedDefault.id === null
            ? null
            : presets.some((row) => row.id === cachedDefault.id),
        presets: presets.map((row) => ({
          id: row.id,
          name: row.name ?? null,
          order: row.order ?? null,
          isDefault: row.id === cachedDefault.id,
          broken: typeof row.broken === "string" ? row.broken : null,
        })),
      };
    } catch (error) {
      return { ok: false, error: `读不到人设名册：${error?.message ?? error}` };
    }
  }

  /**
   * What the picker needs: the roster, the global default, and this session's
   * current answer. `active` marks the row the session actually resolves to.
   */
  async function waifuState(request) {
    const sessionId = oneLine(request.sessionId);
    const mountedId = oneLine(request.mountedId);
    await refreshDefault();
    const orderOf = (item) =>
      typeof item.order === "number" ? item.order : Number.MAX_SAFE_INTEGER;
    const rows = listFiles()
      .filter((item) => item.problems.length === 0 && item.idOk === true)
      .map((item) => ({
        id: item.id,
        name: item.name,
        group: item.group,
        order: item.order,
        description: item.description,
        isDefault: cachedDefault.id === item.id,
      }))
      // The sort belongs to the ARRAY. Chaining `.sort` inside `.map` sorted one
      // row object's own keys — objects have no `.sort`, so every call to this op
      // threw and the picker listed nothing.
      .sort(
        (a, b) =>
          orderOf(a) - orderOf(b) ||
          String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)),
      );
    const found =
      sessionId === ""
        ? { id: null, source: "none" }
        : sessionPersona(sessionId, mountedId);
    return {
      ok: true,
      override: overrideOf(sessionId),
      mounted: mountedId === "" ? null : mountedId,
      defaultId: cachedDefault.id,
      defaultError: cachedDefault.error,
      active: found.id,
      source: found.source,
      rows,
    };
  }

  /** The roster a picker may offer: exactly what can be mounted right now. */
  function choosableRows() {
    const orderOf = (item) =>
      typeof item.order === "number" ? item.order : Number.MAX_SAFE_INTEGER;
    return listFiles()
      .filter((item) => item.problems.length === 0 && item.idOk === true)
      .sort(
        (a, b) =>
          orderOf(a) - orderOf(b) ||
          String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)),
      )
      .map((item) => ({ id: item.id, name: item.name }));
  }

  /** Point one session at one persona. The write is the whole operation. */
  async function waifuApply(request) {
    const sessionId = oneLine(request.sessionId);
    if (sessionId === "")
      return {
        ok: false,
        error: "这个操作要知道是哪个会话，但没拿到 session id。",
      };
    const rows = choosableRows();
    if (rows.length === 0)
      return { ok: false, error: "这个人设目录里没有可用的人设。" };
    const matched = matchPersona(
      oneLine(request.personaId) || oneLine(request.query),
      rows,
    );
    if (matched.ok !== true)
      return {
        ok: false,
        error: matched.error,
        candidates: matched.candidates ?? [],
      };
    const found = safeText(matched.id);
    if (found === null) {
      return {
        ok: false,
        error: `「${matched.id}」现在组装不出来（少了 [[body]]、或正文里混进了非法的 {{…}}），没有替换。`,
      };
    }
    setOverride(sessionId, matched.id);
    // Same move as the command path: the persona is the override, the chip is
    // this event, and without it the label names whoever the session was born
    // with (see `rememberSessionPreset`).
    rememberSessionPreset(liveAgentFor(sessionId), matched.id);
    return { ok: true, id: matched.id, name: found.name };
  }

  async function waifuClear(request) {
    const sessionId = oneLine(request.sessionId);
    if (sessionId === "")
      return {
        ok: false,
        error: "这个操作要知道是哪个会话，但没拿到 session id。",
      };
    const had = overrideOf(sessionId);
    setOverride(sessionId, null);
    restoreSessionPreset(liveAgentFor(sessionId));
    await refreshDefault();
    return { ok: true, had, defaultId: cachedDefault.id };
  }

  /**
   * Rewrite one file's `order` line, and nothing else.
   *
   * A full `renderPersona` round-trip would also trim the body and drop any
   * field this panel does not know about; reordering is not an edit, so it only
   * moves the one line and leaves the bytes alone.
   * @param {string} full absolute path
   * @param {number} value the order to write
   * @returns {boolean} whether the file changed
   */
  function setOrderLine(full, value) {
    let raw;
    try {
      raw = fs.readFileSync(full, "utf8");
    } catch {
      return false;
    }
    const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(withoutBom);
    if (match === null) return false;
    const meta = match[1]
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((line) => line.trim() !== "" && !/^order\s*:/.test(line));
    if (meta.some((line) => /^order\s*:/.test(line))) return false;
    const current = /(^|\n)order\s*:\s*([^\n]*)/.exec(match[1]);
    if (current !== null && Number(current[2].trim()) === value) return false;
    const nextMeta = [...meta, `order: ${value}`].join("\n");
    const head = withoutBom.slice(0, match.index);
    const tail = withoutBom.slice(match.index + match[0].length);
    writeAtomic(full, `${head}---\n${nextMeta}\n---${tail}`);
    return true;
  }

  /**
   * Persist one drag result: the given ids get `order: 1..n` in that sequence.
   *
   * Rows the caller did not mention keep whatever they had, so a filtered or
   * paged view still produces a total order for the ids it showed.
   */
  async function waifuOrder(request) {
    if (!writable) return readOnly();
    const ids = (Array.isArray(request.ids) ? request.ids : [])
      .map((id) => oneLine(id))
      .filter((id) => id !== "");
    if (ids.length === 0) return { ok: false, error: "没有给出顺序。" };
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id))
        return { ok: false, error: `这个 id 出现了两次：${id}` };
      seen.add(id);
    }
    const known = new Set(listFiles().map((item) => item.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0)
      return { ok: false, error: `这些人设不在目录里：${unknown.join(" / ")}` };
    const changed = [];
    let index = 0;
    for (const id of ids) {
      index += 1;
      if (setOrderLine(fileFor(id), index)) changed.push(id);
    }
    const reloaded = await scan();
    return { ok: true, order: ids, changed, reloaded: reloaded.reloaded ?? [] };
  }

  /**
   * Undo everything this plugin put outside its own package.
   *
   * Only three things are ours and outlive an uninstall: the per-session
   * override store, the `selectedDefault` line this panel writes into the
   * agent-preset registry's config, and — only when explicitly asked — the
   * persona directory itself. Everything else an install leaves behind belongs to
   * the platform (the plugin-manager's operation logs, pnpm's store index, the
   * release-age allow-list entry it wrote at install time), so this op names them
   * instead of pretending to clean them.
   * @param {{ dir?: boolean }} request
   */
  async function purge(request) {
    const withDir = request?.dir === true;
    const done = [];
    const failed = [];
    for (const file of new Set([overrideFile, legacyOverrideFile])) {
      try {
        if (!fs.existsSync(file)) continue;
        fs.rmSync(file, { force: true });
        done.push(`删除覆盖记录 ${file}`);
      } catch (error) {
        failed.push(`覆盖记录：${error?.message ?? error}`);
      }
    }
    overrides = {};
    try {
      const configEditor = ctx.get("configEditor");
      const entry =
        configEditor === undefined || configEditor === null
          ? undefined
          : findRegistryEntry(configEditor);
      if (entry === undefined)
        failed.push("找不到 agent-preset-registry 这条配置项，全局默认没清。");
      else {
        let cleared = "";
        await refreshDefault({ force: true });
        const picked = oneLine(cachedDefault.id);
        if (
          picked !== "" &&
          (owned.has(picked) || fs.existsSync(fileFor(picked)))
        ) {
          // Same path as `setDefault`, for the same reason: only the settings
          // service emits the event that makes the app re-read the roster.
          const written = await writeDefault({
            configEditor,
            entry,
            id: null,
          });
          if (written.ok) cleared = picked;
          else failed.push(`全局默认没清：${written.error}`);
        }
        done.push(
          cleared === ""
            ? "全局默认本来就没指向本插件的人设"
            : `清掉全局默认 ${cleared}`,
        );
        if (cleared !== "") {
          // Same rule as `setDefault`: the field is only really clear once the
          // live registry stops naming it. `purge` is the one op whose whole
          // promise is 「我留下的东西都没了」, so a step must never be reported
          // before the platform agrees it happened.
          const settled = await verifyDefault(null, {
            previous: cleared,
            checkable: true,
          });
          if (!settled.verified && settled.checkable)
            failed.push(
              `全局默认：写进去了，但读回来还是「${settled.id ?? "（没指定）"}」，没清干净。`,
            );
          // Same second step as `setDefault`, and it matters more here: a blank
          // session left naming a wife this op is supposed to have erased would
          // contradict the one thing `purge` promises.
          const resettled = await resettleUnstarted({
            to: oneLine(cachedDefault.id),
            from: cleared,
          });
          if (resettled.moved.length > 0)
            done.push(
              `把 ${resettled.moved.length} 个还没开口的会话撤出本插件的人设`,
            );
        }
      }
    } catch (error) {
      failed.push(`全局默认：${error?.message ?? error}`);
    }
    if (withDir) {
      if (!writable) failed.push("人设目录在插件包内，没有删。");
      else if (!fs.existsSync(dir)) done.push("人设目录本来就不在");
      else {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          fileCache.clear();
          done.push(`删除人设目录 ${dir}`);
        } catch (error) {
          failed.push(`人设目录：${error?.message ?? error}`);
        }
      }
    }
    await refreshDefault();
    return {
      ok: failed.length === 0,
      dir,
      done,
      failed,
      // Named, not cleaned: these are the platform's, and the plugin has no
      // business deleting another owner's files.
      platform: [
        ".plugin-manager\\logs\\operation-*（安装日志，平台自己累积）",
        "pnpm 内容库索引：需要 pnpm store prune",
        "pnpm-workspace.yaml 的 minimumReleaseAgeExclude（安装时 pnpm 自己写的放行记录）",
      ],
    };
  }

  async function run(request) {
    const op = String(request.op ?? "list");
    if (op === "list") return status();
    if (op === "get") return readOne(request);
    if (op === "refresh") {
      const result = await scan();
      // `status()` is async again (it reads the roster for `defaultId`), so the
      // spread needs an await — a bare spread would spread a Promise.
      return { ...(await status()), ...result };
    }
    if (op === "create") return create(request);
    if (op === "update") return update(request);
    if (op === "rename") return rename(request);
    if (op === "remove") return remove(request);
    if (op === "hidden") return hiddenList();
    if (op === "restore") return restore(request);
    if (op === "batch") return batch(request);
    if (op === "search") return search(request);
    if (op === "skeleton") return skeletonOp();
    if (op === "setSkeleton") return setSkeleton(request);
    if (op === "import") return importMd(request);
    if (op === "export") return exportOne(request);
    if (op === "exportAll") return exportAll();
    if (op === "template") return exportTemplate();
    if (op === "setDir") return setDir(request);
    if (op === "setDefault") return setDefault(request);
    if (op === "roster") return roster();
    if (op === "waifuState") return waifuState(request);
    if (op === "waifuApply") return waifuApply(request);
    if (op === "waifuClear") return waifuClear(request);
    if (op === "waifuOrder") return waifuOrder(request);
    if (op === "updateCheck") return updateCheck();
    if (op === "updateApply") return updateApply(request);
    if (op === "updateProgress") return updateProgress(request);
    if (op === "purge") return purge(request);
    return {
      ok: false,
      error: `未知的 op：${op}（可用：list / get / refresh / create / update / rename / remove / hidden / restore / batch / search / skeleton / setSkeleton / import / export / exportAll / template / setDir / setDefault / roster / waifuState / waifuApply / waifuClear / waifuOrder / updateCheck / updateApply / updateProgress / purge）`,
    };
  }

  // One operation, one implementation; the panel reaches it through the
  // generated `ctx.remote.commands` face, an agent tool can call `run` later.
  ctx.commands.register({
    name: "persona",
    description:
      "dsh-waifu-agents：list / get / refresh / create / update / rename / remove / hidden / restore / batch / search / skeleton / setSkeleton / import / export / exportAll / template / setDir / setDefault / roster / updateCheck / updateApply / updateProgress。",
    input: { hint: '{"op":"list"}' },
    handler: async ({ rawInput }) => {
      let request;
      try {
        request = JSON.parse(String(rawInput ?? "").trim() || "{}");
      } catch (error) {
        return {
          kind: "error",
          text: `参数不是合法 JSON：${error.message ?? error}`,
        };
      }
      try {
        const payload = await run(request);
        const text = JSON.stringify(payload);
        return payload && payload.ok === false
          ? { kind: "error", text }
          : { kind: "success", text };
      } catch (error) {
        return {
          kind: "error",
          text: `${String(request.op ?? "list")} 失败：${error?.message ?? error}`,
        };
      }
    },
  });

  /* ------------------------------------------- session persona commands */

  const sidOf = (agent) => oneLine(agent?.session?.id);
  /**
   * The anchor read lives in {@link anchorOf}: the session header only ever
   * names the preset the session was born with, while the `agentPreset`
   * projection follows every later `agent-preset/selected`.
   */
  const mountedOf = (agent) => anchorOf(agent);
  const SOURCE_LABEL = {
    override: "本会话覆盖",
    mounted: "会话挂载",
    default: "全局默认回落",
    none: "无",
  };

  ctx.commands.register({
    name: "waifu-change",
    description:
      "换掉这个会话正在用的人设：不带参数会打开选择器，带名字就直接切换（下一轮生效）。",
    input: { hint: "名字" },
    handler: async ({ agent, rawInput }) => {
      const sessionId = sidOf(agent);
      if (sessionId === "")
        return { kind: "error", text: "这个命令只能在会话里用。" };
      const wanted = oneLine(rawInput);
      const rows = choosableRows();
      if (wanted === "") {
        return {
          kind: "error",
          text: `没有给出名字。Web 端打 /waifu-change 会打开选择器；这里请直接写名字：/waifu-change ${rows[0]?.name ?? "名字"}\n现有：${rows.map((row) => row.name).join(" / ")}`,
        };
      }
      const matched = matchPersona(wanted, rows);
      if (matched.ok !== true) {
        return {
          kind: "error",
          text: `${matched.error}${(matched.candidates ?? []).length > 0 ? `\n${(matched.candidates ?? []).join(" / ")}` : ""}`,
        };
      }
      const found = safeText(matched.id);
      if (found === null) {
        return {
          kind: "error",
          text: `「${matched.id}」现在组装不出来（少了 [[body]]、或正文里混进了非法的 {{…}}），没有替换，这一轮仍然用原来那个人设。`,
        };
      }
      const already = overrideOf(sessionId);
      setOverride(sessionId, matched.id);
      // The override is what the model is told; this is what the row above the
      // conversation shows. Without it a running session keeps the label of the
      // wife it was born with (see `rememberSessionPreset`).
      rememberSessionPreset(agent, matched.id);
      let note = "";
      if (!hasPersonaRow(mountedOf(agent))) {
        const shadow = ensureShadow(agent);
        note =
          shadow.ok === true
            ? "（这个会话原本没挂人设，已经单独给它挂上）"
            : `（这个会话原本没人设，兜底也失败了：${shadow.error}）`;
      }
      /*
       * 「已切换」 is a claim about the session, so it must not be printed when the
       * session was already her. Re-running the same command used to answer
       * 「已切换：大肥鱼」 while the served prompt did not change at all — and the
       * loop, seeing identical text, commits no new system node, so nothing was
       * re-anchored either. That reads as "换人没生效" from the outside, which is
       * the exact confusion this wording exists to prevent.
       */
      if (already === matched.id) {
        return {
          kind: "success",
          text: `本来就是 ${found.name} · 来源：本会话 · 没有改动${note}`,
        };
      }
      return {
        kind: "success",
        text: `已切换：${found.name} · 来源：本会话 · 从下一轮开始生效${note}`,
      };
    },
  });

  ctx.commands.register({
    name: "waifu-current",
    description: "看这个会话现在在用谁，以及这个值是从哪来的。",
    handler: async ({ agent }) => {
      const sessionId = sidOf(agent);
      if (sessionId === "")
        return { kind: "error", text: "这个命令只能在会话里用。" };
      await refreshDefault();
      const mountedId = mountedOf(agent);
      const found = sessionPersona(sessionId, mountedId);
      const override = overrideOf(sessionId);
      if (found.id === null)
        return { kind: "error", text: "这个会话现在没有可用的人设。" };
      /*
       * The id is invisible by design — the file name follows the display name —
       * so for every persona whose name IS her file name, this line used to read
       * 「阿库娅 · 阿库娅」. The id is only worth printing when it says something
       * the name does not: it is what `/waifu-change` and `overrides.json` match
       * on, so a wife whose name had to be slugified (`Bad Name` -> `bad-name`)
       * still gets hers shown.
       */
      const label =
        found.id === found.name
          ? `本会话人设：${found.name}`
          : `本会话人设：${found.name} · ${found.id}`;
      const lines = [label];
      if (override !== null && override !== found.id) {
        lines.push(
          `（记录里是「${override}」，它已经不可用，所以退到了上面这个。清掉记录：/waifu-reset）`,
        );
      } else if (
        override === null &&
        mountedId !== "" &&
        mountedId !== found.id
      ) {
        lines.push(
          `（会话挂载的「${mountedId}」已经不可用，所以回落到了全局默认。换人：/waifu-change 名字）`,
        );
      }
      return { kind: "success", text: lines.join("\n") };
    },
  });

  ctx.commands.register({
    name: "waifu-reset",
    description:
      "清掉这个会话的人设覆盖，回到它原本挂载的那一篇（那一篇没了就回落全局默认）。",
    handler: async ({ agent }) => {
      const sessionId = sidOf(agent);
      if (sessionId === "")
        return { kind: "error", text: "这个命令只能在会话里用。" };
      const had = overrideOf(sessionId);
      setOverride(sessionId, null);
      // Put the label back where the persona went: the chip has to stop naming a
      // wife this session no longer talks as.
      restoreSessionPreset(agent);
      await refreshDefault();
      if (had === null)
        return {
          kind: "success",
          text: "这个会话本来就没有覆盖，什么都没改。",
        };
      dropShadow(sessionId);
      const mountedId = mountedOf(agent);
      const found = sessionPersona(sessionId, mountedId);
      const where =
        found.id === null
          ? "这个会话现在没有可用的人设"
          : `回到 ${found.name}（${SOURCE_LABEL[found.source] ?? found.source}）`;
      return {
        kind: "success",
        text: `已清掉覆盖（之前是「${had}」）· ${where} · 从下一轮开始生效`,
      };
    },
  });

  /* ------------------------------------------------------- HTTP route */

  /** The panel route. `prefix`, so sub-paths match as well. */
  const ROUTE_PATH = "/waifu-agents/api";

  /** Only a loopback peer may drive this route. */
  function isLoopbackPeer(req) {
    const address = req.socket?.remoteAddress ?? "";
    return (
      address === "127.0.0.1" ||
      address === "::1" ||
      address === "::ffff:127.0.0.1"
    );
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    res.end(body);
  }

  async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        throw new Error(
          "请求体过大（超过 16MB）：这一侧限制的是「面板 → 插件」的请求体，单个人设不该走到这里。",
        );
      }
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    return JSON.parse(text === "" ? "{}" : text);
  }

  async function handleHttp(req, res) {
    try {
      if (!isLoopbackPeer(req)) {
        sendJson(res, 403, {
          ok: false,
          error: "这个路由只接受本机（loopback）请求。",
        });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "请用 POST 提交 JSON。" });
        return;
      }
      let request;
      try {
        request = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: `参数不是合法 JSON：${error?.message ?? error}`,
        });
        return;
      }
      sendJson(res, 200, await run(request));
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  }

  /*
   * The settings panel cannot use the command path. `settings.plugins.tab`
   * declares `SettingsPluginsTabOwnerProps` with EMPTY owner props, so the
   * component never receives a session id — and `ctx.remote.commands.execute`
   * requires one. An HTTP route needs neither an agent nor a session, so the
   * panel posts the very same JSON to the very same `run` entry point.
   */
  /*
   * `ctx.get('webServer')` is NOT enough here, and it fails silently:
   * `get` defaults to `strict = true`, so it returns a service only while the
   * providing fiber is ACTIVE — and the webserver fiber reaches ACTIVE only
   * after its async `listen` settles. A single early `get` therefore sees
   * `undefined`, and nothing ever retries, so the route never enters the
   * table. `ctx.inject` starts this separate fiber only once `webServer`
   * really exists. It deliberately sits OUTSIDE the preset registration
   * above: if a webserver is ever absent we lose the panel, never the
   * personas.
   */
  ctx.inject(["webServer"], (ctx) => {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: "prefix",
          path: ROUTE_PATH,
          handler: (req, res) => handleHttp(req, res),
        }),
      "waifu-agents: http route",
    );
  });

  void scan()
    .then((result) => {
      ctx.logger?.info?.(
        `dsh-waifu-agents: ${result.added.length} registered, ${result.skipped.length} skipped from ${dir} (${dirSource})`,
      );
      if (result.problems.length > 0)
        ctx.logger?.warn?.(`dsh-waifu-agents: ${result.problems.join(" / ")}`);
    })
    .catch((error) => {
      ctx.logger?.warn?.(
        `dsh-waifu-agents: 首次扫描失败：${error?.message ?? error}`,
      );
    });
}
