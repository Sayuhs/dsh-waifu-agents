/**
 * Offline self-test for dsh-waifu-agents's Host half.
 *
 * Runs `apply` against a stub context that implements only the public
 * contracts the plugin uses (`agentPresets.register/list`, `commands.register`,
 * and the lazily injected `webServer.register`),
 * drives the same `/persona <json>` command the Web panel drives, and asserts
 * files, registrations and error paths. Nothing here touches the profile.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  apply,
  assemble,
  buildDefinition,
  Config,
  ID_OK,
  isNewer,
  parseFrontMatter,
  registrationRev,
  renderPersona,
  resolveDir,
  revision,
  templateProblem,
  matchPersona,
  reorderIds,
  orderPersonaIds,
  PERSONA_PLACEHOLDER,
  PERSONA_ORDER_BASE,
} from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(HERE, '.tmp-selftest');

/**
 * The persona files this package ships. Exactly one, and its name is NOT pinned:
 * shipping a different wife renames the file, and a self-test that spelled
 * `example.md` would then fail for the wrong reason. `README.md` is the only
 * reserved name in that directory.
 */
const SHIPPED = fs
  .readdirSync(path.join(HERE, 'personas'))
  .sort()
  // `README.md` documents the directory and `_common.md` is the shared skeleton:
  // neither is a wife, and the scan skips both (`SKIP` in index.js).
  .filter((entry) => entry.endsWith('.md') && !['readme.md', '_common.md'].includes(entry.toLowerCase()));
const SHIPPED_PERSONA = SHIPPED[0];

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
};

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, 'alpha.md'), '---\nname: Alpha\norder: 3\ndescription: first one\n---\n\nAlpha body.\n', 'utf8');
fs.writeFileSync(path.join(tmp, 'README.md'), 'skipped', 'utf8');
fs.writeFileSync(path.join(tmp, 'Bad Name.md'), 'nope', 'utf8');

const presets = new Map();
const commands = new Map();
const disposers = [];
const logs = [];
const injected = [];
const routes = new Map();
/**
 * `agentPresets.select` calls the Host made, in order. The default write alone
 * cannot move the session that is already on the new-task screen, so this is the
 * half that has to be asserted rather than assumed.
 */
const selectCalls = [];
/** sessionId -> the preset its `agentPreset` projection currently names. */
const shown = new Map();
/** Session ids the stub refuses a `select` for, as the platform refuses them. */
const locked = new Set();
/** name -> provider, exactly what `ctx.systemPrompt.variable` was handed. */
const variables = new Map();
/** name -> contribution, exactly what `ctx.systemPrompt.context` was handed. */
const contexts = new Map();
/**
 * What one session would actually be served.
 *
 * The persona row no longer carries text, so "is this persona correct" can only
 * be answered by running the registered provider the way the assembler does: for
 * an agent whose session header names the preset.
 * @param {string} sessionId the session asking
 * @param {string} agentPreset the mounted preset id
 */
const resolvedFor = (sessionId, agentPreset) =>
  variables.get('waifu_persona')?.({ agent: { session: { id: sessionId, header: { agentPreset } } } });
const resolved = (agentPreset) => resolvedFor('stub-session', agentPreset);
/**
 * The runtime-context snapshot the loop would project for one session — the
 * channel that lands as a USER-role message after the user's own.
 * @param {string} sessionId the session asking
 * @param {string} agentPreset the mounted preset id
 */
const identityFor = (sessionId, agentPreset) => {
  const agent = { session: { id: sessionId, header: { agentPreset } } };
  return [...contexts.values()]
    .map((entry) => (typeof entry.text === 'function' ? entry.text({ agent }) : entry.text))
    .filter((text) => typeof text === 'string' && text !== '')
    .join('\n\n');
};
/** Every `installBundle` the self-update made, in order. */
const installs = [];
/**
 * Event subscriptions, by event name.
 *
 * The install progress feed is the one thing this plugin cannot observe any
 * other way — the platform is the only party that knows an installation's
 * phase — so the self-test has to be able to stand in for the platform. That
 * means the stub records handlers under the event they were bound to instead of
 * only collecting them for disposal.
 */
const listeners = new Map();

/** Pretend the platform published one install event. */
function emit(event, payload) {
  for (const fn of listeners.get(event) ?? []) fn(payload);
}

/**
 * A gate a test can hold an installation behind, and the way to open it.
 *
 * The real `installBundle` shells out to pnpm and takes seconds; a stub that
 * resolves on the very next tick would close the "one at a time" window before
 * any test could look into it, and would report every job finished before the
 * first `updateProgress` poll. Both of those are behaviours worth pinning, so
 * the panel-facing states they produce have to be reachable here.
 */
let installGate = null;
let openGate = null;
/** The registry's idea of "the default preset"; the roster faces report it. */
let defaultId = null;
/**
 * When set, only a roster face that does NOT carry `isDefault` is available —
 * i.e. the shape `list()` really returns. The sweep must then report "no
 * default" rather than a confident `false`.
 */
let flaglessOnly = false;
/**
 * Services `get` answers with. Empty by default so the "service absent" paths
 * stay exercised; a test that needs one sets it and clears it again.
 */
let services = {};
const stub = {
  agentPresets: {
    register: async (definition) => {
      if (!String(definition.id ?? '').trim()) throw new Error('Preset id must not be empty');
      if (presets.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`);
      presets.set(definition.id, definition);
      return async () => {
        presets.delete(definition.id);
      };
    },
    /*
     * Faithful to the live service, and deliberately unhelpful: `list()` returns
     * `AgentPreset`, whose shape is NOT documented to carry `isDefault`. That
     * flag belongs to `AgentPresetRow` (returned by `remoteExportList`) and to
     * `AgentPresetComposition`. An earlier stub handed `list()` the flag, and
     * that friendly lie is exactly why a broken default lookup once shipped
     * green — so the flag now lives only on the face that promises it.
     */
    list: async () =>
      [...presets.keys()].map((id) => ({
        id,
        name: presets.get(id)?.name,
      })),
    // A getter, not a value: the switch has to matter at call time, not at
    // object-literal time.
    get remoteExportList() {
      if (flaglessOnly) return undefined;
      return async () => ({
        presets: [...presets.keys()].map((id) => ({
          id,
          name: presets.get(id)?.name,
          isDefault: id === defaultId,
        })),
      });
    },
    /*
     * The platform's own mover, and the reason the default write is not enough:
     * `registry.select(agent, id)` refuses a session that has opened a turn
     * (`agent-preset/locked`) and otherwise re-binds the preset tree, then
     * appends `agent-preset/selected` — which is what advances the projection the
     * chip renders. Recording the calls is the point; `shown` is the projection
     * the stub then answers with.
     */
    select: async (agent, id) => {
      if (locked.has(agent.id)) throw new Error('agent-preset/locked');
      selectCalls.push({ session: agent.session.id, id });
      shown.set(agent.session.id, id);
      return id;
    },
  },
  commands: {
    register: (definition) => {
      commands.set(definition.name, definition);
      return () => commands.delete(definition.name);
    },
  },
  systemPrompt: {
    variable: (variableName, provider) => {
      variables.set(variableName, provider);
      return () => variables.delete(variableName);
    },
    // The snapshot channel. The runtime owns turning these into user-role
    // messages; what this stub has to preserve is that the text can be a
    // function of the assembly context and that a duplicate name is refused.
    context: (entry) => {
      if (contexts.has(entry.name)) throw new Error(`prompt context "${entry.name}" is already registered in this scope`);
      if (!Number.isFinite(entry.order)) throw new TypeError(`prompt context "${entry.name}" order must be a finite number`);
      contexts.set(entry.name, entry);
      return () => contexts.delete(entry.name);
    },
    getContextOrder: () => 0,
    getSectionOrder: () => 0,
    section: () => () => {},
  },
  on: (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    // Still collected for the disposal sweep at the end of a run.
    disposers.push(fn);
    return () => {
      const bound = listeners.get(event);
      if (bound !== undefined) listeners.set(event, bound.filter((one) => one !== fn));
    };
  },
  // No configEditor in this stub by default: `setDir` and `status().configurable`
  // both exercise the "service absent" path on purpose. `services` is how one
  // test hands a service in without spoiling that.
  get: (name) => services[name],
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
  /*
   * `ctx.inject` mirrors cordis: the callback starts in its own fiber once the
   * named services really exist. The stub resolves it synchronously and hands
   * back a `webServer` whose `register` records the route, which makes the
   * route table itself assertable. That is deliberate — a route that never
   * reaches this table fails silently in production (the static fallback then
   * answers 405), so it is exactly what the self-test must pin down.
   */
  inject: (deps, callback) => {
    injected.push(...deps);
    const child = Object.create(stub);
    /*
     * The plugin-manager service, shaped after the one the Plugins page uses:
     * `installBundle` is handed one spec and answers with the manager's own
     * `application` word. Recording the spec is the point — a self-update that
     * passed a RANGE instead of an exact version would still leave the profile
     * unable to resolve the new release, which is the bug this op exists to fix.
     */
    child.pluginManager = {
      installBundle: async (spec, options) => {
        installs.push({ spec, options });
        // See `installGate`: this is where a test holds the install open.
        if (installGate !== null) await installGate;
        return {
          application: 'restart-required',
          changed: true,
          target: 'dsh-waifu-agents',
          packageResult: { output: 'fake pnpm output' },
        };
      },
    };
    child.webServer = {
      register: (route) => {
        routes.set(`${route.kind} ${route.path}`, route);
        return () => routes.delete(`${route.kind} ${route.path}`);
      },
    };
    child.effect = (fn) => {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    };
    return callback(child);
  },
};

console.log('--- pure helpers ---');
const parsed = parseFrontMatter('---\nname: X\norder: 7\n---\n\nbody line 1\nbody line 2\n');
check('front matter name', parsed.meta.name === 'X');
check('front matter order becomes a number', parsed.meta.order === 7);
check('body keeps its inner newlines', parsed.body === 'body line 1\nbody line 2');
const rendered = renderPersona({ name: 'Y', order: 2, description: 'a\nb', body: 'hello' });
check('render keeps the body', rendered.includes('\nhello\n'));
check('render flattens a multi-line description', rendered.includes('description: a b'));

const definition = buildDefinition(
  'z',
  { name: 'Z', order: 4 },
  'THE BODY',
  [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '', complete: true, includeRuntimeContext: false } },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  ],
);
check('definition identity', definition.id === 'z' && definition.name === 'Z' && definition.order === PERSONA_ORDER_BASE + 4);
// The offset exists so a persona can never outrank a built-in. The registry sorts
// on one key — (a.order ?? Infinity) - (b.order ?? Infinity) || a.id.localeCompare(b.id)
// — over built-ins holding 1..4, so a wife with `order: 1` must still land below
// cordis (4). Reproduce that comparator here rather than trusting the arithmetic.
const builtins = [
  { id: 'standard', order: 1 },
  { id: 'ptc', order: 2 },
  { id: 'minimal', order: 3 },
  { id: 'cordis', order: 4 },
];
const wives = [1, 2, 4, 9].map((n) => buildDefinition(`w${n}`, { name: `W${n}`, order: n }, 'B', []));
const mixed = [...builtins, ...wives].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.id.localeCompare(b.id));
check(
  'every built-in still precedes every persona, whatever the file says',
  mixed.slice(0, 4).every((row) => builtins.some((b) => b.id === row.id)) &&
    mixed.slice(4).every((row) => !builtins.some((b) => b.id === row.id)),
);
check('no order in the file means no order on the wire', buildDefinition('z', { name: 'Z' }, 'B', []).order === undefined);

/*
 * The one template field that decides whether a mid-session switch is even
 * possible. `@deepseek-ai/dsh-persona` maps `includeRuntimeContext: false` onto
 * `systemPrompt.suppressRuntimeContext()`, and that suppressor drops EVERY
 * runtime-context contribution in the agent scope — our identity snapshot
 * included. Shipped `false` once, and the switch silently degraded to "the system
 * prompt changed and the model ignored it". See `identityNoticeOf`.
 */
const templateRows = JSON.parse(fs.readFileSync(path.join(HERE, 'template.json'), 'utf8'));
const personaRow = templateRows.find((row) => row.name === '@deepseek-ai/dsh-persona');
check(
  'the persona row must not suppress runtime context',
  personaRow !== undefined &&
    personaRow.config?.complete === true &&
    personaRow.config?.includeRuntimeContext !== false,
  JSON.stringify(personaRow),
);

check(
  'only the persona row is rewritten',
  definition.plugins[0].config.prefix === PERSONA_PLACEHOLDER &&
    definition.plugins[0].config.complete === true &&
    definition.plugins[1].name === '@deepseek-ai/dsh-tool-fs',
);
check(
  'id guard',
  ID_OK.test('good-id-2') &&
    ID_OK.test('后藤一里') &&
    !ID_OK.test('Bad Name') &&
    !ID_OK.test('../evil') &&
    !ID_OK.test('-leading'),
);
check('a later patch is newer', isNewer('0.1.1', '0.1.0') === true);
check('a later minor beats an earlier one', isNewer('0.2.0', '0.1.9') === true);
check('an earlier version is not newer', isNewer('0.0.9', '0.1.0') === false);
check('the same version is not newer', isNewer('0.1.0', '0.1.0') === false);
check(
  'a prerelease sorts before its own release',
  isNewer('1.0.0-rc.1', '1.0.0') === false && isNewer('1.0.0', '1.0.0-rc.1') === true,
);
check(
  'an unreadable version never counts as an update',
  isNewer('latest', '0.1.0') === false && isNewer('0.2.0', 'unknown') === false,
);

console.log('--- directory resolution (no config required) ---');
const fakeHome = path.join(HERE, '.tmp-home');
fs.mkdirSync(path.join(fakeHome, 'personas'), { recursive: true });
fs.mkdirSync(path.join(fakeHome, 'profiles', 'desktop'), { recursive: true });
const fromConfig = resolveDir({ dir: tmp, packageDir: HERE, env: {} });
check('an explicit config.dir wins', fromConfig.dir === path.resolve(tmp) && fromConfig.source === 'config');
const fromProfile = resolveDir({ packageDir: HERE, env: { DSH_PROFILE_DIR: path.join(fakeHome, 'profiles', 'desktop') } });
check(
  'DSH_PROFILE_DIR resolves to <home>/personas',
  fromProfile.dir === path.join(fakeHome, 'personas') && fromProfile.source === 'DSH_PROFILE_DIR',
  JSON.stringify(fromProfile),
);
const fromHomeVar = resolveDir({ packageDir: HERE, env: { DSH_HOME: fakeHome } });
check(
  'DSH_HOME alone also resolves to <home>/personas',
  fromHomeVar.dir === path.join(fakeHome, 'personas') && fromHomeVar.source === 'DSH_HOME',
  JSON.stringify(fromHomeVar),
);
const fallbackHome = path.join(HERE, '.tmp-home-fallback');
fs.mkdirSync(fallbackHome, { recursive: true });
const fallbackTarget = path.join(fallbackHome, '.dsh', 'personas');
const fromFallback = resolveDir({ packageDir: HERE, env: { USERPROFILE: fallbackHome }, seed: true });
check(
  'a host that exports neither variable still gets a writable <system home>/.dsh/personas',
  fromFallback.dir === fallbackTarget && fromFallback.source === 'seeded' && fs.existsSync(fallbackTarget),
  JSON.stringify(fromFallback),
);
const adoptedFallback = resolveDir({ packageDir: HERE, env: { USERPROFILE: fallbackHome } });
check(
  'an existing fallback directory is adopted, never re-seeded',
  adoptedFallback.dir === fallbackTarget && adoptedFallback.source === 'default',
  JSON.stringify(adoptedFallback),
);
fs.rmSync(fallbackHome, { recursive: true, force: true });
fs.rmSync(fakeHome, { recursive: true, force: true });

console.log('--- first run on a machine that has never seen this plugin ---');
const freshHome = path.join(HERE, '.tmp-home-fresh');
/*
 * Clear it BEFORE planting, not only after (line ~430 does that). The block
 * below asserts that a home which has never seen this plugin leaves the package
 * directory alone — and `resolveDir` ADOPTS an existing `<home>/personas`
 * instead of seeding it, so a leftover from an interrupted run turns "nothing
 * was created" into a failure that has nothing to do with the code. The
 * assertion right above this block already pins the adopt-on-exists semantics;
 * this one is not the place to re-measure it by accident.
 */
fs.rmSync(freshHome, { recursive: true, force: true });
fs.mkdirSync(path.join(freshHome, 'profiles', 'desktop'), { recursive: true });
const freshEnv = { DSH_PROFILE_DIR: path.join(freshHome, 'profiles', 'desktop') };
const freshTarget = path.join(freshHome, 'personas');

const untouched = resolveDir({ packageDir: HERE, env: freshEnv });
check(
  'without seed nothing is created',
  untouched.dir === path.join(HERE, 'personas') &&
    untouched.source === 'package' &&
    !fs.existsSync(freshTarget),
  JSON.stringify(untouched),
);


const seeded = resolveDir({ packageDir: HERE, env: freshEnv, seed: true });
check(
  'seed: true plants <home>/personas',
  seeded.dir === freshTarget && seeded.source === 'seeded' && fs.existsSync(freshTarget),
  JSON.stringify(seeded),
);
const planted = fs.readdirSync(freshTarget).sort();
const shipped = fs.readdirSync(path.join(HERE, 'personas')).sort();
check(
  'the shipped personas landed',
  JSON.stringify(planted) === JSON.stringify(shipped),
  JSON.stringify(planted),
);
check(
  'the package ships exactly one persona, and no format-demo example',
  SHIPPED.length === 1 && !fs.existsSync(path.join(HERE, 'personas', 'example.md')),
  JSON.stringify(SHIPPED),
);
check(
  'what landed is byte-for-byte what shipped',
  fs.readFileSync(path.join(freshTarget, SHIPPED_PERSONA), 'utf8') ===
    fs.readFileSync(path.join(HERE, 'personas', SHIPPED_PERSONA), 'utf8'),
);
check(
  'no staging directory was left behind',
  fs.readdirSync(freshHome).sort().join(',') === 'personas,profiles',
  JSON.stringify(fs.readdirSync(freshHome)),
);

fs.writeFileSync(path.join(freshTarget, 'mine.md'), 'custom', 'utf8');
const again = resolveDir({ packageDir: HERE, env: freshEnv, seed: true });
check(
  'an existing directory is adopted, never re-seeded',
  again.dir === freshTarget && again.source === 'DSH_PROFILE_DIR',
  JSON.stringify(again),
);
check(
  'and it was left exactly as the user had it',
  fs.readFileSync(path.join(freshTarget, 'mine.md'), 'utf8') === 'custom' &&
    fs.readdirSync(freshTarget).length === planted.length + 1,
  JSON.stringify(fs.readdirSync(freshTarget)),
);
fs.rmSync(freshHome, { recursive: true, force: true });

const barePackage = path.join(HERE, '.tmp-bare-package');
const bareHome = path.join(HERE, '.tmp-home-bare');
fs.mkdirSync(barePackage, { recursive: true });
fs.mkdirSync(path.join(bareHome, 'profiles', 'desktop'), { recursive: true });
const bareTarget = path.join(bareHome, 'personas');
const noSource = resolveDir({
  packageDir: barePackage,
  env: { DSH_PROFILE_DIR: path.join(bareHome, 'profiles', 'desktop') },
  seed: true,
});
check(
  'nothing to seed from degrades quietly',
  noSource.dir === path.join(barePackage, 'personas') &&
    noSource.source === 'package' &&
    !fs.existsSync(bareTarget),
  JSON.stringify(noSource),
);
fs.rmSync(bareHome, { recursive: true, force: true });
fs.rmSync(barePackage, { recursive: true, force: true });

console.log('--- apply + first scan ---');
// The override store lives beside <home>, so point the home at the scratch
// directory: a self-test must not write into the real profile.
process.env.DSH_HOME = tmp;
apply(stub, { dir: tmp, template: path.join(HERE, 'template.json') });
await new Promise((resolve) => setTimeout(resolve, 150));
check('alpha registered', presets.has('alpha'));
check('alpha prefix is the body', resolved('alpha') === 'Alpha body.');
check('capability list kept its 20 rows', presets.get('alpha')?.plugins?.length === 20);
check('README.md skipped', !presets.has('README'));
check('illegal file name not registered', !presets.has('Bad Name'));
check('command registered', commands.has('persona'));
check('the webserver service was injected, not fetched', injected.includes('webServer'), JSON.stringify(injected));
check(
  'the panel route reached the webserver route table',
  routes.has('prefix /waifu-agents/api'),
  JSON.stringify([...routes.keys()]),
);

const cmd = commands.get('persona');
const call = async (request) =>
  JSON.parse(
    (
      await cmd.handler({
        rawInput: JSON.stringify(request),
        agent: { id: 'stub-session' },
        attachments: [],
        signal: new AbortController().signal,
      })
    ).text,
  );

console.log('--- op: list ---');
const listed = await call({ op: 'list' });
check('list reports ok', listed.ok === true);
check('list sees the two md files', listed.files?.length === 2, JSON.stringify(listed.files?.map((f) => f.id)));
check('list owns alpha', Array.isArray(listed.owned) && listed.owned.includes('alpha'));
check('directory echoed back', typeof listed.dir === 'string' && listed.dir.length > 0);

console.log('--- op: create ---');
const created = await call({ op: 'create', id: 'beta', name: 'Beta', order: 5, description: 'second', body: 'Beta body.\nSecond line.' });
check('create reports ok', created.ok === true, JSON.stringify(created));
check('beta.md exists', fs.existsSync(path.join(tmp, 'beta.md')));
check('beta registered', presets.has('beta'));
check(
  'multi-line body survived the one-line JSON request',
  resolved('beta') === 'Beta body.\nSecond line.',
);

const badId = await call({ op: 'create', id: '../evil', body: 'x' });
check('illegal id refused', badId.ok === false);
check('illegal id wrote nothing', !fs.existsSync(path.join(tmp, '..', 'evil.md')));

console.log('--- duplicate id held by another owner ---');
presets.set('gamma', { id: 'gamma', plugins: [] });
const duplicate = await call({ op: 'create', id: 'gamma', body: 'x' });
check('duplicate refused before writing', duplicate.ok === false && !fs.existsSync(path.join(tmp, 'gamma.md')), JSON.stringify(duplicate));
presets.delete('gamma');

console.log('--- op: update (the file name follows the display name) ---');
const updated = await call({ op: 'update', id: 'beta', name: 'Beta 2', body: 'Beta body v2.' });
check('update reports ok', updated.ok === true, JSON.stringify(updated));
check('the id followed the name', updated.id === 'beta-2' && updated.moved === true, JSON.stringify(updated));
check(
  'the file moved with it',
  !fs.existsSync(path.join(tmp, 'beta.md')) && fs.existsSync(path.join(tmp, 'beta-2.md')),
);
check('the new id is registered, the old one is not', presets.has('beta-2') && !presets.has('beta'));
check('update re-registered with the new body', resolved('beta-2') === 'Beta body v2.');
check('update rewrote the display name', presets.get('beta-2')?.name === 'Beta 2');
const sameName = await call({ op: 'update', id: 'beta-2', name: 'Beta 2', description: 'touched' });
check(
  'saving the same name again does not collide with its own file',
  sameName.ok === true && sameName.id === 'beta-2' && sameName.moved === false,
  JSON.stringify(sameName),
);
const clearedName = await call({ op: 'update', id: 'beta-2', name: '' });
check(
  'clearing the name does not move the file to persona.md',
  clearedName.ok === true &&
    clearedName.id === 'beta-2' &&
    !clearedName.moved &&
    !fs.existsSync(path.join(tmp, 'persona.md')),
  JSON.stringify(clearedName),
);
const emptyBody = await call({ op: 'update', id: 'beta-2', body: '   ' });
check('update refuses an empty body', emptyBody.ok === false);

console.log('--- op: remove (retire, never delete) ---');
const removed = await call({ op: 'remove', id: 'beta-2' });
check('remove reports ok', removed.ok === true);
check('the archive is <id>.md.off', removed.archived === path.join(tmp, 'beta-2.md.off'), String(removed.archived));
check(
  'the md file was renamed, not deleted',
  !fs.existsSync(path.join(tmp, 'beta-2.md')) && fs.existsSync(path.join(tmp, 'beta-2.md.off')),
);
check(
  'the archive kept the text',
  fs.readFileSync(path.join(tmp, 'beta-2.md.off'), 'utf8').includes('Beta body v2.'),
);
check('beta-2 unregistered', !presets.has('beta-2'));
const afterRemove = await call({ op: 'list' });
check(
  'the archive is invisible to the directory scan',
  afterRemove.files.every((file) => file.id !== 'beta-2'),
  JSON.stringify(afterRemove.files.map((file) => file.id)),
);

console.log('--- op: get ---');
const fetched = await call({ op: 'get', id: 'alpha' });
check('get returns ok', fetched.ok === true, JSON.stringify(fetched));
check('get returns the stored answer style', fetched.body === 'Alpha body.');
check('get returns the summary', fetched.description === 'first one');
check('get returns the assigned order', fetched.order === 3);
const missingGet = await call({ op: 'get', id: 'nope' });
check('get refuses an unknown id', missingGet.ok === false);

console.log('--- id and order are assigned by the host ---');
const auto = await call({ op: 'create', name: '中文名字', description: '自动', body: '自动生成的正文。' });
check('a blank id is generated', auto.ok === true && ID_OK.test(String(auto.id ?? '')), JSON.stringify(auto));
check('the generated file exists', typeof auto.id === 'string' && fs.existsSync(path.join(tmp, `${auto.id}.md`)));
check('order is the highest in the directory plus one', auto.order === 4, JSON.stringify(auto.order));
const autoTwo = await call({ op: 'create', name: '另一个中文名', body: '第二份正文。' });
check('a second blank id does not collide', autoTwo.ok === true && autoTwo.id !== auto.id, JSON.stringify(autoTwo));
check('its order keeps climbing', autoTwo.order === 5, JSON.stringify(autoTwo.order));
const latin = await call({ op: 'create', name: 'Yuki Onna', body: 'Latin name body.' });
check('a Latin name slugifies into the id', latin.id === 'yuki-onna', JSON.stringify(latin));
const jump = await call({ op: 'create', id: 'zeta', name: 'Zeta', body: 'Explicit id body.', order: 42 });
check('an explicit order is still honoured when given', jump.ok === true && jump.order === 42, JSON.stringify(jump.order));
const fetchedAuto = await call({ op: 'get', id: auto.id });
check('the generated id round-trips through get', fetchedAuto.ok === true && fetchedAuto.body === '自动生成的正文。');
for (const id of [auto.id, autoTwo.id, latin.id, 'zeta']) await call({ op: 'remove', id });

console.log('--- rename (the id is the identity) ---');
const renamed = await call({ op: 'rename', id: 'alpha', to: 'alpha-renamed' });
check('rename reports ok', renamed.ok === true, JSON.stringify(renamed));
check('the file moved', !fs.existsSync(path.join(tmp, 'alpha.md')) && fs.existsSync(path.join(tmp, 'alpha-renamed.md')));
check('the new id is registered', presets.has('alpha-renamed'));
check('the old id is gone', !presets.has('alpha'));
const renamedBack = await call({ op: 'rename', id: 'alpha-renamed', to: 'alpha' });
check('renaming back works', renamedBack.ok === true && presets.has('alpha') && !presets.has('alpha-renamed'));
const clash = await call({ op: 'rename', id: 'alpha', to: 'Bad Name' });
check('an illegal target id is refused', clash.ok === false);
const ontoExisting = await call({ op: 'rename', id: 'alpha', to: 'README' });
check('renaming onto a skipped name is refused', ontoExisting.ok === false, JSON.stringify(ontoExisting));
const sameId = await call({ op: 'rename', id: 'alpha', to: 'alpha' });
check('renaming to itself is a no-op', sameId.ok === true && sameId.unchanged === true);
const lowerReadme = await call({ op: 'rename', id: 'alpha', to: 'readme' });
check('a reserved target is refused even lower-cased', lowerReadme.ok === false, JSON.stringify(lowerReadme));

console.log('--- reserved names are refused while absent, too ---');
const readmeText = fs.readFileSync(path.join(tmp, 'README.md'), 'utf8');
fs.rmSync(path.join(tmp, 'README.md'));
const reservedCreate = await call({ op: 'create', id: 'README', name: 'X', body: 'y' });
check(
  'a reserved file name is refused even when no file occupies it',
  reservedCreate.ok === false && String(reservedCreate.error).includes('保留'),
  JSON.stringify(reservedCreate),
);
fs.writeFileSync(path.join(tmp, 'README.md'), readmeText, 'utf8');

console.log('--- import / export ---');
const imported = await call({
  op: 'import',
  content: '---\nname: 导入的\norder: 77\ndescription: 从 md 来\n---\n\n导入正文第一行。\n第二行。\n',
});
check('import reports ok', imported.ok === true, JSON.stringify(imported));
check('import kept the order from the file', imported.order === 77, JSON.stringify(imported.order));
const importedBack = await call({ op: 'get', id: imported.id });
check('import kept the name', importedBack.name === '导入的');
check('import kept the summary', importedBack.description === '从 md 来');
check('import kept the multi-line answer style', importedBack.body === '导入正文第一行。\n第二行。');
const bare = await call({ op: 'import', content: '就是一段普通文字，没有 front matter。' });
check('import accepts a bare md', bare.ok === true && bare.id !== imported.id, JSON.stringify(bare));
const bareBack = await call({ op: 'get', id: bare.id });
check('a bare md becomes the whole answer style', bareBack.body === '就是一段普通文字，没有 front matter。');
const exported = await call({ op: 'export', id: imported.id });
check('export returns the file text', exported.ok === true && exported.content.includes('导入正文第一行。'));
check('export names the file after the id', exported.filename === `${imported.id}.md`);
check('an exported file imports back unchanged', exported.content === '---\nname: 导入的\norder: 77\ndescription: 从 md 来\n---\n\n导入正文第一行。\n第二行。\n', JSON.stringify(exported.content));
const all = await call({ op: 'exportAll' });
check('exportAll returns every md file', all.ok === true && all.files?.length === 4, JSON.stringify(all.files?.map((f) => f.id)));
const templateFile = await call({ op: 'template' });
check(
  'template hands over the shipped persona, under its own file name',
  templateFile.ok === true && templateFile.filename === SHIPPED_PERSONA,
  JSON.stringify({ ok: templateFile.ok, filename: templateFile.filename }),
);
check(
  'template text is the file on disk, byte for byte',
  templateFile.content === fs.readFileSync(path.join(HERE, 'personas', SHIPPED_PERSONA), 'utf8'),
);

console.log('--- the answer style has no format requirements ---');
const weirdBody = '---\nname: not front matter\n: leading colon\n### heading\n- bullet\n\nsecond paragraph';
const weird = await call({ op: 'create', id: 'weird', name: 'Weird', body: weirdBody });
check('weird content is accepted', weird.ok === true, JSON.stringify(weird));
const weirdBack = await call({ op: 'get', id: 'weird' });
check('a body containing --- and colons round-trips exactly', weirdBack.body === weirdBody, JSON.stringify(weirdBack.body));
check('the name field survived the weird body', weirdBack.name === 'Weird');
const weirdFile = fs.readFileSync(path.join(tmp, 'weird.md'), 'utf8');
check('the stored file still parses back to the same body', parseFrontMatter(weirdFile).body === weirdBody);
await call({ op: 'remove', id: 'weird' });
await call({ op: 'remove', id: imported.id });
await call({ op: 'remove', id: bare.id });

console.log('--- a Chinese id (the file name really is the id) ---');
const cjk = await call({ op: 'create', name: '后藤一里', description: '中文 id', body: '中文正文。' });
check('a Chinese name becomes the id itself', cjk.ok === true && cjk.id === '后藤一里', JSON.stringify(cjk));
check('the file is named after it', fs.existsSync(path.join(tmp, '后藤一里.md')));
check('it registered under the Chinese id', presets.has('后藤一里'));
const cjkList = await call({ op: 'list' });
check(
  'the scan does not call it illegal',
  cjkList.files.some((file) => file.id === '后藤一里' && file.idOk === true),
  JSON.stringify(cjkList.files.map((file) => file.id)),
);
const cjkRename = await call({ op: 'rename', id: '后藤一里', to: '後藤ひとり' });
check(
  'a Chinese id renames like any other',
  cjkRename.ok === true && presets.has('後藤ひとり'),
  JSON.stringify(cjkRename),
);

console.log('--- setDir without the service ---');
const dirAttempt = await call({ op: 'setDir', dir: tmp });
check('setDir explains itself when configEditor is absent', dirAttempt.ok === false && String(dirAttempt.error).includes('configEditor'), JSON.stringify(dirAttempt));

console.log('--- default persona (it lives on the registry entry, not on us) ---');
defaultId = 'alpha';
const seen = await call({ op: 'roster' });
check('roster reports ok', seen.ok === true, JSON.stringify(seen));
check('roster marks the default row', seen.presets?.find((row) => row.id === 'alpha')?.isDefault === true);
check('roster carries a broken field on every row', seen.presets?.every((row) => 'broken' in row) === true);
check(
  'a default that names a live preset reports as resolving',
  seen.defaultResolves === true,
  JSON.stringify(seen.defaultResolves),
);
const withDefault = await call({ op: 'list' });
check('list reports the live default', withDefault.defaultId === 'alpha', JSON.stringify(withDefault.defaultId));
const ghost = await call({ op: 'setDefault', id: 'nosuchwife' });
check('setDefault refuses an id with no file', ghost.ok === false, JSON.stringify(ghost));
const noEditor = await call({ op: 'setDefault', id: 'alpha' });
check(
  'setDefault explains itself when configEditor is absent',
  noEditor.ok === false && String(noEditor.error).includes('configEditor'),
  JSON.stringify(noEditor),
);

console.log('--- default persona when only a flagless face answers ---');
flaglessOnly = true;
const flagless = await call({ op: 'list' });
check(
  'a flagless roster reports no default instead of a confident false',
  flagless.defaultId === null && flagless.defaultSource === 'list',
  JSON.stringify({ id: flagless.defaultId, source: flagless.defaultSource }),
);
/*
 * With nothing named, 「解不解得开」 has no answer — and `false` there would
 * accuse a profile that simply has nothing set. The panel only ever shows the
 * warning on a hard `false`, so this tri-state is load-bearing.
 */
const unknownResolve = await call({ op: 'roster' });
check(
  'an unnamed default reports "unknown", never "points at nothing"',
  unknownResolve.defaultResolves === null,
  JSON.stringify(unknownResolve.defaultResolves),
);
flaglessOnly = false;
const recovered = await call({ op: 'list' });
check(
  'the face that promises the flag restores the default',
  recovered.defaultId === 'alpha' && recovered.defaultSource === 'remoteExportList',
  JSON.stringify({ id: recovered.defaultId, source: recovered.defaultSource }),
);
defaultId = null;

console.log('--- the default is written the way the app writes it ---');
/*
 * `Settings → Agent Presets` goes through `settings.update(ns, patch)`, and that
 * call is the only thing that emits `settings/document-updated` — the single
 * event `ui-agent-preset` listens to before it re-reads the roster into the
 * new-task chip. A bare `configEditor.edit()` writes the same bytes and wakes
 * nobody, which is why changing the default here looked like it did nothing
 * while changing it there worked. So the service has to be the FIRST choice.
 */
const writes = [];
services = {
  settings: {
    describe: () => [
      {
        ns: 'agent-preset-registry',
        value: { selectedDefault: defaultId ?? '' },
        revision: writes.length + 1,
      },
    ],
    update: async (ns, patch) => {
      writes.push({ op: 'update', ns, patch });
      defaultId = patch.selectedDefault;
    },
    mutate: async (ns, ops) => {
      writes.push({ op: 'mutate', ns, ops });
      defaultId = null;
    },
  },
  configEditor: {
    entries: () => [
      {
        options: {
          id: 'agent-preset-registry',
          name: '@deepseek-ai/dsh-agent-preset-registry',
        },
      },
    ],
    edit: async () => {
      throw new Error('configEditor.edit must not be the first choice any more');
    },
  },
};
const viaService = await call({ op: 'setDefault', id: 'alpha' });
check(
  'setDefault writes through settings.update',
  viaService.ok === true &&
    writes.length === 1 &&
    writes[0].op === 'update' &&
    writes[0].ns === 'agent-preset-registry' &&
    writes[0].patch?.selectedDefault === 'alpha',
  JSON.stringify({ viaService, writes }),
);
const agrees = await call({ op: 'list' });
check(
  'and the value the app is holding is the one the panel reports',
  agrees.defaultId === 'alpha',
  JSON.stringify(agrees.defaultId),
);
const clearedViaService = await call({ op: 'setDefault', id: '' });
check(
  'clearing goes through settings.mutate, not a delete in the editor',
  clearedViaService.ok === true &&
    writes.length === 2 &&
    writes[1].op === 'mutate' &&
    writes[1].ops?.[0]?.op === 'unset' &&
    writes[1].ops?.[0]?.path?.[0] === 'selectedDefault',
  JSON.stringify({ clearedViaService, writes }),
);
/*
 * The fallback still has to work: a profile with no settings service at all is
 * the one case where the editor path is all there is.
 */
services = {
  configEditor: {
    entries: () => [
      {
        options: {
          id: 'agent-preset-registry',
          name: '@deepseek-ai/dsh-agent-preset-registry',
        },
      },
    ],
    edit: async (_entry, change) => {
      const next = change({});
      writes.push({ op: 'edit', patch: next });
      defaultId = next.selectedDefault ?? null;
    },
  },
};
const viaEditor = await call({ op: 'setDefault', id: 'alpha' });
check(
  'a profile with no settings service still writes through the editor',
  viaEditor.ok === true && writes.at(-1)?.op === 'edit',
  JSON.stringify({ viaEditor, last: writes.at(-1) }),
);
services = {};
defaultId = null;

console.log('--- the session already on screen is re-seated, not just future ones ---');
/*
 * Writing `selectedDefault` decides what a session created LATER is stamped
 * with. The blank session already sitting on the new-task screen keeps the
 * `agentPreset` its header was stamped with at creation, because
 * `agentPresetProjectionDefinition.init` reads the header once and only an
 * `agent-preset/selected` event ever advances the projection afterwards.
 *
 * `Settings → Agent Presets` covers that with a SECOND step. Its `save()` runs
 *
 *     await write()            // settings.update(ns, { selectedDefault })
 *     await this.load()        // re-read the roster
 *     await sync(selected.id)  // syncBlankSession → seat.apply() → select()
 *
 * so the official page moves the default AND re-seats the blank session onto it,
 * while the plugin used to do only the first. The registry was therefore already
 * correct — that page showed the right 「新任务默认」 badge at the same moment —
 * while the chip went on naming the wife the blank session was born with. That
 * split is exactly 「插件里改默认，新会话没跟着变；在 Agent 预设里改就正常」.
 *
 * `select()` is the mover rather than a hand-rolled append: for a session that
 * has not opened a turn it re-binds the preset tree and THEN appends, so the
 * label and the composition cannot disagree. It also brings the guard we want
 * for free — a session that already started a turn is refused with
 * `agent-preset/locked` — so the refusals do the filtering instead of a blank
 * test guessed here.
 */
fs.writeFileSync(
  path.join(tmp, 'rest.md'),
  '---\nname: Rest\norder: 7\n---\n\nRest body.\n',
  'utf8',
);
const rows = [
  // The reported case: still following the default it was born with.
  { id: 'blank-following', header: { agentPreset: 'alpha' }, projection: 'alpha' },
  // Pointed somewhere else on purpose — a deliberate pick must survive a change
  // to the GLOBAL default.
  { id: 'blank-elsewhere', header: { agentPreset: 'minimal' }, projection: 'minimal' },
  // Already opened a turn. The platform refuses; nothing here may force it.
  { id: 'started', header: { agentPreset: 'alpha' }, projection: 'alpha' },
  /*
   * Header and projection DISAGREE, because this one was re-selected at some
   * point. The chip renders the projection, so reading the header here would
   * skip a session the user is actually looking at — this row is what makes the
   * test able to tell the two apart rather than merely agreeing with itself.
   */
  { id: 'blank-repicked', header: { agentPreset: 'minimal' }, projection: 'alpha' },
];
for (const row of rows) shown.set(row.id, row.projection);
locked.add('started');
services = {
  settings: {
    describe: () => [
      { ns: 'agent-preset-registry', value: { selectedDefault: defaultId ?? '' } },
    ],
    update: async (ns, patch) => {
      defaultId = patch.selectedDefault;
    },
    mutate: async () => {
      defaultId = null;
    },
  },
  configEditor: {
    entries: () => [
      {
        options: {
          id: 'agent-preset-registry',
          name: '@deepseek-ai/dsh-agent-preset-registry',
        },
      },
    ],
    edit: async () => {
      throw new Error('configEditor.edit must not be the first choice any more');
    },
  },
  agents: {
    list: () =>
      rows.map((row) => ({ id: row.id, session: { id: row.id, header: row.header } })),
  },
  // The truth the chip renders. `header` is deliberately not consulted first.
  sessionProjections: {
    stateOf: (session, key) =>
      key === 'agentPreset' ? shown.get(session.id) ?? null : undefined,
  },
};
defaultId = 'alpha';
const reseated = await call({ op: 'setDefault', id: 'rest' });
check(
  'a default write also re-seats the sessions that were following the old one',
  reseated.ok === true &&
    selectCalls.length === 2 &&
    selectCalls.map((one) => one.session).join(',') === 'blank-following,blank-repicked' &&
    selectCalls.every((one) => one.id === 'rest'),
  JSON.stringify({ reseated, selectCalls }),
);
check(
  'the write went through the service and says so',
  reseated.via === 'settings',
  String(reseated.via),
);
check(
  'a session pointed somewhere else on purpose is left alone',
  shown.get('blank-elsewhere') === 'minimal' && !locked.has('blank-elsewhere'),
  String(shown.get('blank-elsewhere')),
);
/*
 * The guard is the platform's, not ours: `select()` refuses a session that has
 * already started, so the plugin never has to decide what "blank" means.
 */
check(
  'and a session that already started is refused, not dragged along',
  shown.get('started') === 'alpha' && reseated.resettled?.join(',') === 'blank-following,blank-repicked',
  JSON.stringify({ started: shown.get('started'), resettled: reseated.resettled }),
);
/*
 * Nothing names a default for this profile, so there is no previous id to
 * compare against. Refusing to guess is the conservative answer: moving every
 * unstarted session on a default the plugin cannot name would drag along
 * sessions the user had pointed somewhere else.
 *
 * `settings` deliberately has no `describe` here. A settings face that answers
 * with an EMPTY document still stamps `source: "settings"` inside
 * `readDefaultId`, and `refreshDefault` then serves that read from its cache for
 * two seconds — long enough for the next section to measure these leftovers
 * instead of its own state. A profile with no settings face at all is also the
 * honest shape for "no default is named anywhere".
 */
services = {
  ...services,
  settings: { update: async () => {}, mutate: async () => {} },
};
defaultId = null;
selectCalls.length = 0;
const guessed = await call({ op: 'setDefault', id: 'rest' });
check(
  'with no previous default to compare against, nothing is guessed at',
  guessed.ok === true && selectCalls.length === 0 && typeof guessed.resettleSkipped === 'string',
  JSON.stringify({ guessed: guessed.resettleSkipped, selectCalls }),
);
fs.rmSync(path.join(tmp, 'rest.md'), { force: true });
services = {};
defaultId = null;
shown.clear();
locked.clear();
selectCalls.length = 0;

console.log('--- version check and self-update ---');
const ownVersion = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;
const realFetch = globalThis.fetch;
let asked = null;
// The registry, stubbed: one GET for this package, answering the abbreviated
// document npm serves, which is all `latestVersion` reads.
globalThis.fetch = async (url, options) => {
  asked = { url: String(url), accept: options?.headers?.accept };
  return { ok: true, status: 200, json: async () => ({ 'dist-tags': { latest: '9.9.9' } }) };
};
const checked = await call({ op: 'updateCheck' });
check('updateCheck reports the version that is running', checked.running === ownVersion, JSON.stringify(checked.running));
check(
  'the check went to the registry for this package',
  asked?.url === 'https://registry.npmjs.org/dsh-waifu-agents' && typeof asked.accept === 'string',
  JSON.stringify(asked),
);
check(
  'a newer release is reported as an update',
  checked.updateAvailable === true && checked.latest === '9.9.9',
  JSON.stringify(checked),
);
check('nothing needs a restart yet', checked.restartPending === false, JSON.stringify(checked));
check('the pluginManager service was found', checked.canInstall === true, JSON.stringify(checked));

/**
 * Let the launcher's background work run to its end.
 *
 * `updateApply` returns BEFORE the install finishes on purpose — holding the
 * HTTP response open for pnpm is what made 「装完了没有」 unanswerable — so
 * every test that wants the outcome has to let the queue drain first. One
 * macrotask turn is past the stub's own `await` and the few the caller's
 * `void (async () => …)()` wrapper needs.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Hold this install open: the guard below only exists while one is in flight.
installGate = new Promise((resolve) => {
  openGate = resolve;
});
const applied = await call({ op: 'updateApply', version: '9.9.9' });
check(
  'updateApply installs the EXACT version, never a range',
  applied.ok === true && installs.at(-1)?.spec === 'dsh-waifu-agents@9.9.9',
  JSON.stringify({ applied, installs }),
);
/*
 * What the launch hands back is the whole point of this shape: it names the
 * installation instead of blocking on it. The id is not decoration —
 * `pluginManager` publishes progress ONLY for a call that carried one
 * (`announce()` returns early without it), so a launch that dropped it would
 * leave the progress window on 「准备中」 until the job ended, which is exactly
 * the 「装完了也不知道」 this replaces.
 */
check(
  'the launch names the installation instead of waiting for it',
  applied.started === true && typeof applied.requestId === 'string' && applied.requestId !== '',
  JSON.stringify(applied),
);
check(
  'and the manager was handed that same id — which is what buys a progress feed',
  installs.at(-1)?.options?.requestId === applied.requestId,
  JSON.stringify(installs.at(-1)?.options),
);
const during = await call({ op: 'updateApply', version: '9.9.9' });
check(
  'a second launch while one is in flight is refused, naming the running one',
  during.ok === false && during.running === true && during.requestId === applied.requestId,
  JSON.stringify(during),
);
check('and the refused launch never reached pnpm', installs.length === 1, JSON.stringify(installs));

openGate();
installGate = null;
await settle();
const finished = await call({ op: 'updateProgress', requestId: applied.requestId });
check(
  'the finished job keeps answering with the manager’s own words',
  finished.ok === true && finished.done === true && finished.error === null && finished.result?.application === 'restart-required',
  JSON.stringify(finished),
);
check(
  'and it reports how long it ran, so the window can show a clock',
  Number.isFinite(finished.elapsedMs) && finished.idle === false,
  JSON.stringify({ elapsedMs: finished.elapsedMs, idle: finished.idle }),
);

const noop = await call({ op: 'updateApply', version: ownVersion });
check(
  'installing the version already on disk is a no-op',
  noop.ok === true && noop.started === false && noop.result?.application === 'current' && installs.length === 1,
  JSON.stringify({ noop, installs }),
);
const nonsense = await call({ op: 'updateApply', version: 'not-a-version' });
check('a nonsense version never reaches pnpm', nonsense.ok === false && installs.length === 1, JSON.stringify(nonsense));

/*
 * Now the feed itself. Every field the progress window draws comes from these
 * two events, so standing in for the platform here is what makes the window
 * testable at all.
 */
// Held open again, so the phases below are read while the job really is running.
installGate = new Promise((resolve) => {
  openGate = resolve;
});
const feed = await call({ op: 'updateApply', version: '9.9.9', requestId: 'feed-test' });
check(
  'an id the panel minted is used as-is, so a chunk that beats the response still lands',
  feed.requestId === 'feed-test' && installs.at(-1)?.options?.requestId === 'feed-test',
  JSON.stringify({ feed, options: installs.at(-1)?.options }),
);
const never = await call({ op: 'updateProgress', requestId: 'never-started' });
check(
  'an id that was never started reads as idle, not as a finished job',
  never.idle === true && never.done === undefined && never.result === undefined,
  JSON.stringify(never),
);

emit('plugin-manager/install-state', {
  requestId: 'feed-test',
  phase: 'installing',
  attempt: { registry: 'https://registry.npmjs.org/', index: 1, total: 2 },
});
emit('plugin-manager/install-log', {
  requestId: 'feed-test',
  jobId: 'job-1',
  argv: ['pnpm', 'add', 'dsh-waifu-agents@9.9.9'],
  cwd: '/tmp',
  stream: 'stdout',
  text: 'Progress: resolved 1, reused 0\n',
});
const midway = await call({ op: 'updateProgress', requestId: 'feed-test' });
check(
  'the phase the platform announced is what the window draws',
  midway.phase === 'installing' && midway.attempt?.index === 1 && midway.attempt?.total === 2 && midway.seenFeed === true,
  JSON.stringify({ phase: midway.phase, attempt: midway.attempt, seenFeed: midway.seenFeed }),
);
check(
  'and pnpm’s own output streams into the same window',
  midway.log === 'Progress: resolved 1, reused 0\n' && midway.pnpmExit === null,
  JSON.stringify({ log: midway.log, pnpmExit: midway.pnpmExit }),
);
check('a job the feed still calls running is not reported as done', midway.done === false, JSON.stringify(midway));

emit('plugin-manager/install-state', { requestId: 'feed-test', phase: 'applying' });
const applying = await call({ op: 'updateProgress', requestId: 'feed-test' });
check('the applying phase is carried through in order', applying.phase === 'applying', JSON.stringify(applying));

// Someone else's installation is none of this job's business.
emit('plugin-manager/install-state', { requestId: 'someone-else', phase: 'cancelling' });
emit('plugin-manager/install-log', { requestId: 'someone-else', stream: 'stderr', text: 'not ours' });
const ours = await call({ op: 'updateProgress', requestId: 'feed-test' });
check(
  'another installation’s events are ignored, phase and transcript alike',
  ours.phase === 'applying' && ours.log === 'Progress: resolved 1, reused 0\n',
  JSON.stringify({ phase: ours.phase, log: ours.log }),
);

// The tail is bounded: a noisy install must not grow the poll response forever.
emit('plugin-manager/install-log', { requestId: 'feed-test', stream: 'stdout', text: 'x'.repeat(9000) });
const long = await call({ op: 'updateProgress', requestId: 'feed-test' });
check(
  'a long transcript is kept as a bounded tail',
  long.log.length === 4000 && long.logTruncated === true,
  JSON.stringify({ length: long.log.length, truncated: long.logTruncated }),
);

emit('plugin-manager/install-log', { requestId: 'feed-test', stream: 'stdout', text: '', exitCode: 0 });
openGate();
installGate = null;
await settle();
const settledFeed = await call({ op: 'updateProgress', requestId: 'feed-test' });
check(
  'a finished job still answers with its result after the feed has stopped',
  settledFeed.done === true && settledFeed.result?.application === 'restart-required' && settledFeed.pnpmExit === 0,
  JSON.stringify({ done: settledFeed.done, application: settledFeed.result?.application, pnpmExit: settledFeed.pnpmExit }),
);

const blankVersion = await call({ op: 'updateApply' });
check(
  'a blank version is resolved from the registry',
  blankVersion.ok === true && installs.at(-1)?.spec === 'dsh-waifu-agents@9.9.9',
  JSON.stringify(blankVersion),
);
await settle();

globalThis.fetch = async () => {
  throw new Error('offline');
};
const offline = await call({ op: 'updateCheck' });
check(
  'an unreachable registry is reported, not thrown',
  offline.ok === true && typeof offline.error === 'string' && offline.updateAvailable === false,
  JSON.stringify(offline),
);
globalThis.fetch = realFetch;

console.log('--- op: refresh / unknown ---');
const refreshed = await call({ op: 'refresh' });
check('refresh reports ok', refreshed.ok === true);
const unknown = await call({ op: 'nope' });
check('unknown op refused', unknown.ok === false);
const notJson = await cmd.handler({ rawInput: 'not json at all' });
check('malformed request refused', notJson.kind === 'error');

console.log('--- the shared skeleton (assembly + validation) ---');
const skeletonPath = path.join(tmp, '_common.md');
const SKELETON_TEXT = '# [[name]] 的框架\n\n开头：你是「[[name]]」。\n\n[[body]]\n\n【通用条款】\n- 不许机械复读。\n';
fs.writeFileSync(skeletonPath, SKELETON_TEXT, 'utf8');
check('the package ships a skeleton of its own', fs.existsSync(path.join(HERE, 'personas', '_common.md')));
check(
  'and the shipped skeleton has exactly one body slot',
  fs.readFileSync(path.join(HERE, 'personas', '_common.md'), 'utf8').split('[[body]]').length - 1 === 1,
);
check(
  'and it contains no {{…}} the prompt renderer would reject',
  fs.readFileSync(path.join(HERE, 'personas', '_common.md'), 'utf8').includes('{{') === false,
);
const framed = await call({ op: 'create', id: 'framed', name: 'Framed', body: '她的性格段落。' });
check('a new persona opts into the skeleton on its own', framed.ok === true, JSON.stringify(framed));
const framedFile = fs.readFileSync(path.join(tmp, 'framed.md'), 'utf8');
check('the stored file keeps only her own part', framedFile.includes('她的性格段落。') && !framedFile.includes('通用条款'));
check('and records which skeleton she uses', framedFile.includes('template: _common.md'), JSON.stringify(framedFile.split('\n').slice(0, 8)));
check(
  'the registered prefix is the ASSEMBLED text',
  resolved('framed') ===
    '# Framed 的框架\n\n开头：你是「Framed」。\n\n她的性格段落。\n\n【通用条款】\n- 不许机械复读。\n',
  JSON.stringify(resolved('framed')),
);
const framedGet = await call({ op: 'get', id: 'framed' });
check(
  'get reports both counts (hers and the finished one)',
  framedGet.chars === '她的性格段落。'.length && framedGet.charsFull > framedGet.chars,
  JSON.stringify({ chars: framedGet.chars, charsFull: framedGet.charsFull }),
);
check('get hands back a revision token', typeof framedGet.rev === 'string' && framedGet.rev.length === 16, JSON.stringify(framedGet.rev));

console.log('--- the prompt renderer\'s variables are the only ones allowed ---');
const badVariable = await call({ op: 'create', id: 'badvar', name: 'Bad', body: '你是 {{char}}，我是 {{user}}。' });
check(
  'an unknown {{…}} is refused before anything is written',
  badVariable.ok === false && String(badVariable.error).includes('{{char}}'),
  JSON.stringify(badVariable),
);
check('and nothing landed on disk', !fs.existsSync(path.join(tmp, 'badvar.md')));
const goodVariable = await call({ op: 'create', id: 'goodvar', name: 'Good', body: '现在是 {{cwd}}，模型是 {{model}}。' });
check('the registered variables pass', goodVariable.ok === true, JSON.stringify(goodVariable));
const strayPlaceholder = await call({ op: 'create', id: 'stray', name: 'Stray', body: '这里有个 [[tone]] 占位符。' });
check(
  'an unsupported [[…]] placeholder is refused',
  strayPlaceholder.ok === false && String(strayPlaceholder.error).includes('[[tone]]'),
  JSON.stringify(strayPlaceholder),
);
const noSlot = await call({ op: 'create', id: 'noslot', name: 'NoSlot', body: '正文。' });
const brokenSkeleton = SKELETON_TEXT.replace('[[body]]', '');
fs.writeFileSync(skeletonPath, brokenSkeleton, 'utf8');
const brokenCreate = await call({ op: 'create', id: 'noslot2', name: 'NoSlot2', body: '正文。' });
check(
  'a skeleton without [[body]] refuses every new persona',
  brokenCreate.ok === false && String(brokenCreate.error).includes('[[body]]'),
  JSON.stringify(brokenCreate),
);
fs.writeFileSync(skeletonPath, SKELETON_TEXT, 'utf8');
check('the good skeleton still works afterwards', (await call({ op: 'get', id: 'framed' })).ok === true);

console.log('--- the shared skeleton, as an object ---');
const skeletonRead = await call({ op: 'skeleton' });
check(
  'skeleton reports its text, its slot count and a token',
  skeletonRead.ok === true && skeletonRead.present === true && skeletonRead.slots === 1 && typeof skeletonRead.rev === 'string',
  JSON.stringify({ slots: skeletonRead.slots, chars: skeletonRead.chars, present: skeletonRead.present }),
);
check('and hands over the raw text', skeletonRead.text.includes('[[body]]') && skeletonRead.text.includes('不许机械复读'));
const noSlotSave = await call({ op: 'setSkeleton', text: '完全没有插槽的骨架' });
check('saving a skeleton without [[body]] is refused', noSlotSave.ok === false, JSON.stringify(noSlotSave));
const twoSlotSave = await call({ op: 'setSkeleton', text: '[[body]] 和 [[body]]' });
check('saving a skeleton with two slots is refused', twoSlotSave.ok === false, JSON.stringify(twoSlotSave));
const badVariableSave = await call({ op: 'setSkeleton', text: '[[body]] 然后是 {{char}}' });
check(
  'saving a skeleton with an unknown {{…}} is refused',
  badVariableSave.ok === false && String(badVariableSave.error).includes('{{char}}'),
  JSON.stringify(badVariableSave),
);
const staleSkeleton = await call({ op: 'setSkeleton', text: '[[body]]\n', rev: 'a-token-from-before' });
check('a stale skeleton token is refused', staleSkeleton.ok === false && staleSkeleton.conflict === true, JSON.stringify(staleSkeleton));
const savedSkeleton = await call({ op: 'setSkeleton', text: '# [[name]]\n\n[[body]]\n\n尾巴。\n', rev: skeletonRead.rev });
check(
  'a good skeleton is written and everyone is re-registered',
  savedSkeleton.ok === true && Array.isArray(savedSkeleton.reloaded) && savedSkeleton.reloaded.includes('framed'),
  JSON.stringify(savedSkeleton),
);
check(
  'and the assembled text now carries the new frame',
  resolved('framed').includes('尾巴。') === true,
  JSON.stringify(resolved('framed')),
);
check('the previous skeleton was kept as .bak', fs.existsSync(path.join(tmp, '_common.md.bak')));
const skeletonBack = await call({ op: 'setSkeleton', text: SKELETON_TEXT });
check(
  'putting the original skeleton back re-registers again',
  skeletonBack.ok === true && resolved('framed').includes('通用条款') === true,
  JSON.stringify({ ok: skeletonBack.ok, reloaded: skeletonBack.reloaded }),
);

console.log('--- the optimistic lock ---');
const lockBefore = await call({ op: 'get', id: 'framed' });
const outsideEdit = fs
  .readFileSync(path.join(tmp, 'framed.md'), 'utf8')
  .replace('她的性格段落。', '她的性格段落（外部改过）。');
fs.writeFileSync(path.join(tmp, 'framed.md'), outsideEdit, 'utf8');
const staleSave = await call({ op: 'update', id: 'framed', name: 'Framed', body: '面板里那份旧草稿。', rev: lockBefore.rev });
check('a save built from stale text is refused', staleSave.ok === false && staleSave.conflict === true, JSON.stringify(staleSave));
check('and the outside edit survived it', fs.readFileSync(path.join(tmp, 'framed.md'), 'utf8').includes('外部改过'));
const freshGet = await call({ op: 'get', id: 'framed' });
const freshSave = await call({ op: 'update', id: 'framed', name: 'Framed', body: '合并之后的正文。', rev: freshGet.rev });
check(
  're-reading first lets the save through, and it returns the new token',
  freshSave.ok === true && typeof freshSave.rev === 'string' && freshSave.rev !== freshGet.rev,
  JSON.stringify(freshSave),
);
const blindSave = await call({ op: 'update', id: 'framed', name: 'Framed', body: '不带 token 的保存。' });
check('a caller that sends no token is still served (backwards compatible)', blindSave.ok === true, JSON.stringify(blindSave));

console.log('--- atomic writes leave a backup, never half a file ---');
check(
  'a .bak with the previous text exists',
  fs.existsSync(path.join(tmp, 'framed.md.bak')) && fs.readFileSync(path.join(tmp, 'framed.md.bak'), 'utf8').includes('合并之后的正文'),
);
check('no staging file was left behind', fs.readdirSync(tmp).every((entry) => !entry.includes('.stage-')));
const seenByScan = await call({ op: 'list' });
check(
  'and neither .bak nor .stage counts as a wife',
  seenByScan.files.every((file) => !file.id.includes('.bak') && !file.id.includes('.stage-')),
  JSON.stringify(seenByScan.files.map((file) => file.id)),
);
check('list no longer ships an absolute path', seenByScan.files.every((file) => !('file' in file)));
check(
  'list reports the group, the skeleton and two counts',
  seenByScan.files.every((file) => 'group' in file && 'template' in file && 'chars' in file && 'charsFull' in file && 'problems' in file),
);

console.log('--- refresh really re-registers an edited wife ---');
const beforeRefresh = resolved('framed');
const framedPath = path.join(tmp, 'framed.md');
fs.writeFileSync(framedPath, fs.readFileSync(framedPath, 'utf8').replace('不带 token 的保存。', '刷新之后应该出现这句。'), 'utf8');
const refreshedTwice = await call({ op: 'refresh' });
check(
  'refresh reports the reload',
  Array.isArray(refreshedTwice.reloaded) && refreshedTwice.reloaded.includes('framed'),
  JSON.stringify({ added: refreshedTwice.added, reloaded: refreshedTwice.reloaded }),
);
check(
  'and the registry now carries the new text',
  resolved('framed').includes('刷新之后应该出现这句。') === true &&
    resolved('framed') !== beforeRefresh,
);
const quietRefresh = await call({ op: 'refresh' });
check(
  'a second refresh has nothing to do',
  quietRefresh.reloaded.length === 0,
  JSON.stringify({ added: quietRefresh.added, reloaded: quietRefresh.reloaded }),
);

console.log('--- hide, restore, batch, search ---');
const hiddenBefore = await call({ op: 'hidden' });
check(
  'hidden lists the archives the earlier tests left behind',
  hiddenBefore.ok === true &&
    hiddenBefore.files.length >= 1 &&
    hiddenBefore.files.every((file) => /\.md\.off(\.\d+)?$/.test(file.archived)),
  JSON.stringify(hiddenBefore.files.map((file) => file.archived)),
);
check('a registered wife is not among them', hiddenBefore.files.every((file) => file.id !== 'framed'));
const hiddenOne = await call({ op: 'remove', id: 'framed' });
check('hiding archives the file', hiddenOne.ok === true && fs.existsSync(path.join(tmp, 'framed.md.off')));
const hiddenNow = await call({ op: 'hidden' });
const framedArchive = hiddenNow.files.find((file) => file.id === 'framed');
check(
  'the archive is listed, with its sequence',
  framedArchive !== undefined && framedArchive.archived === 'framed.md.off' && framedArchive.seq === 1,
  JSON.stringify(framedArchive),
);
check('a hidden wife is not registered', presets.has('framed') === false);
const restored = await call({ op: 'restore', archived: 'framed.md.off' });
check(
  'restoring puts her back under a free id',
  restored.ok === true && restored.id === 'framed' && fs.existsSync(path.join(tmp, 'framed.md')),
  JSON.stringify(restored),
);
check('and registers her again', presets.has('framed'));
const escaping = await call({ op: 'restore', archived: '..\\evil.md.off' });
check('restore only ever touches a name inside the directory', escaping.ok === false, JSON.stringify(escaping));
const notAnArchive = await call({ op: 'restore', archived: 'framed.md' });
check('restore refuses a name that is not an archive', notAnArchive.ok === false, JSON.stringify(notAnArchive));

const batched = await call({ op: 'batch', action: 'hide', ids: ['alpha', '後藤ひとり', 'nosuch'] });
check(
  'batch reports every item, including the failures',
  batched.ok === true && batched.results.length === 3 && batched.results.find((row) => row.key === 'nosuch')?.ok === false,
  JSON.stringify(batched.results),
);
check(
  'the ones that existed were hidden',
  batched.results.find((row) => row.key === 'alpha')?.ok === true && presets.has('alpha') === false,
  JSON.stringify(batched.results),
);
const regrouped = await call({ op: 'batch', action: 'group', ids: ['framed'], group: 'konosuba' });
check('batch group writes the group field', regrouped.ok === true && regrouped.results[0].ok === true, JSON.stringify(regrouped));
check('and get reads it back', (await call({ op: 'get', id: 'framed' })).group === 'konosuba');
const ungrouped = await call({ op: 'batch', action: 'group', ids: ['framed'], group: '' });
check('an empty group clears it again', ungrouped.ok === true && (await call({ op: 'get', id: 'framed' })).group === '');
const unknownBatch = await call({ op: 'batch', action: 'nope', ids: ['framed'] });
check('an unknown batch action is refused', unknownBatch.ok === false, JSON.stringify(unknownBatch));

const found = await call({ op: 'search', query: '刷新之后应该出现这句' });
check(
  'search finds the text the model would read',
  found.ok === true && found.hits.length === 1 && found.hits[0].id === 'framed' && found.hits[0].source === 'body',
  JSON.stringify(found.hits),
);
check('search returns a snippet, never the body', found.hits[0] !== undefined && !('body' in found.hits[0]), JSON.stringify(found.hits[0]));
const skeletonHit = await call({ op: 'search', query: '不许机械复读' });
check(
  'a hit inside the skeleton says so — even after the body slot',
  skeletonHit.hits.length >= 1 && skeletonHit.hits[0].source === 'skeleton',
  JSON.stringify(skeletonHit.hits.slice(0, 2)),
);
const nothing = await call({ op: 'search', query: '这串字在任何地方都不存在-9f3a' });
check('no match is an empty list, not an error', nothing.ok === true && nothing.hits.length === 0);

console.log('--- the pure helpers ---');
check('assemble fills [[name]] and keeps the body', assemble('X', 'B', 'a [[name]] b [[body]] c').text === 'a X b B c');
check('assemble reports a missing slot', assemble('X', 'B', 'no slot here').problems.length === 1);
check('assemble refuses a duplicated slot', assemble('X', 'B', '[[body]] and [[body]]').problems.length === 1);
check('assemble refuses a stray placeholder', assemble('X', 'B [[tone]]', null).problems.some((line) => line.includes('[[tone]]')));
check('assemble whitelists the prompt variables', assemble('X', '{{cwd}} ok, {{char}} not', null).problems.length === 1);
check('no skeleton means no assembly', assemble('X', 'plain', null).text === 'plain');
check(
  'revision is stable, short and content-addressed',
  revision('same') === revision('same') && revision('same').length === 16 && revision('same') !== revision('other'),
);
check('registrationRev follows the skeleton too', registrationRev({ text: 'A' }, 'b') !== registrationRev({ text: 'C' }, 'b'));
check(
  'templateProblem accepts only the shipped skeleton name',
  templateProblem({ template: '_common.md' }) === null && templateProblem({ template: 'other.md' }) !== null && templateProblem({}) === null,
);
check(
  'buildDefinition hands the row the placeholder, not the text',
  buildDefinition('q', { name: 'Q' }, 'BODY', [{ name: '@deepseek-ai/dsh-persona', config: {} }], { text: '[[name]]: [[body]]' })
    .plugins[0].config.prefix === PERSONA_PLACEHOLDER,
);
check(
  'and leaves every other row untouched',
  JSON.stringify(
    buildDefinition('q', { name: 'Q' }, 'BODY', [{ name: 'other', config: { a: 1 } }, { name: '@deepseek-ai/dsh-persona', config: { suffix: 's' } }], null)
      .plugins[0],
  ) === JSON.stringify({ name: 'other', config: { a: 1 } }),
);
check(
  'and carries group and template through renderPersona',
  renderPersona({ name: 'N', order: 1, description: 'd', group: 'g', template: '_common.md', body: 'b' }).includes('group: g') &&
    renderPersona({ name: 'N', order: 1, description: 'd', group: 'g', template: '_common.md', body: 'b' }).includes('template: _common.md'),
);
console.log('--- the session persona override ---');
check(
  'the persona row carries the placeholder',
  presets.get('framed')?.plugins?.[0]?.config?.prefix === PERSONA_PLACEHOLDER,
  JSON.stringify(presets.get('framed')?.plugins?.[0]?.config?.prefix),
);
check('the variable is registered under our name', [...variables.keys()].join(',') === 'waifu_persona');
// The sections above rewrite the scratch directory, so this one brings its own
// personas rather than borrowing a name that may already be gone.
fs.writeFileSync(path.join(tmp, 'ov-one.md'), '---\nname: OvOne\n---\n\n第一个覆盖用的正文。\n', 'utf8');
fs.writeFileSync(path.join(tmp, 'ov-two.md'), '---\nname: OvTwo\n---\n\n第二个覆盖用的正文。\n', 'utf8');
// A file is not a preset: register them before any roster-face assertion.
const ovScanned = await call({ op: 'refresh' });
check('the two new personas registered', ovScanned.ok === true && presets.has('ov-one') && presets.has('ov-two'));
check('and resolving an untouched session serves the mounted persona', resolved('ov-one').includes('第一个覆盖用的正文。'));

const overrideApplied = await call({ op: 'waifuApply', sessionId: 'stub-session', personaId: 'OvTwo' });
check(
  'waifuApply points the session at another persona',
  overrideApplied.ok === true && overrideApplied.id === 'ov-two',
  JSON.stringify(overrideApplied),
);
check('and the served text follows immediately', resolved('ov-one').includes('第二个覆盖用的正文。'), JSON.stringify(resolved('ov-one')));
check('another session is untouched', resolvedFor('fresh-session', 'ov-one').includes('第一个覆盖用的正文。'));

// The notice has to NAME the identity it replaces. A replaced system prompt is not
// the strongest identity signal in a request — the model's own earlier turns are,
// and a measured conversation had it keep answering as the persona it had already
// introduced itself as, three switches in a row. 「其它身份一律作废」 never says
// which words are wrong, so it dislodged nothing.
const afterSwitch = resolved('ov-one');
check(
  'the switch notice names the persona it replaced',
  afterSwitch.includes('「OvOne」') && afterSwitch.includes('全部作废'),
  JSON.stringify(afterSwitch.slice(0, 240)),
);
check(
  'and it still carries the new persona verbatim',
  afterSwitch.includes('第二个覆盖用的正文。'),
);

/*
 * The system prompt alone does not re-anchor a switch — measured, not assumed.
 * `session-b6fb8a2b` had three correct single-system-node requests (the newest
 * wife, `surfaceOp: replace`, no cache reuse) and the model still answered as the
 * FIRST wife every time, because its own earlier answers were the anchor. So the
 * identity also rides a `systemPrompt.context()` contribution, which the loop
 * projects into the surface as a USER-role snapshot AFTER the user's message.
 */
check(
  'the identity snapshot channel is registered with a finite order',
  contexts.size === 1 &&
    [...contexts.keys()][0] === 'waifu-agents:identity' &&
    Number.isFinite([...contexts.values()][0].order),
  JSON.stringify([...contexts.keys()]),
);
const switchedSnapshot = identityFor('stub-session', 'ov-one');
check(
  'a switched session gets a runtime snapshot naming the new persona',
  switchedSnapshot.includes('「OvTwo」') && switchedSnapshot.includes('运行时确认'),
  JSON.stringify(switchedSnapshot),
);
check(
  'the snapshot is served alongside the persona, not instead of it',
  switchedSnapshot.includes('「OvTwo」') && resolved('ov-one').includes('第二个覆盖用的正文。'),
);
// The gate that keeps this feature invisible to sessions nobody switched: an
// untouched session must render NOTHING here, or its request would gain a user
// message it never had.
check(
  'a session that was never switched renders no snapshot at all',
  identityFor('fresh-session', 'ov-one') === '' && identityFor('', 'ov-one') === '',
  JSON.stringify(identityFor('fresh-session', 'ov-one')),
);

// An earlier section switches the roster face off to test the "no default"
// path; put it back, or this section measures the wrong thing.
flaglessOnly = false;
defaultId = 'ov-one';
const state = await call({ op: 'waifuState', sessionId: 'stub-session', mountedId: 'ov-one' });
check(
  'waifuState reports the override and the active row',
  state.ok === true && state.override === 'ov-two' && state.active === 'ov-two',
  JSON.stringify(state),
);
check(
  'and it hands the picker the roster with the default marked',
  state.rows.some((row) => row.id === 'ov-one' && row.isDefault === true),
  JSON.stringify({ defaultId: state.defaultId, source: state.source, rows: state.rows.map((row) => `${row.id}:${row.isDefault}`) }),
);
check(
  'an illegal id never reaches the picker',
  state.rows.every((row) => row.id !== 'Bad Name'),
  JSON.stringify(state.rows.map((row) => row.id)),
);
check('the global default is only the third rung', resolvedFor('fresh-session', 'a-preset-that-no-longer-exists').includes('第一个覆盖用的正文。'));

const cleared = await call({ op: 'waifuClear', sessionId: 'stub-session' });
check('waifuClear drops the override', cleared.ok === true && cleared.had === 'ov-two', JSON.stringify(cleared));
check('and the mounted persona takes over again', resolved('ov-one').includes('第一个覆盖用的正文。'));
// Clearing the override has to clear the snapshot too. The loop turns an empty
// snapshot into its own 「earlier runtime-context snapshots no longer apply」
// message, so a stale identity here would outlive the switch it described.
check(
  'resetting a session retires its identity snapshot',
  identityFor('stub-session', 'ov-one') === '',
  JSON.stringify(identityFor('stub-session', 'ov-one')),
);

const textBefore = resolved('ov-one');
fs.writeFileSync(path.join(tmp, 'ov-broken.md'), '---\nname: OvBroken\n---\n\n这里有 {{char}}，渲染会炸。\n', 'utf8');
const brokenApply = await call({ op: 'waifuApply', sessionId: 'stub-session', personaId: 'ov-broken' });
check('a persona whose text would break the prompt is refused', brokenApply.ok === false, JSON.stringify(brokenApply));
check('and the refusal left the served text alone', resolved('ov-one') === textBefore);
const refused = await call({ op: 'waifuApply', sessionId: 'stub-session', personaId: 'no-such-persona' });
check('an unknown name is refused with candidates, never guessed', refused.ok === false && Array.isArray(refused.candidates), JSON.stringify(refused));

const roster = [
  { id: 'alpha', name: 'Alpha' },
  { id: 'alpha-two', name: 'Alpha Two' },
  { id: 'framed', name: 'Framed' },
];
check('matchPersona takes an exact id', matchPersona('alpha', roster).ok === true && matchPersona('alpha', roster).id === 'alpha');
check('matchPersona takes a display name, @ included', matchPersona('@Framed', roster).ok === true);
check('matchPersona takes a unique prefix', matchPersona('frame', roster).ok === true && matchPersona('frame', roster).id === 'framed');
const ambiguous = matchPersona('al', roster);
check('an ambiguous prefix lists the candidates', ambiguous.ok === false && ambiguous.candidates.length === 2, JSON.stringify(ambiguous));
check('a missing name lists everything', matchPersona('nobody', roster).ok === false && matchPersona('nobody', roster).candidates.length === 3);
check('an empty query is refused', matchPersona('   ', roster).ok === false);

const rungs = orderPersonaIds({ overrideId: 'a', mountedId: 'a', defaultId: 'b' });
check('the ladder dedupes and orders override -> mounted -> default', rungs.join(',') === 'a,b', JSON.stringify(rungs));
check('and drops empties', orderPersonaIds({ overrideId: null, mountedId: '', defaultId: 'b' }).join(',') === 'b');
check(
  'the three commands are registered',
  commands.has('waifu-change') && commands.has('waifu-current') && commands.has('waifu-reset'),
  JSON.stringify([...commands.keys()]),
);
{
  const before = commands.get('waifu-current');
  const answer = await before.handler({ agent: { session: { id: 'stub-session', header: { agentPreset: 'ov-one' } } } });
  check(
    'waifu-current answers in exactly one line, with no contradicting second row',
    answer.kind === 'success' && answer.text.startsWith('本会话人设：') && answer.text.split('\n').length === 1,
    answer.text,
  );
}
{
  const purged = await call({ op: 'purge' });
  check('purge is a known op', !String(purged?.error ?? '').includes('未知的 op'), JSON.stringify(purged).slice(0, 200));
}
{
  const reset = await commands.get('waifu-reset').handler({ agent: { session: { id: 'stub-session', header: { agentPreset: 'ov-one' } } } });
  check('waifu-reset on a clean session says so', reset.kind === 'success');
}
{
  const change = await commands.get('waifu-change').handler({
    agent: { session: { id: 'stub-session', header: { agentPreset: 'ov-one' } } },
    rawInput: '',
  });
  check('waifu-change without a name lists what there is', change.kind === 'error' && change.text.includes('选择器'), change.text);
}

console.log('--- the session chip follows a switch ---');
/*
 * The chip above a conversation renders `projectionValues.agentPreset`, advanced
 * by exactly one event type, `agent-preset/selected`, which the platform writes
 * from its own `select()`. That call is refused for a session that has already
 * opened a turn (`agent-preset/locked`) because it would remount the whole
 * preset tree — so a switched running session kept naming the wife it was BORN
 * with. Appending the event alone moves the label and nothing else.
 */
{
  const appended = [];
  const session = {
    id: 'stub-session',
    header: { agentPreset: 'ov-one' },
    append: (type, data) => appended.push({ type, data }),
  };
  const switched = await commands.get('waifu-change').handler({
    agent: { session },
    rawInput: 'ov-two',
  });
  check(
    'a switch names the new persona on the session itself',
    switched.kind === 'success' &&
      appended.length === 1 &&
      appended[0].type === 'agent-preset/selected' &&
      appended[0].data?.agentPreset === 'ov-two',
    JSON.stringify({ switched, appended }),
  );
  /*
   * Only a REGISTERED preset may be named: the value persists, and a restored
   * session mounts what its projection names — so an id nobody serves would turn
   * the next resume into a failed restore.
   */
  appended.length = 0;
  const reset = await commands.get('waifu-reset').handler({ agent: { session } });
  check(
    'a reset puts the label back on what the session mounts',
    reset.kind === 'success' &&
      appended.length === 1 &&
      appended[0].data?.agentPreset === 'ov-one',
    JSON.stringify({ reset, appended }),
  );
}

console.log('--- drag to reorder ---');
check('reorderIds moves one id in front of another', reorderIds(['a', 'b', 'c'], 'c', 'a').join(',') === 'c,a,b');
check('and moving it backwards works the same way', reorderIds(['a', 'b', 'c'], 'a', 'c').join(',') === 'b,a,c');
check('a no-op move reports nothing to do', reorderIds(['a', 'b'], 'a', 'a') === null && reorderIds(['a'], 'a', 'zzz') === null);
check('the sequence is never longer or shorter', reorderIds(['a', 'b', 'c', 'd'], 'd', 'b').length === 4);

const orderBefore = new Map(
  ['ov-one', 'ov-two'].map((id) => [id, fs.readFileSync(path.join(tmp, `${id}.md`), 'utf8')]),
);
const ordered = await call({ op: 'waifuOrder', ids: ['ov-two', 'ov-one'] });
check('waifuOrder rewrote the files', ordered.ok === true && ordered.changed.length >= 1, JSON.stringify(ordered));
const ovOne = fs.readFileSync(path.join(tmp, 'ov-one.md'), 'utf8');
const ovTwo = fs.readFileSync(path.join(tmp, 'ov-two.md'), 'utf8');
check('ov-two is now first', /order:\s*1\b/.test(ovTwo), ovTwo.split('\n').slice(0, 6).join(' | '));
check('ov-one is now second', /order:\s*2\b/.test(ovOne), ovOne.split('\n').slice(0, 6).join(' | '));
check(
  'and the bodies were not touched',
  ovOne.slice(ovOne.indexOf('---', 3)) === orderBefore.get('ov-one').slice(orderBefore.get('ov-one').indexOf('---', 3)) &&
    ovTwo.slice(ovTwo.indexOf('---', 3)) === orderBefore.get('ov-two').slice(orderBefore.get('ov-two').indexOf('---', 3)),
);
check('an unknown id is refused', (await call({ op: 'waifuOrder', ids: ['nope'] })).ok === false);
check('a duplicated id is refused', (await call({ op: 'waifuOrder', ids: ['ov-one', 'ov-one'] })).ok === false);
check(
  'a reused order is a no-op, not a rewrite',
  (await call({ op: 'waifuOrder', ids: ['ov-two', 'ov-one'] })).changed.length === 0,
);

console.log('--- the client half, statically ---');
const clientSource = fs.readFileSync(path.join(HERE, 'client.js'), 'utf8');
const dictKeys = (locale) => {
  const start = clientSource.indexOf(`      ${locale}: {`);
  if (start < 0) return null;
  const end = clientSource.indexOf('\n      },', start);
  const body = clientSource.slice(start, end < 0 ? undefined : end);
  return [...body.matchAll(/^        ([A-Za-z0-9_]+):/gm)].map((match) => match[1]);
};
const zhKeys = dictKeys('zh');
const enKeys = dictKeys('en');
check('both dictionaries were found', Array.isArray(zhKeys) && Array.isArray(enKeys) && zhKeys.length > 40, `${zhKeys?.length}/${enKeys?.length}`);
const onlyZh = zhKeys.filter((key) => !enKeys.includes(key));
const onlyEn = enKeys.filter((key) => !zhKeys.includes(key));
check('zh and en carry exactly the same keys', onlyZh.length === 0 && onlyEn.length === 0, JSON.stringify({ onlyZh, onlyEn }));
check(
  'no key is duplicated inside one dictionary',
  new Set(zhKeys).size === zhKeys.length && new Set(enKeys).size === enKeys.length,
);

const used = new Set(
  [...clientSource.matchAll(/\b(?:t|tr)\('([A-Za-z0-9_]+)'\)/g)].map((match) => match[1]),
);
const missing = [...used].filter((key) => !zhKeys.includes(key));
check('every t()/tr() key is defined', missing.length === 0, JSON.stringify(missing));
check('and the dictionary is not dead weight', used.size > 30, String(used.size));

// The frozen platform module table, quoted from the runtime: a client half may
// require these and nothing else.
const SEED_WORDS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-store',
  '@deepseek-ai/cordis',
]);
const required = ["require('react')", "__ModuleLoader__.load"];
check(
  'the client half only imports platform seed words',
  required.every((needle) => clientSource.includes(needle)) &&
    [...clientSource.matchAll(/require\('([^']+)'\)/g)].every((match) => SEED_WORDS.has(match[1])),
  JSON.stringify([...clientSource.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1])),
);
check(
    'hiding and updating ask through the platform dialog, not a double click',
    clientSource.includes('RiskConfirmation') &&
      clientSource.includes("kind: 'hide'") &&
      clientSource.includes("kind: 'update'") &&
      !clientSource.includes('confirmHide') &&
      !clientSource.includes('updateConfirm'),
  );

/*
 * The style-merge invariant that keeps the default highlight honest.
 *
 * A row is drawn as `{ ...L.item, ...(isDefault ? L.itemDefault : null) }`, and
 * React drops a style it no longer receives by writing `style[name] = ''`. That
 * removal does NOT work for a property that lives inside a shorthand: clearing
 * `borderColor` leaves `border: 1px solid …` re-applying the colour, and a
 * border whose colour was cleared falls back to `currentColor` — which in this
 * theme is the same near-white as the brand colour. So a row that stopped being
 * the default still LOOKED like one, and only a remount cleared it:
 * 「多次切换默认人设后，选中过的 border 样式存在残留，再次进入就消失了」.
 *
 * Declaring the resting value in the base object makes React always SET the
 * property instead of removing it. That is pinned for every conditional pair,
 * because the symptom only appears after a second switch — long after review.
 */
const styleLiteral = (() => {
  const start = clientSource.indexOf('const L = {');
  if (start < 0) return null;
  const open = clientSource.indexOf('{', start);
  const close = clientSource.indexOf('\n    };', open);
  return close < 0 ? null : clientSource.slice(open, close + 6);
})();
let styleTable = null;
try {
  styleTable = styleLiteral === null ? null : new Function(`return ${styleLiteral}`)();
} catch {
  styleTable = null;
}
check(
  'the client style table could be read',
  styleTable !== null && typeof styleTable.item === 'object',
  String(styleLiteral?.length),
);
const CONDITIONAL_PAIRS = [
  ['item', 'itemDefault'],
  ['item', 'dropTarget'],
  ['item', 'dragging'],
  ['item', 'reorderRow'],
  ['switch', 'switchOn'],
  ['thumb', 'thumbOn'],
  ['segItem', 'segActive'],
  ['tabBtn', 'tabActive'],
  ['progressFill', 'progressFillDone'],
  ['progressFill', 'progressFillFailed'],
];
const undeclared = [];
for (const [base, variant] of CONDITIONAL_PAIRS) {
  if (styleTable?.[base] === undefined || styleTable?.[variant] === undefined) {
    undeclared.push(`${base}/${variant}: not found`);
    continue;
  }
  for (const key of Object.keys(styleTable[variant])) {
    if (!(key in styleTable[base]))
      undeclared.push(`${base} is missing "${key}" (${variant} sets it)`);
  }
}
check(
  'every conditional style declares its keys in the base object',
  undeclared.length === 0,
  JSON.stringify(undeclared),
);
/*
 * The three that used to be removed rather than set. Named explicitly so a
 * future edit that "simplifies" the base object fails here by name.
 */
check(
  'and the border colour is declared instead of removed',
  styleTable?.item?.borderColor === 'var(--dsw-alias-border-l1)' &&
    styleTable?.item?.borderStyle === 'solid' &&
    styleTable?.switch?.borderColor === 'var(--dsw-alias-border-l2)' &&
    styleTable?.thumb?.transform === 'translateX(0)',
  JSON.stringify({
    itemBorderColor: styleTable?.item?.borderColor,
    itemBorderStyle: styleTable?.item?.borderStyle,
    switchBorderColor: styleTable?.switch?.borderColor,
    thumbTransform: styleTable?.thumb?.transform,
  }),
);
check('the panel keeps its slot and its route', clientSource.includes("const SLOT = 'settings.plugins.tab'") && clientSource.includes("const ROUTE = '/waifu-agents/api'"));
/*
 * The progress window's load-bearing pieces, pinned by name because each is a
 * decision rather than an implementation detail:
 *
 *   • the request id is minted by the PANEL, before the launch goes out, so a
 *     progress chunk that beats the launch response still has a job to land in
 *     (a Host-minted id would drop exactly those first chunks);
 *   • the confirm click starts the install and does NOT dismiss the window —
 *     that dismissal is the reported bug in its original form;
 *   • the window polls, because the launch request deliberately returns before
 *     the install finishes.
 */
check(
  'the update window is opened by the click, not dismissed by it',
  clientSource.includes("open: dialog !== null && dialog.kind === 'update' && job === null") &&
    clientSource.includes('await startUpdate();') &&
    clientSource.includes('h(ProgressWindow, {'),
  'the update dialog still closes itself on confirm',
);
check(
  'the panel mints the request id the progress feed is keyed on',
  (() => {
    const at = clientSource.indexOf("op: 'updateApply'");
    return (
      clientSource.includes('const requestId = newRequestId();') &&
      clientSource.includes("typeof crypto.randomUUID === 'function'") &&
      at !== -1 &&
      clientSource.slice(at, at + 240).includes('requestId,')
    );
  })(),
  'the launch does not carry a panel-minted id',
);
check(
  'and the window polls the Host instead of blocking on the install',
  clientSource.includes("op: 'updateProgress'") &&
    clientSource.includes('const UPDATE_POLL_MS = 400;') &&
    clientSource.includes('window.setInterval(poll, UPDATE_POLL_MS)'),
  'the progress window does not poll',
);
check(
  'a dismissed window leaves the outcome on the roster',
  clientSource.includes('function updateStripText(') &&
    clientSource.includes('updateStripRunning') &&
    clientSource.includes('updateStripDone'),
  'the roster strip is not wired to the job',
);
check(
  'every progress message exists in both dictionaries',
  [
    'updateProgressTitle',
    'updatePreparing',
    'updateInstallingPlain',
    'updateInstallingFrom',
    'updateApplying',
    'updateCancelling',
    'updateWaiting',
    'updateElapsed',
    'updateQuiet',
    'updateLogTitle',
    'updateLogShow',
    'updateLogHide',
    'updateLogTail',
    'updateExitCode',
    'updateDoneTitle',
    'updateDoneRestart',
    'updateDoneApplied',
    'updateDoneCurrent',
    'updateDoneNoChange',
    'updateFailedTitle',
    'updateRetry',
    'updateClose',
    'updateStripRunning',
    'updateStripDone',
    'updateStripFailed',
  ].filter((key) => clientSource.split(`${key}:`).length - 1 !== 2),
  'a progress message is missing from one of the two dictionaries',
);
/*
 * The panel is where the user decides whether the click worked, so a degraded
 * write has to be visible HERE and not only in the log. When the `settings`
 * service is out of reach `writeDefault` falls back to `configEditor.edit()`,
 * which lands the same bytes and wakes nobody — the panel would report the
 * default moved while the new-task chip kept naming the previous wife, which is
 * the exact report this op exists to answer. The other two notes are the
 * mirror image: what could not be confirmed, and the half that used to be
 * missing (the session already on screen being re-seated).
 */
check(
  'a default write reports how it landed, in the panel',
  clientSource.includes("answer.via === 'configEditor'") &&
    clientSource.includes("t('defaultViaEditor')") &&
    clientSource.includes("t('defaultUnchecked')") &&
    clientSource.includes("t('defaultReseated')"),
  'the via / checkable / resettled feedback is not wired',
);
check(
  'the persona picker and the @ source are both wired',
  clientSource.includes('commandUi.decorate') && clientSource.includes('registerSource'),
);
check(
  'every icon the panel asks for is in the bridge table',
  (() => {
    const table = new Set(
      [...clientSource.matchAll(/^      ([a-zA-Z]+): 'Icon[A-Za-z]+Regular',/gm)].map((match) => match[1]),
    );
    // Only the names inside an `h(Icon, {…})` call: `name:` is used for other
    // things too (the @ source is named `persona`), and a false positive here
    // would mean nothing.
    const asked = new Set(
      [...clientSource.matchAll(/h\(Icon, \{[\s\S]{0,160}?\}\)/g)].flatMap((call) =>
        [...call[0].matchAll(/'([a-zA-Z]+)'/g)].map((match) => match[1]),
      ),
    );
    const absent = [...asked].filter((name) => !table.has(name));
    return asked.size > 4 && absent.length === 0;
  })(),
  JSON.stringify([...new Set([...clientSource.matchAll(/name: '([a-zA-Z]+)'/g)].map((match) => match[1]))]),
);

console.log('--- the row config schema ---');
/*
 * Every switch the panel and the docs offer has to exist on the schema, or the
 * profile cannot set it and the documented escape hatch is a dead end.
 */
const configKeys = Object.keys(Config?.dict ?? {});
check(
  'the schema declares every channel the docs promise',
  ['dir', 'template', 'registry', 'switchNotice', 'identityReminder', 'syncSessionChip'].every(
    (key) => configKeys.includes(key),
  ),
  JSON.stringify(configKeys),
);

console.log('--- logs ---');
check('logged its scan', logs.some((line) => line.includes('dsh-waifu-agents:')));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
