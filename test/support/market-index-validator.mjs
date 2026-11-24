/**
 * 插件市场索引 format:1 校验器 —— **宿主真实校验器的镜像**，给 `test/protocol/packaging.test.mjs`
 * 用，让发布门禁与宿主的判定等价。
 *
 * 为什么要有这份副本：CI 里没有宿主包 `@deepseek-ai/dsh-plugin-market-index`（它只随
 * DSH 桌面版分发在 `app.asar` 里），也没有 `semver` 依赖，而门禁必须离线可跑。所以这里
 * 把宿主的判定逐条手写一遍；**它不是"我觉得应该这样"的规则**，每一条都照
 * `@deepseek-ai/dsh-plugin-market-index@0.2.2-rc.5` 的 `src/index.ts` 抄下来：
 *
 *   - `format` 必须严格等于数字 `1`（`'1'` 也不行）；
 *   - 语言 id `/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u`，本地化对象必须含 `en`；
 *   - 插件名要过 npm 包名规则，且 `name` 在全表唯一（`duplicates <name>`）；
 *   - 版本必须是**精确 SemVer**，同一插件内 `version` 唯一；
 *   - `publishTimestamp` 必须是 `[0, 1e11)` 内的整数秒；
 *   - `source.type` 只能是 `npm` / `git`；`git` 必须有 `url`（https 绝对地址、≥2 段路径、
 *     不是 tarball）与 `commit`（小写 40 位 hex）；`npm` 的 `registry` 可选；
 *   - `engines` **可选**；给了 `dsh` 就必须是 SemVer 范围且不是 `workspace:` 范围。
 *
 * 与宿主的已知差异（刻意、且只往"更严"的方向偏，绝不放松）：
 *   1. `semver.validRange()` 在无依赖环境下用 `isSemverRange()` 近似；它覆盖 npm 范围
 *      语法的常见形态（`||` 组、空格分隔的比较符组、`-` 连字符范围、`^`/`~`/`~>`、
 *      `x`/`*`），遇到解析不了的写法会**拒**而不是放过。
 *   2. 宿主返回"校验后的索引"（并对 versions 做降序重排）；这里只做校验并原样返回入参，
 *      门禁只需要"拒绝还是接受"。
 *
 * 演变与依据：宿主 `0.2.2-rc.5`（本机 `D:\tools\dsh\resources\app.asar` 实测；早期文档
 * 里写的 rc.2 是过期值）。宿主升级后这里必须跟着复核——`test/protocol/packaging.test.mjs`
 * 里有变异矩阵，宿主行为再漂移就会被重新测出来。
 */

/** 索引违反 format:1；`path` 是出错值的 JSON 路径（如 `$.plugins[0].versions[1].version`）。 */
export class MarketIndexError extends Error {
  /**
   * @param {string} path JSON 路径
   * @param {string} reason 被违反的规则
   */
  constructor(path, reason) {
    super(`${path} ${reason}`);
    this.name = 'MarketIndexError';
    this.path = path;
    this.reason = reason;
  }
}

const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const PACKAGE_NAME_MAX_LENGTH = 214;
/** SemVer 2.0.0 语法里的一个数字标识：不许有前导零。 */
const NUMERIC = '(?:0|[1-9]\\d*)';
/** 预发布标识：数字标识不许有前导零；含字母/连字符的标识随便（SemVer §9）。 */
const PRERELEASE_PART = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
/** 与宿主逐字相同的 `SEMVER`：一个精确版本。 */
export const EXACT_SEMVER = new RegExp(
  `^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`,
  'u',
);
const COMMIT = /^[0-9a-f]{40}$/u;
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/u;
const DATA_ICON = /^data:(?:image\/svg\+xml|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
/** 内联 `data:` 图标的解码后上限，字节。 */
export const MAX_INLINE_ICON_BYTES = 32 * 1024;
const MAX_PUBLISH_TIMESTAMP = 1e11;
const LANGUAGE_RULE = 'must be keyed by a lowercase language id';

function fail(path, reason) {
  throw new MarketIndexError(path, reason);
}

function objectAt(value, path) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object');
  return value;
}

function stringAt(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a string with a non-whitespace character');
  return value;
}

function optional(object, key, path, read) {
  return Object.hasOwn(object, key) ? read(object[key], `${path}.${key}`) : undefined;
}

/** `__proto__` 之类的 id 也要当成普通键，所以用 defineProperty 而不是赋值。 */
function own(record, key, value) {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

/** 宿主 `localizedText()` 的镜像：纯字符串，或 `{ 语言键: 字符串 }` 且必须含 `en`。 */
export function localizedText(value, path) {
  if (typeof value === 'string') return stringAt(value, path);
  const object = objectAt(value, path);
  const text = {};
  for (const [language, member] of Object.entries(object)) {
    if (!LANGUAGE_ID.test(language)) fail(`${path}.${language}`, LANGUAGE_RULE);
    own(text, language, stringAt(member, `${path}.${language}`));
  }
  if (!Object.hasOwn(text, 'en')) fail(path, 'must contain en');
  return text;
}

function declarations(value, path, read) {
  const result = {};
  for (const [id, member] of Object.entries(objectAt(value, path))) {
    if (id === '') fail(path, 'must not declare an empty id');
    own(result, id, read(objectAt(member, `${path}.${id}`), `${path}.${id}`));
  }
  return result;
}

function declaration(object, path) {
  return { title: localizedText(object.title, `${path}.title`) };
}

function sortKeyDeclaration(object, path) {
  if (object.order !== 'asc' && object.order !== 'desc') fail(`${path}.order`, 'must be "asc" or "desc"');
  return { title: localizedText(object.title, `${path}.title`), order: object.order };
}

function indexMetadata(value, path) {
  const object = value === undefined ? {} : objectAt(value, path);
  return {
    categories: optional(object, 'categories', path, (member, at) => declarations(member, at, declaration)) ?? {},
    labels: optional(object, 'labels', path, (member, at) => declarations(member, at, declaration)) ?? {},
    sortKeys: optional(object, 'sortKeys', path, (member, at) => declarations(member, at, sortKeyDeclaration)) ?? {},
  };
}

function declaredId(value, path, declared) {
  const id = stringAt(value, path);
  if (!Object.hasOwn(declared, id)) fail(path, `references undeclared id ${JSON.stringify(id)}`);
  return id;
}

function pluginMetadata(value, path, index) {
  const object = value === undefined || value === null ? {} : objectAt(value, path);
  const field = (key, read) => (object[key] === null ? undefined : optional(object, key, path, read));
  const category = field('category', (member, at) => declaredId(member, at, index.categories));
  const keywords = field('keywords', (member, at) => {
    if (!Array.isArray(member)) fail(at, 'must be an array');
    return member.map((keyword, position) => {
      if (typeof keyword !== 'string') fail(`${at}[${String(position)}]`, 'must be a string');
      return keyword;
    });
  }) ?? [];
  const labels = field('labels', (member, at) => {
    if (!Array.isArray(member)) fail(at, 'must be an array');
    const ids = member.map((label, position) => declaredId(label, `${at}[${String(position)}]`, index.labels));
    if (new Set(ids).size !== ids.length) fail(at, 'must not repeat a label');
    return ids;
  }) ?? [];
  const sortKeys = field('sortKeys', (member, at) => {
    const values = {};
    for (const [id, sortValue] of Object.entries(objectAt(member, at))) {
      declaredId(id, `${at}.${id}`, index.sortKeys);
      if (sortValue === null) continue;
      if (typeof sortValue !== 'number' || !Number.isFinite(sortValue)) fail(`${at}.${id}`, 'must be a finite number');
      own(values, id, sortValue);
    }
    return values;
  }) ?? {};
  return { ...category === undefined ? {} : { category }, keywords, labels, sortKeys };
}

function httpUrl(value, path, protocols) {
  const text = stringAt(value, path);
  let url;
  try {
    url = new URL(text);
  } catch {
    fail(path, 'must be an absolute URL');
  }
  if (!protocols.includes(url.protocol)) fail(path, `must use ${protocols.join(' or ')}`);
  if (url.username !== '' || url.password !== '') fail(path, 'must not contain credentials');
  if (url.href.includes('?') || url.href.includes('#')) fail(path, 'must not contain a query or fragment');
  return url;
}

/** 绝对 http(s) URL；npm 的 `homepage` 常带 `#readme`，所以这里放行 query / fragment。 */
function homepageUrl(value, path) {
  const text = stringAt(value, path);
  if (!URL.canParse(text)) fail(path, 'must be an absolute URL');
  const url = new URL(text);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(path, 'must use https: or http:');
  return url.href;
}

function gitUrl(value, path) {
  const url = httpUrl(value, path, ['https:']);
  if (url.href !== value) fail(path, 'must be a canonical URL');
  if (!/^(?:\/[^/]+){2,}$/u.test(url.pathname)) fail(path, 'must name a repository with at least two path segments');
  if (/\.(?:tgz|tar\.gz)$/iu.test(url.pathname)) fail(path, 'must name a repository, not a tarball');
  return url.href;
}

function packagePath(value, path) {
  const text = stringAt(value, path);
  const segments = text.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment))) {
    fail(path, 'must be a relative directory of letters, digits, and ._@+- segments without . or ..');
  }
  return text;
}

function repository(value, path) {
  const object = objectAt(value, path);
  const url = httpUrl(object.url, `${path}.url`, ['https:', 'http:']).href;
  const directory = optional(object, 'directory', path, packagePath);
  return { url, ...directory === undefined ? {} : { directory } };
}

/** `source` 的镜像：**必填字段就在这里**（删掉 `url` / `commit` 必须红）。 */
function source(value, path) {
  const object = objectAt(value, path);
  switch (object.type) {
    case 'npm': {
      const registry = optional(object, 'registry', path, (member, at) => httpUrl(member, at, ['https:', 'http:']).href);
      return { type: 'npm', ...registry === undefined ? {} : { registry } };
    }
    case 'git': {
      const commit = stringAt(object.commit, `${path}.commit`);
      if (!COMMIT.test(commit)) fail(`${path}.commit`, 'must be a lowercase 40-hex-digit commit SHA');
      const packageDir = optional(object, 'path', path, packagePath);
      return { type: 'git', url: gitUrl(object.url, `${path}.url`), commit, ...packageDir === undefined ? {} : { path: packageDir } };
    }
    default:
      return fail(`${path}.type`, 'must be "npm" or "git"');
  }
}

/**
 * 无依赖的 SemVer 范围校验（近似 `semver.validRange`）。
 *
 * 覆盖：`||` 分隔的可选组、空格分隔的比较符集合、`>= > <= < = ^ ~ ~>`、`x`/`X`/`*`、
 * 连字符范围 `a - b`、部分版本（`1`、`1.2`、`1.2.x`）。解析不了就返回 false（拒），
 * 因为门禁宁可拦下需要人工确认的写法，也不能把非法范围当成合法。
 * @param {unknown} range
 * @returns {boolean}
 */
export function isSemverRange(range) {
  if (typeof range !== 'string') return false;
  const text = range.trim();
  if (text === '' || text.startsWith('workspace:')) return false;
  return text.split('||').every((group) => comparatorGroup(group.trim()));
}

const PARTIAL = `(?:${NUMERIC}|x|X|\\*)`;
const VERSIONISH = `${PARTIAL}(?:\\.${PARTIAL}(?:\\.${PARTIAL}(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+)?)?)?`;
const OPERATOR = '(?:~>|~|\\^|>=|<=|>|<|=)?';
const COMPARATOR = new RegExp(`^${OPERATOR}v?${VERSIONISH}$`, 'u');
const OPERATOR_ONLY = /^(?:~>|~|\^|>=|<=|>|<|=)$/u;
const HYPHEN_RANGE = new RegExp(`^v?${VERSIONISH}\\s+-\\s+v?${VERSIONISH}$`, 'u');
const WILDCARD = /^(?:x|X|\*)$/u;

function comparatorGroup(group) {
  if (group === '') return false;
  if (WILDCARD.test(group) || HYPHEN_RANGE.test(group)) return true;
  const tokens = group.split(/\s+/u).filter((token) => token !== '');
  // `>= 1.2.3` 这种"操作符和版本分开写"的写法要把两个 token 合起来看。
  const merged = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (OPERATOR_ONLY.test(token)) {
      const next = tokens[index + 1];
      if (next === undefined) return false;
      merged.push(token + next);
      index += 1;
    } else {
      merged.push(token);
    }
  }
  return merged.length > 0 && merged.every((token) => WILDCARD.test(token) || COMPARATOR.test(token));
}

function engines(value, path) {
  const object = objectAt(value, path);
  const dsh = optional(object, 'dsh', path, (member, at) => {
    const range = stringAt(member, at);
    if (range.startsWith('workspace:')) fail(at, 'must not be a workspace: range');
    if (!isSemverRange(range)) fail(at, 'must be a SemVer range');
    return range;
  });
  return dsh === undefined ? {} : { dsh };
}

function icon(value, path, indexUrl) {
  const text = stringAt(value, path);
  if (text.startsWith('data:')) {
    const match = DATA_ICON.exec(text);
    const payload = match?.[1];
    if (payload === undefined || payload === '' || !BASE64.test(payload)) fail(path, 'must be a base64 SVG, PNG, JPEG, or WebP data URL');
    const bytes = (payload.length / 4) * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
    if (bytes > MAX_INLINE_ICON_BYTES) fail(path, `must not exceed ${String(MAX_INLINE_ICON_BYTES / 1024)} KiB of decoded bytes`);
    return text;
  }
  let resolved;
  try {
    resolved = new URL(text, indexUrl);
  } catch {
    fail(path, 'must be a URL reference');
  }
  if (resolved.protocol !== 'https:' && (resolved.origin === 'null' || resolved.origin !== indexUrl.origin)) {
    fail(path, 'must resolve to https or the index origin');
  }
  return resolved.href;
}

function marketVersion(value, path) {
  const object = objectAt(value, path);
  const version = stringAt(object.version, `${path}.version`);
  if (!EXACT_SEMVER.test(version)) fail(`${path}.version`, 'must be an exact SemVer version');
  const publishTimestamp = object.publishTimestamp;
  if (typeof publishTimestamp !== 'number' || !Number.isInteger(publishTimestamp)
    || publishTimestamp < 0 || publishTimestamp >= MAX_PUBLISH_TIMESTAMP) {
    fail(`${path}.publishTimestamp`, 'must be an integer number of Unix seconds in [0, 10^11)');
  }
  return {
    version,
    publishTimestamp,
    source: source(object.source, `${path}.source`),
    engines: optional(object, 'engines', path, engines) ?? {},
  };
}

function versions(value, path) {
  if (!Array.isArray(value) || value.length === 0) fail(path, 'must be a non-empty array');
  const seen = new Set();
  return value.map((member, position) => {
    const at = `${path}[${String(position)}]`;
    const entry = marketVersion(member, at);
    if (seen.has(entry.version)) fail(`${at}.version`, `duplicates ${entry.version}`);
    seen.add(entry.version);
    return entry;
  });
}

function plugin(value, path, index, indexUrl) {
  const object = objectAt(value, path);
  const name = stringAt(object.name, `${path}.name`);
  if (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name)) fail(`${path}.name`, 'must be a valid npm package name');
  const title = optional(object, 'title', path, localizedText);
  const description = optional(object, 'description', path, localizedText);
  const iconUrl = optional(object, 'icon', path, (member, at) => icon(member, at, indexUrl));
  const author = optional(object, 'author', path, stringAt);
  const homepage = optional(object, 'homepage', path, homepageUrl);
  const repo = optional(object, 'repository', path, repository);
  return {
    name,
    ...title === undefined ? {} : { title },
    ...description === undefined ? {} : { description },
    ...iconUrl === undefined ? {} : { icon: iconUrl },
    ...author === undefined ? {} : { author },
    ...homepage === undefined ? {} : { homepage },
    ...repo === undefined ? {} : { repository: repo },
    metadata: pluginMetadata(object.metadata, `${path}.metadata`, index),
    versions: versions(object.versions, `${path}.versions`),
  };
}

/**
 * 校验一份已解析的 format:1 索引，与宿主 `parseMarketIndex()` 判定等价。
 * @param {unknown} value 已 `JSON.parse` 的文档
 * @param {string} indexUrl 索引的绝对 URL（相对图标引用以它为基准）
 * @returns {{format: 1, title: unknown, metadata: object, plugins: object[]}} 校验通过的索引（原样透传关键字段）
 * @throws {MarketIndexError} 违反第一条规则时抛
 */
export function parseMarketIndex(value, indexUrl) {
  if (!URL.canParse(indexUrl)) fail('$', `index URL ${JSON.stringify(indexUrl)} must be an absolute URL`);
  const base = new URL(indexUrl);
  const object = objectAt(value, '$');
  if (object.format !== 1) fail('$.format', 'must be 1');
  const metadata = indexMetadata(object.metadata, '$.metadata');
  if (!Array.isArray(object.plugins)) fail('$.plugins', 'must be an array');
  const names = new Set();
  const plugins = object.plugins.map((entry, position) => {
    const parsed = plugin(entry, `$.plugins[${String(position)}]`, metadata, base);
    if (names.has(parsed.name)) fail(`$.plugins[${String(position)}].name`, `duplicates ${parsed.name}`);
    names.add(parsed.name);
    return parsed;
  });
  const title = localizedText(object.title, '$.title');
  const description = optional(object, 'description', '$', localizedText);
  return { format: 1, title, ...description === undefined ? {} : { description }, metadata, plugins };
}
