/**
 * 前端 API 配置探测器。
 *
 * 目标：在“插件”和“人物卡”里找出“从前端直连第三方 API”的配置
 * （接口地址 + 密钥 + 模型），把它们整理成可转换的候选条目。
 *
 * 五类来源：
 *   1. extension_settings 里的第三方插件命名空间（结构化对象，可信度高 → 自动转换）
 *   2. 当前人物卡的数据（结构化对象，可信度高 → 自动转换）
 *   3. 浏览器 localStorage 里的配置（人物卡脚本常把 API 地址/密钥存在这里，如「手机UI」）
 *   4. ST 全局变量 / 聊天变量里的配置
 *   5. 人物卡脚本 / 文本里的接口地址与密钥（可信度低 → 只做“疑似”建议，需手动确认）
 *
 * 未启用的插件（extension_settings.disabledExtensions）一律不转换：配置只是残留数据，
 * 它现在根本不会发请求；本地回环地址也不自动转换（浏览器本来就能直连）。
 *
 * ST 自身的命名空间（connectionManager、tts、sd、vectors…）一律不自动转换，
 * 因为它们的请求本来就走服务端，转成代理反而会出错。
 */

import { characters, chat_metadata, this_chid } from '../../../../../script.js';
import { extensionNames, extension_settings, getExtensionManifest } from '../../../../extensions.js';
import { hashString, isPlainObject, keyHintOf, normalizeEndpoint, safeJsonParse, tryUrl } from './util.js';

/** ST 内部命名空间：不自动转换，只做“疑似”提示。 */
const CORE_NAMESPACES = new Set([
    'disabledExtensions', 'autoConnect', 'notifyUpdates', 'cfg', 'note', 'variables',
    'attachments', 'disabled_attachments', 'character_attachments', 'caption', 'connectionManager',
    'regex', 'regex_presets', 'character_allowed_regex', 'preset_allowed_regex', 'expressions',
    'expressionOverrides', 'memory', 'source', 'vectors', 'translate', 'quickReply', 'quickReplyV2',
    'tts', 'sd', 'vrm', 'rvc', 'assets', 'apiUrl', 'apiKey',
]);

/** 键名里出现这些词时，即使以 url/endpoint 结尾也不当作接口地址。 */
const URL_KEY_DENY = /(image|avatar|icon|logo|thumbnail|avatarurl|home|doc|docs|help|repo|repository|github|feedback|download|source|raw|wiki|reference|discord|banner|background|covers?)/i;

/* 国产 / 日系插件常用中文字段名，normKey 会把非 ASCII 全丢掉（「api地址」只剩下 api），
   所以中文键名单独按原文判断。 */
/** 中文字段名：接口地址。 */
const CJK_URL = /(地址|网址|域名|端点|主机|接口|服务端)/;
/** 中文字段名：不像接口地址的（图片/文档等）。 */
const CJK_URL_DENY = /(图片|图像|头像|图标|封面|背景|壁纸|音频|音效|视频|下载|文档|说明|主页|截图|仓库|示例|字体|缓存)/;
/** 中文字段名：密钥。 */
const CJK_KEY = /(密钥|秘钥|令牌|密码|鉴权|钥匙)/;
/** 中文字段名：不像密钥的（数量/余额等）。 */
const CJK_KEY_DENY = /(数量|个数|长度|过期|余额|用量|限制|有效期|状态)/;
/** 中文字段名：模型。 */
const CJK_MODEL = /(模型|model)/i;
/** 中文字段名：不像模型名的（来源/列表/数量等）。 */
const CJK_MODEL_DENY = /(列表|数量|个数|路径|目录|文件夹|版本|来源|设置|配置|信息|参数|格式|模式|开关|映射)/;
/** 键名里出现这些词时，即使以 token 结尾也不当作密钥。 */
const KEY_KEY_DENY = /(max|limit|count|tokens|tokenizer|usage|quota|balance|expire|length|lengths)/i;
/** 看起来像占位符的密钥值。 */
const KEY_VALUE_DENY = /^(your|my|here|please|enter|填入|请填|xxx*?|placeholder|example|test|none|null|undefined|sk-xxx|sk-\*+)$/i;

/** 明显不是 API 的常见主机（文档、CDN、社区等）。 */
const HOST_DENY = /(github\.com|githubusercontent\.com|gitlab\.com|jsdelivr\.net|unpkg\.com|cdnjs|npmjs|npms\.io|w3\.org|json-schema\.org|mozilla\.org|jquery\.com|lodash\.com|vuejs\.org|tailwindcss\.com|fontawesome\.com|socket\.io|discord\.(com|gg)|feishu\.cn|example\.(com|org|net)|localhost|127\.0\.0\.1|0\.0\.0\.0|runninghub\.ai\/.*\.(png|jpg)|aka\.ms|stuk\.github\.io|jsonschema|underscorejs|openjsf|stuartk\.com|fleegix\.org|apache\.org|rfc-editor\.org|my-proxy\.internal|t\.leftsite\.cn|spell\.novelai\.dev|novelai-tag\.pages\.dev|huggingface\.co)/i;

/** 请求路径里出现这些片段时，认为是“接口”而不是普通网页。 */
const API_PATH = /(\/v1\b|\/v1beta\b|\/v3\b|\/v4\b|\/api\/|chat\/completions|\/completions\b|\/models\b|\/messages\b|\/embeddings\b|\/images\/generations)/i;

/** 本地回环地址：浏览器直连没有跨域问题，不需要转后端。 */
const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1|host\.docker\.internal)$/i;
/** localStorage 里明显不是配置的键（图片/缓存等），跳过以免卡顿。 */
const STORAGE_KEY_DENY = /(img|image|photo|avatar|thumb|icon|logo|blob|base64|sound|audio|video|font|wallpaper|screenshot|cache|backup|history)/i;
/** 单个 localStorage 值超过这个长度就不解析了（当作非配置）。 */
const STORAGE_VALUE_MAX = 400_000;
/** 人物卡脚本文本只需要用来做关键词匹配，留这么多字符足够。 */
const CHARACTER_TEXT_MAX = 16_000_000;

/**
 * 归一化键名：去掉下划线/连字符/大小写差异。
 * @param {string} key 原始键名
 * @returns {string} 归一化结果
 */
function normKey(key) {
    return String(key ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * 两个字符串的最长公共子串（只用于“插件名 vs 命名空间”的模糊比对，字符串都很短）。
 * @param {string} a 字符串 a
 * @param {string} b 字符串 b
 * @returns {string} 最长公共子串
 */
function longestCommonSubstring(a, b) {
    if (!a || !b) return '';
    let best = '';
    const prev = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
        let last = 0;
        for (let j = 1; j <= b.length; j++) {
            const current = prev[j];
            if (a[i - 1] === b[j - 1]) {
                prev[j] = last + 1;
                if (prev[j] > best.length) best = a.slice(i - prev[j], i);
            } else {
                prev[j] = 0;
            }
            last = current;
        }
    }
    return best;
}

/**
 * 已被用户停用的扩展名列表（形如 third-party/st-yuzi-phone）。
 * @returns {string[]} 名称
 */
export function disabledExtensionNames() {
    const list = extension_settings?.disabledExtensions;
    return Array.isArray(list) ? list.map(item => String(item)) : [];
}

/**
 * 判断某个命名空间 / 展示名是否属于“已停用的插件”。
 * 停用的插件不会发请求，它的残留配置不该被转换成后端配置。
 * @param {...(string|undefined|null)} names 命名空间、展示名等
 * @returns {boolean} 是否已停用
 */
export function isExtensionDisabled(...names) {
    const tokens = disabledExtensionNames().map(normKey).filter(token => token.length >= 6);
    if (tokens.length === 0) return false;
    for (const raw of names) {
        const mine = normKey(raw);
        if (mine.length < 6) continue;
        for (const token of tokens) {
            if (token.includes(mine) || mine.includes(token)) return true;
            const common = longestCommonSubstring(mine, token);
            if (common.length >= 6 && common.length >= Math.min(mine.length, token.length) * 0.6) return true;
        }
    }
    return false;
}

/**
 * localStorage 里这个键还在不在（用于清理已经被删掉的存储配置）。
 * 读不到存储时返回 true，避免误删。
 * @param {string} key 键
 * @returns {boolean} 是否仍存在
 */
export function storageKeyExists(key) {
    try {
        return window.localStorage.getItem(String(key)) !== null;
    } catch {
        return true;
    }
}

/**
 * 地址是否指向本机（localhost / 127.x / ::1）。
 * @param {string} href 地址
 * @returns {boolean} 是否本机
 */
export function isLoopbackHost(href) {
    const url = tryUrl(href);
    if (!url) return false;
    return LOOPBACK_HOST.test(url.hostname);
}

/**
 * 判断一个字段名代表什么：url / key / model / 空。
 * @param {string} key 字段名
 * @returns {'url'|'key'|'model'|''} 类型
 */
function classifyField(key) {
    const raw = String(key ?? '');
    const norm = normKey(raw);
    // 中文键名先判：normKey 只留 ASCII，「api地址」会被判成 "api" 而认不出来。
    if (/[^\x00-\x7f]/.test(raw)) {
        if (CJK_URL.test(raw) && !CJK_URL_DENY.test(raw)) return 'url';
        if (CJK_KEY.test(raw) && !CJK_KEY_DENY.test(raw)) return 'key';
        if (CJK_MODEL.test(raw) && !CJK_MODEL_DENY.test(raw)) return 'model';
    }
    if (!norm) return '';
    const isUrl = norm === 'url' || norm === 'uri' || norm === 'host' || norm === 'hostname'
        || norm === 'baseurl' || norm === 'apiurl' || norm === 'apiendpoint' || norm === 'endpoint'
        || norm === 'serverurl' || norm === 'serveraddress' || norm === 'apiroot' || norm === 'apibase'
        || norm === 'apibaseurl' || norm === 'chatcompletionsurl' || norm === 'completionurl'
        || norm === 'proxy' || norm === 'proxyurl' || norm === 'proxyaddress' || norm === 'reverseproxy'
        || norm.endsWith('baseurl') || norm.endsWith('endpoint') || norm.endsWith('apihost');
    if (isUrl && !URL_KEY_DENY.test(key)) return 'url';

    const isKey = norm === 'key' || norm === 'apikey' || norm === 'apitoken' || norm === 'token'
        || norm === 'accesstoken' || norm === 'secret' || norm === 'apisecret' || norm === 'authkey'
        || norm === 'password' || norm === 'bearertoken' || norm === 'authorization'
        || norm === 'accesskey' || norm === 'sk' || norm === 'aksk'
        || norm.endsWith('apikey') || norm.endsWith('apitoken') || norm.endsWith('accesskey')
        || norm.endsWith('apisecret') || norm.endsWith('authkey') || norm.endsWith('secretkey')
        || norm.endsWith('authtoken') || (norm.endsWith('token') && !/(max|limit|count|ize|num)/.test(norm));
    if (isKey && !KEY_KEY_DENY.test(key)) return 'key';

    if (norm === 'model' || norm.endsWith('model') || norm.endsWith('modelid') || norm.endsWith('modelname')) {
        if (!/(path|list|dir|folder|version|count)/.test(norm)) return 'model';
    }
    return '';
}

/**
 * 密钥值是否可信。
 * @param {unknown} value 值
 * @returns {boolean} 是否像密钥
 */
function isKeyValue(value) {
    if (typeof value !== 'string') return false;
    let token = value.trim();
    if (!token) return false;
    token = token.replace(/^(bearer|token|basic)\s+/i, '').trim();
    if (token.length < 6 || token.length > 512) return false;
    if (/\s/.test(token)) return false;
    if (/^https?:\/\//i.test(token)) return false;
    if (KEY_VALUE_DENY.test(token)) return false;
    return true;
}

/**
 * 模型值是否可信。
 * @param {unknown} value 值
 * @returns {boolean} 是否像模型名
 */
function isModelValue(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.trim().length < 200 && !/\s{2,}/.test(value);
}

/**
 * 在一个对象里找出 url / key / model 三元组。
 * @param {unknown} root 根对象
 * @param {string} prefix 路径前缀
 * @param {number} [maxDepth] 深度上限
 * @returns {Array<{path: string, baseUrl: string, apiKey: string, model: string, keyField: string, modelField: string}>} 结果
 */
export function findApiConfigs(root, prefix = '', maxDepth = 6) {
    /** @type {Array<any>} */
    const found = [];
    const seen = new WeakSet();
    let visited = 0;

    /**
     * @param {object} node 当前对象
     * @param {string} path 路径
     * @param {number} depth 深度
     * @returns {void}
     */
    function visitObject(node, path, depth) {
        if (depth > maxDepth || visited > 3000) return;
        visited++;
        /** @type {Array<{key: string, url: string}>} */
        const urls = [];
        let keyField = '';
        let keyValue = '';
        let modelField = '';
        let modelValue = '';
        for (const [key, value] of Object.entries(node)) {
            const kind = classifyField(key);
            if (kind === 'url') {
                const normalized = normalizeEndpoint(value);
                if (normalized) urls.push({ key, url: normalized });
            } else if (kind === 'key' && !keyField && isKeyValue(value)) {
                keyField = key;
                keyValue = String(value).replace(/^(bearer|token|basic)\s+/i, '').trim();
            } else if (kind === 'model' && !modelField && isModelValue(value)) {
                modelField = key;
                modelValue = String(value).trim();
            }
        }
        for (const item of urls) {
            found.push({
                path: path ? `${path}.${item.key}` : item.key,
                baseUrl: item.url,
                apiKey: keyValue,
                model: modelValue,
                keyField,
                modelField,
            });
        }
        for (const [key, value] of Object.entries(node)) {
            const childPath = path ? `${path}.${key}` : key;
            if (isPlainObject(value)) {
                if (seen.has(value)) continue;
                seen.add(value);
                visitObject(value, childPath, depth + 1);
                continue;
            }
            // 很多插件的 API 配置放在数组里（apiPresets: [{url, key, model}]），也要能扫到。
            if (Array.isArray(value)) {
                value.slice(0, 50).forEach((item, index) => {
                    if (!isPlainObject(item) || seen.has(item)) return;
                    seen.add(item);
                    visitObject(item, `${childPath}[${index}]`, depth + 1);
                });
            }
        }
    }

    if (isPlainObject(root)) {
        seen.add(root);
        visitObject(root, prefix, 0);
    }
    return found;
}

/**
 * 设置命名空间 → 扩展目录名。
 *
 * 插件的命名空间常常和它的目录名毫无关系（tavern_helper 属于 JS-Slash-Runner、
 * baibai_pen 属于 ST-BaiBai-Inkwell），光靠字符串对不上，只能记一份别名。
 * 关键点：别名只在**对应插件确实装了**的时候才生效 —— 插件卸载了、或这里根本没登记的
 * 命名空间（例如 mvu_settings 这种人物卡脚本写进去的），一律不进扫描范围。
 */

/**
 * 属于“卡片脚本运行时 / 宿主框架”的命名空间：即使对应插件装了也不扫。
 * 酒馆助手（JS-Slash-Runner）就是这类 —— 它是卡片脚本的宿主（监听端口、脚本仓库、
 * 变量绑定），里面的地址都是本机端口或卡片脚本自己的东西，不是插件自己的 API 配置。
 */
const NAMESPACE_IGNORE = new Set([
    'tavern_helper',
    'regexBinding_scriptId',
    '__userscripts',
]);
const NAMESPACE_OWNER = new Map([
    ['ejstemplate', 'ST-Prompt-Template'],
    ['baibai_pen', 'ST-BaiBai-Inkwell'],
    ['baibai_api_channels', 'ST-BaiBai-Inkwell'],
    ['st-chatu8', 'st-chatu8'],
    ['novel_auto_generator', 'Novel-Auto-Generator'],
    ['yuziphone', 'st-yuzi-phone'],
    ['tamakomarket', 'st-tamako-market'],
    ['xianshilouceng', 'xianshilouceng'],
]);

/** 已安装扩展的目录名列表（extensionNames 是 `third-party/xxx` 形式）。
 * @returns {string[]} 目录名
 */
function installedExtensionNames() {
    /** @type {Set<string>} */
    const list = new Set();
    for (const name of extensionNames ?? []) {
        const base = String(name ?? '').split('/').filter(Boolean).pop() ?? '';
        if (base) list.add(base);
    }
    // 兜底：extensionNames 是启动期间才填的，页面已加载资源里出现过的扩展目录同样算“已安装”。
    for (const folder of resourceExtensionFolders()) list.add(folder);
    return [...list];
}

/**
 * 页面已经加载过的扩展目录名（从资源 URL 反推：scripts/extensions/third-party/目录/文件）。
 * @returns {string[]} 目录名
 */
function resourceExtensionFolders() {
    let entries = [];
    try {
        entries = performance?.getEntriesByType?.('resource') ?? [];
    } catch {
        return [];
    }
    /** @type {Set<string>} */
    const folders = new Set();
    for (const entry of entries) {
        const match = /\/extensions\/(?:third-party\/)?([^/]+)\//.exec(String(entry?.name ?? ''));
        if (match) folders.add(match[1]);
    }
    return [...folders];
}

/**
 * 这个设置命名空间属于哪个**已安装**的插件。
 * 对不上任何已安装插件时返回空串 —— 说明它不是插件的配置（人物卡脚本写的、或插件已卸载的残留），
 * 这类不进扫描范围。
 * @param {string} namespace extension_settings 的命名空间
 * @returns {string} 扩展目录名（空串表示不属于任何已安装插件）
 */
export function namespaceOwner(namespace) {
    const raw = String(namespace ?? '').trim();
    if (!raw) return '';
    const folders = installedExtensionNames();
    if (folders.length === 0) return '';
    const lower = raw.toLowerCase();
    if (NAMESPACE_IGNORE.has(lower)) return '';
    const plain = lower.replace(/[^a-z0-9]/g, '');
    for (const folder of folders) {
        const mine = folder.toLowerCase();
        if (mine === lower) return folder;
        if (mine.replace(/[^a-z0-9]/g, '') === plain) return folder;
    }
    const alias = NAMESPACE_OWNER.get(lower) ?? NAMESPACE_OWNER.get(plain);
    if (alias) {
        const owner = folders.find(folder => folder.toLowerCase() === alias.toLowerCase());
        // 别名登记了但插件没装：说明只剩残留，同样不算插件的配置。
        if (owner) return owner;
    }
    return '';
}
/** 扩展清单是否已经可用（extensionNames 或已加载资源里已经有扩展了）。
 * @returns {boolean} 是否可用
 */
export function extensionRegistryReady() {
    return installedExtensionNames().length > 0;
}

/**
 * 这个 extension_settings 命名空间算不算“插件的配置”：
 * ST 自带模块，或已安装插件写的设置。对不上的（人物卡脚本写的 mvu_settings、插件卸载后的残留）不算。
 * @param {string} namespace 命名空间
 * @returns {boolean} 是否算插件配置
 */
export function isPluginNamespace(namespace) {
    return CORE_NAMESPACES.has(String(namespace ?? '')) || Boolean(namespaceOwner(namespace));
}

/**
 * 插件的展示名（优先 manifest.display_name）。
 * @param {string} namespace extension_settings 的命名空间
 * @returns {{name: string, detail: string}} 展示信息
 */
function extensionDisplayName(namespace, owner = namespace) {
    const detail = owner === namespace
        ? `插件命名空间：${namespace}`
        : `插件目录：${owner} · 设置命名空间：${namespace}`;
    try {
        const manifest = getExtensionManifest(owner);
        if (manifest && typeof manifest.display_name === 'string' && manifest.display_name.trim()) {
            return { name: manifest.display_name.trim(), detail };
        }
    } catch {
        // getExtensionManifest 在扩展名不存在时会返回 null，这里只兜底异常情况。
    }
    return { name: owner === namespace ? namespace : owner, detail };
}

/**
 * 由来源标识生成稳定 cfgId。
 * @param {string} type 来源类型
 * @param {string} key 来源键（命名空间 / 角色卡名）
 * @param {string} path 字段路径
 * @returns {string} cfgId
 */
export function cfgIdFor(type, key, path) {
    return `cfg_${hashString(`${type}|${key}|${path}`)}`;
}

/**
 * 扫描 extension_settings 里的第三方插件配置。
 * @param {object} [options] 选项
 * @param {number} [options.maxDepth] 深度
 * @returns {{candidates: Array<object>, suggestions: Array<object>}} 结果
 */
export function detectExtensions(options = {}) {
    /** @type {Array<object>} */
    const candidates = [];
    /** @type {Array<object>} */
    const suggestions = [];
    const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 6;

    /** @type {string[]} 不算插件配置的命名空间（不是已安装插件写的） */
    const skipped = [];

    for (const [namespace, value] of Object.entries(extension_settings)) {
        if (!isPlainObject(value)) continue;
        if (namespace === 'f2b') continue;
        const isCore = CORE_NAMESPACES.has(namespace);
        let owner = '';
        if (!isCore) {
            // 只有能确认“这个命名空间确实是某个已安装插件在写”的，才算插件的配置。
            // 对不上的一律跳过：人物卡脚本写进去的（mvu_settings）、插件卸载后的残留，都不是插件的 API 配置。
            owner = namespaceOwner(namespace);
            if (!owner) {
                skipped.push(namespace);
                continue;
            }
        }
        const display = extensionDisplayName(namespace, owner || namespace);
        // 已停用的插件不转换：它的配置只是历史残留，现在根本不会发请求。
        if (!isCore && isExtensionDisabled(owner, namespace, display.name)) continue;
        const found = findApiConfigs(value, namespace, maxDepth);
        for (const item of found) {
            const source = {
                type: 'extension',
                key: namespace,
                name: display.name,
                detail: display.detail,
                path: item.path,
                identity: `extension|${namespace}|${item.path}`,
            };
            const candidate = {
                cfgId: cfgIdFor('extension', namespace, item.path),
                source,
                baseUrl: item.baseUrl,
                model: item.model,
                apiKey: item.apiKey,
                confidence: isCore ? 'low' : 'high',
            };
            if (isCore) {
                suggestions.push(candidate);
                continue;
            }
            if (isLoopbackHost(item.baseUrl)) {
                // 本机接口浏览器本来就能直连，转后端只会多绕一圈。
                suggestions.push({ ...candidate, confidence: 'low', reason: '本地地址（浏览器可直连），一般无需转换' });
                continue;
            }
            candidates.push(candidate);
        }
    }
    if (skipped.length > 0) {
        console.debug('[f2b] 以下设置项不属于已安装插件，已跳过：', skipped.join(', '));
    }
    return { candidates, suggestions, skipped };
}

/** 需要从“文本里挖出来的接口地址”里排除的常见片段。 */
const URL_LITERAL = /https?:\/\/[^\s"'`<>)\]}]+/gi;
/** 文本里疑似密钥的写法。 */
const KEY_LITERAL = /(?:api[_-]?key|apikey|authorization|access[_-]?token|bearer|密钥|秘钥|令牌)\s*[:=]\s*["'`]([^"'`\s]{8,200})["'`]/gi;

/**
 * 把接口地址裁剪成“基础地址”：
 * https://ark.cn-beijing.volces.com/api/v3/chat/completions → https://ark.cn-beijing.volces.com/api/v3
 * @param {string} href 完整地址
 * @returns {string} 基础地址（无法判断时返回空串）
 */
function baseUrlOfLiteral(href) {
    const url = tryUrl(href);
    if (!url) return '';
    if (HOST_DENY.test(url.hostname) || HOST_DENY.test(href)) return '';
    if (!API_PATH.test(url.pathname)) return '';
    /** 端点尾巴：从路径末尾剥掉，剩下的就是“基础地址”。 */
    const endpointTail = /^(chat|completions|completion|models|messages|embeddings|images|generations|responses|audio|speech|rerank|moderations|batches|files|predictions|invocations)$/i;
    let parts = url.pathname.split('/').filter(Boolean);
    while (parts.length > 0 && endpointTail.test(parts[parts.length - 1])) parts = parts.slice(0, -1);
    parts = parts.slice(0, 4);
    if (parts.length === 0) return '';
    return `${url.origin}/${parts.join('/')}`;
}

/**
 * 从一段脚本/文本里挖出接口地址与疑似密钥。
 * @param {string} text 文本
 * @param {number} [limit] 最多返回多少条
 * @returns {Array<{baseUrl: string, apiKey: string, count: number}>} 结果
 */
export function scanTextForEndpoints(text, limit = 5) {
    if (typeof text !== 'string' || text.length < 20 || text.length > 2_000_000) return [];
    /** @type {Map<string, {count: number, apiKey: string}>} */
    const map = new Map();
    let match;
    URL_LITERAL.lastIndex = 0;
    while ((match = URL_LITERAL.exec(text)) !== null) {
        const base = baseUrlOfLiteral(match[0]);
        if (!base) continue;
        const current = map.get(base);
        if (current) current.count++;
        else map.set(base, { count: 1, apiKey: '' });
    }
    if (map.size === 0) return [];
    KEY_LITERAL.lastIndex = 0;
    const keyMatch = KEY_LITERAL.exec(text);
    const apiKey = keyMatch && isKeyValue(keyMatch[1]) ? keyMatch[1] : '';
    return [...map.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, limit)
        .map(([baseUrl, info]) => ({ baseUrl, apiKey, count: info.count }));
}

/**
 * 收集人物卡里所有“可能承载脚本”的字符串。
 * @param {unknown} value 根数据
 * @param {number} [maxDepth] 深度
 * @returns {Array<{path: string, text: string}>} 文本片段
 */
function collectTexts(value, maxDepth = 6) {
    /** @type {Array<{path: string, text: string}>} */
    const texts = [];
    const seen = new WeakSet();
    let visited = 0;

    /**
     * @param {object} node 节点
     * @param {string} path 路径
     * @param {number} depth 深度
     * @returns {void}
     */
    function walk(node, path, depth) {
        if (depth > maxDepth || visited > 4000) return;
        visited++;
        for (const [key, child] of Object.entries(node)) {
            const childPath = path ? `${path}.${key}` : key;
            if (typeof child === 'string') {
                if (child.length >= 60) texts.push({ path: childPath, text: child });
            } else if (isPlainObject(child) && !seen.has(child)) {
                seen.add(child);
                walk(child, childPath, depth + 1);
            } else if (Array.isArray(child)) {
                child.slice(0, 50).forEach((item, index) => {
                    if (!isPlainObject(item) || seen.has(item)) return;
                    seen.add(item);
                    walk(item, `${childPath}[${index}]`, depth + 1);
                });
            }
        }
    }

    if (isPlainObject(value)) {
        seen.add(value);
        walk(value, '', 0);
    }
    return texts;
}

/** 上一次扫到的当前人物卡名与脚本文本（用于给 localStorage 配置标注“来自哪张卡”）。 */
let lastCharacterName = '';
let lastCharacterText = '';

/**
 * 当前“真的点开了”的人物卡。
 * 酒馆停在角色列表页时 this_chid 是 undefined / null / "undefined" 之类，
 * 这种情况下没有卡片脚本可扫，也不该去扫。
 * @returns {object|null} 人物卡对象
 */
export function currentCharacter() {
    const raw = this_chid;
    if (raw === undefined || raw === null || raw === '' || raw === 'undefined' || raw === 'null') return null;
    const index = Number(raw);
    if (!Number.isFinite(index) || index < 0) return null;
    return characters?.[index] ?? null;
}

/**
 * 扫描当前人物卡。
 * @returns {{candidates: Array<object>, suggestions: Array<object>, characterName: string}} 结果
 */
export function detectCharacter() {
    /** @type {Array<object>} */
    const candidates = [];
    /** @type {Array<object>} */
    const suggestions = [];
    const character = currentCharacter();
    if (!character) {
        // 没打开卡片：别留着上一张卡的脚本文本，否则会拿旧文本给全局存储配置乱贴标签。
        lastCharacterName = '';
        lastCharacterText = '';
        return { candidates, suggestions, characterName: '' };
    }
    const name = String(character.name ?? character.avatar ?? '未命名角色卡');
    const data = isPlainObject(character.data) ? character.data : {};
    const extensions = isPlainObject(data.extensions) ? data.extensions : {};
    /** @type {Set<string>} 同一个字段可能被 data.extensions / data 各扫到一次 */
    const seenIds = new Set();

    // 1) 结构化配置：data.extensions 与 data 下同时出现“地址 + 密钥/模型”的对象
    for (const [rootName, root] of [['data.extensions', extensions], ['data', data]]) {
        const found = findApiConfigs(root, rootName, 6);
        for (const item of found) {
            const cfgId = cfgIdFor('character', name, item.path);
            if (seenIds.has(cfgId)) continue;
            seenIds.add(cfgId);
            candidates.push({
                cfgId,
                source: {
                    type: 'character',
                    key: name,
                    name,
                    detail: `人物卡字段：${item.path}`,
                    path: item.path,
                    identity: `character|${name}|${item.path}`,
                },
                baseUrl: item.baseUrl,
                model: item.model,
                apiKey: item.apiKey,
                confidence: 'high',
            });
        }
    }

    // 2) 低可信度：脚本/文本里出现的接口地址
    const texts = collectTexts(extensions, 6);
    lastCharacterName = name;
    let budget = CHARACTER_TEXT_MAX;
    const chunks = [];
    for (const item of texts) {
        if (budget <= 0) break;
        const piece = item.text.length > budget ? item.text.slice(0, budget) : item.text;
        chunks.push(piece);
        budget -= piece.length;
    }
    lastCharacterText = chunks.join('\n').toLowerCase();
    /** @type {Set<string>} */
    const known = new Set(candidates.map(item => item.baseUrl));
    for (const item of texts) {
        for (const hit of scanTextForEndpoints(item.text)) {
            if (known.has(hit.baseUrl)) continue;
            known.add(hit.baseUrl);
            const path = `${item.path}#${hit.baseUrl}`;
            suggestions.push({
                cfgId: cfgIdFor('character', name, path),
                source: {
                    type: 'character',
                    key: name,
                    name,
                    detail: `人物卡脚本：${item.path}`,
                    path,
                    identity: `character|${name}|${path}`,
                },
                baseUrl: hit.baseUrl,
                model: '',
                apiKey: hit.apiKey,
                confidence: 'low',
            });
        }
    }
    return { candidates, suggestions, characterName: name };
}

/**
 * localStorage 的键是否出现在当前人物卡脚本里。
 * 卡片脚本常见 `"yinqi-api-" + channelKey` 这种拼接写法，所以按前缀逐级比对。
 * @param {string} key 存储键
 * @returns {boolean} 是否出现
 */
function storageKeyMentioned(key) {
    if (!lastCharacterText) return false;
    const lowerKey = key.toLowerCase();
    const max = Math.min(14, lowerKey.length - 1);
    for (let len = max; len >= 8; len--) {
        if (lastCharacterText.includes(lowerKey.slice(0, len))) return true;
    }
    return false;
}

/**
 * 已加载资源 → 扩展标记的缓存（页面继续加载新文件后会自动重算）。
 * @type {Array<{token: string, owner: string}>|null}
 */
let learnedTokens = null;
let learnedCount = -1;

/**
 * 从浏览器已经加载过的资源 URL 里学习「扩展目录 → 子目录/文件名标记」。
 *
 * 很多插件把功能拆成子应用，localStorage 键名用的是子应用的名字而不是插件目录名，
 * 例如 Novel-Auto-Generator 内置的 txtToWorldbook 用 `txtToWorldbookSettings` 存设置。
 * 页面加载过 `.../Novel-Auto-Generator/txtToWorldbook/services/settingsPersistenceService.js`，
 * 于是 `txtToWorldbook` 这个标记就能认回宿主插件 Novel-Auto-Generator（无需再下载任何文件）。
 * @returns {Array<{token: string, owner: string}>} 标记 → 扩展目录
 */
function learnExtensionTokens() {
    let entries = [];
    try {
        entries = performance?.getEntriesByType?.('resource') ?? [];
    } catch {
        return [];
    }
    if (learnedTokens && entries.length === learnedCount) return learnedTokens;
    /** @type {Array<{token: string, owner: string}>} */
    const map = [];
    const seen = new Set();
    for (const entry of entries) {
        const url = String(entry?.name ?? '');
        const match = /\/extensions\/(?:third-party\/)?([^/]+)\/(.+)$/.exec(url);
        if (!match) continue;
        const owner = match[1];
        const rest = match[2].split(/[?#]/)[0];
        for (const segment of rest.split('/')) {
            const token = segment
                .replace(/\.(?:m?js|css|html|json|png|svg|woff2?)$/i, '')
                .replace(/[^A-Za-z0-9]/g, '')
                .toLowerCase();
            if (token.length < 6 || token.length > 48) continue;
            // 通用文件名不做标记，避免把无关的 localStorage 键也认成插件配置。
            if (/^(index|main|style|styles|bootstrap|common|constants|config|settings|utils?|helpers?|types?|version|src)$/.test(token)) continue;
            const id = token + '|' + owner;
            if (seen.has(id)) continue;
            seen.add(id);
            map.push({ token, owner });
        }
    }
    learnedTokens = map;
    learnedCount = entries.length;
    return map;
}
/**
 * localStorage 的键属于哪个插件（不属于插件时返回空串）。
 * 酒馆不少扩展把设置存在 localStorage 而不是 settings.json，键名通常是「扩展名 + Settings」，
 * 例如楼阁的 txtToWorldbookSettings。识别出来之后这类配置就与人物卡无关，任何时候都能扫到。
 * @param {string} key 存储键
 * @returns {string} 插件名（空串表示不是插件配置）
 */
function pluginNameForKey(key) {
    const lower = String(key || '').toLowerCase();
    if (lower.length < 4) return '';
    // a) 键名就是某个扩展的命名空间
    for (const ns of Object.keys(extension_settings ?? {})) {
        if (typeof ns !== 'string' || ns.length < 4) continue;
        if (lower === ns.toLowerCase()) return ns;
    }
    // b) 键名里含扩展目录名
    for (const name of extensionNames ?? []) {
        const base = String(name).split('/').pop() ?? '';
        const token = base.toLowerCase();
        if (token.length < 4) continue;
        if (lower.includes(token)) return base;
    }
    // c) 键名里含该扩展的子目录/文件名（Novel-Auto-Generator 的 txtToWorldbook → txtToWorldbookSettings）
    for (const item of learnExtensionTokens()) {
        if (lower.includes(item.token)) return item.owner;
    }
    return '';
}

/**
 * 扫描浏览器 localStorage。
 * 人物卡里的脚本常把第三方 API 配置写在这里（例如「手机UI」的 yinqi-api-chat），
 * settings.json 和卡片本身都看不到，只能从这里读。
 * @returns {{candidates: Array<object>, suggestions: Array<object>}} 结果
 */
export function detectStorage() {
    /** @type {Array<object>} */
    const candidates = [];
    /** @type {Array<object>} */
    const suggestions = [];
    let storage = null;
    try {
        storage = window.localStorage;
    } catch {
        return { candidates, suggestions };
    }
    if (!storage) return { candidates, suggestions };
    let total = 0;
    try {
        total = Number(storage.length) || 0;
    } catch {
        return { candidates, suggestions };
    }

    // 第一遍：把能解析的项都读出来。有的插件把 API Key 单独存在 `<键>:credentials` 里，
    // 需要回头看兄弟键才能把密钥补齐（Novel-Auto-Generator 的 txt 转世界书就是这样）。
    /** @type {Array<{key: string, parsed: object|Array}>} */
    const records = [];
    let parsedCount = 0;
    for (let index = 0; index < total && parsedCount < 120; index++) {
        let key = '';
        try {
            key = String(storage.key(index) ?? '');
        } catch {
            continue;
        }
        if (!key || STORAGE_KEY_DENY.test(key)) continue;
        let raw = null;
        try {
            raw = storage.getItem(key);
        } catch {
            continue;
        }
        if (typeof raw !== 'string' || raw.length < 8 || raw.length > STORAGE_VALUE_MAX) continue;
        const trimmed = raw.trimStart();
        if (trimmed[0] !== '{' && trimmed[0] !== '[') continue;
        const parsed = safeJsonParse(raw);
        if (!parsed || typeof parsed !== 'object') continue;
        parsedCount++;
        records.push({ key, parsed });
    }

    /**
     * 找同一份配置的“凭据兄弟键”（`<键>:credentials` 之类）里的密钥。
     * @param {string} key 主键
     * @returns {string} 密钥（找不到返回空串）
     */
    const credentialOf = (key) => {
        const base = key.toLowerCase();
        for (const record of records) {
            if (record.key === key) continue;
            const other = record.key.toLowerCase();
            if (!other.startsWith(base + ':') && !other.startsWith(base + '.') && !other.startsWith(base + '_')) continue;
            if (!isPlainObject(record.parsed)) continue;
            for (const [field, value] of Object.entries(record.parsed)) {
                if (classifyField(field) !== 'key') continue;
                if (!isKeyValue(value)) continue;
                return String(value).replace(/^(bearer|token|basic)\s+/i, '').trim();
            }
        }
        return '';
    };

    for (const record of records) {
        const key = record.key;
        // 三类键：
        //   ① 插件自己的设置（txtToWorldbookSettings 之类，靠目录名/子目录名认出来）—— 与人物卡无关，任何时候都扫；
        //   ② 当前这张卡的脚本用到的键（yinqi-api-* 之类）—— 只在打开这张卡时扫；
        //   ③ 其余（来源不明）—— 只列进“疑似”，不自动转换。
        const owner = pluginNameForKey(key);
        const display = owner ? extensionDisplayName(owner) : null;
        if (display && isExtensionDisabled(owner, display.name)) continue;
        const fromCharacter = owner ? '' : (storageKeyMentioned(key) ? lastCharacterName : '');
        const unknownSource = !owner && !fromCharacter;
        const roots = Array.isArray(record.parsed)
            ? record.parsed.slice(0, 20).map((value, i) => ({ path: `${key}[${i}]`, value }))
            : [{ path: key, value: record.parsed }];
        for (const root of roots) {
            if (!isPlainObject(root.value)) continue;
            for (const item of findApiConfigs(root.value, root.path, 6)) {
                const apiKey = item.apiKey || credentialOf(key);
                const candidate = {
                    cfgId: cfgIdFor('storage', key, item.path),
                    source: {
                        type: 'storage',
                        key,
                        name: display ? display.name : (fromCharacter || key),
                        plugin: owner || '',
                        character: fromCharacter,
                        detail: owner
                            ? `浏览器存储（localStorage）· 键 ${key} · 属于插件「${display ? display.name : owner}」的设置`
                            : (fromCharacter
                                ? `浏览器存储（localStorage）· 键 ${key} · 该键出现在角色卡「${fromCharacter}」的脚本里`
                                : `浏览器存储（localStorage）· 键 ${key}`),
                        path: item.path,
                        identity: `storage|${key}|${item.path}`,
                    },
                    baseUrl: item.baseUrl,
                    model: item.model,
                    apiKey,
                    confidence: 'high',
                };
                if (isLoopbackHost(item.baseUrl)) {
                    suggestions.push({ ...candidate, confidence: 'low', reason: '本地地址（浏览器可直连），一般无需转换' });
                    continue;
                }
                if (unknownSource) {
                    suggestions.push({
                        ...candidate,
                        confidence: 'low',
                        reason: '来源不明：当前人物卡没用到这个存储键，也不像已安装插件的设置（可能是别的卡或已卸载扩展的残留）',
                    });
                    continue;
                }
                candidates.push(candidate);
            }
        }
    }
    return { candidates, suggestions };
}

/**
 * 扫描 ST 全局变量与当前聊天变量里的 API 配置。
 * @returns {{candidates: Array<object>, suggestions: Array<object>}} 结果
 */
export function detectVariables() {
    /** @type {Array<object>} */
    const candidates = [];
    /** @type {Array<object>} */
    const suggestions = [];
    /** @type {Array<{key: string, name: string, detail: string, root: object, path: string}>} */
    const roots = [];
    const globalVars = extension_settings?.variables;
    if (isPlainObject(globalVars) && isPlainObject(globalVars.global)) {
        roots.push({
            key: 'global',
            name: '全局变量',
            detail: 'ST 全局变量（extension_settings.variables.global）',
            root: globalVars.global,
            path: 'variables.global',
        });
    }
    if (isPlainObject(chat_metadata) && isPlainObject(chat_metadata.variables)) {
        roots.push({
            key: 'chat',
            name: '聊天变量',
            detail: '当前聊天变量（chat_metadata.variables）',
            root: chat_metadata.variables,
            path: 'chat_metadata.variables',
        });
    }
    for (const item of roots) {
        for (const hit of findApiConfigs(item.root, item.path, 6)) {
            const candidate = {
                cfgId: cfgIdFor('variables', item.key, hit.path),
                source: {
                    type: 'variables',
                    key: item.key,
                    name: item.name,
                    detail: item.detail,
                    path: hit.path,
                    identity: `variables|${item.key}|${hit.path}`,
                },
                baseUrl: hit.baseUrl,
                model: hit.model,
                apiKey: hit.apiKey,
                confidence: 'high',
            };
            if (isLoopbackHost(hit.baseUrl)) {
                suggestions.push({ ...candidate, confidence: 'low', reason: '本地地址（浏览器可直连），一般无需转换' });
                continue;
            }
            candidates.push(candidate);
        }
    }
    return { candidates, suggestions };
}

/**
 * 一次完整扫描：插件 + 当前人物卡 + localStorage + 变量。
 * @returns {{candidates: Array<object>, suggestions: Array<object>, summary: string}} 扫描结果
 */
export function detectAll() {
    const extensionResult = detectExtensions();
    // 角色列表页（没点开任何人物卡）时，卡片脚本动辄几 MB —— 这一轮不去碰它，只扫插件。
    // 但 localStorage 仍然要扫：插件自己的设置（txtToWorldbookSettings 等）与人物卡无关；
    // 而“只属于某张卡”的存储键需要卡片脚本文本才能认出来，没开卡时自然扫不到（这是对的）。
    const hasCharacter = Boolean(currentCharacter());
    const characterResult = hasCharacter ? detectCharacter() : { candidates: [], suggestions: [], characterName: '' };
    const storageResult = detectStorage();
    const variablesResult = detectVariables();
    /** @type {Map<string, object>} */
    const candidates = new Map();
    /** @type {Map<string, object>} */
    const suggestions = new Map();
    for (const item of [
        ...extensionResult.candidates,
        ...characterResult.candidates,
        ...storageResult.candidates,
        ...variablesResult.candidates,
    ]) {
        candidates.set(item.cfgId, item);
    }
    /** @type {Set<string>} 已经作为正式配置存在的地址，不再重复提示 */
    const knownUrls = new Set([...candidates.values()].map(item => item.baseUrl));
    for (const item of [
        ...extensionResult.suggestions,
        ...characterResult.suggestions,
        ...storageResult.suggestions,
        ...variablesResult.suggestions,
    ]) {
        if (knownUrls.has(item.baseUrl)) continue;
        suggestions.set(item.cfgId, item);
    }
    // 插件存在 localStorage 里的配置（Novel-Auto-Generator 的 txt 转世界书等）也算「插件」。
    const storagePluginCount = storageResult.candidates.filter(item => item.source?.plugin).length;
    const summary = [
        `插件 ${extensionResult.candidates.length + storagePluginCount}`,
        hasCharacter ? `人物卡 ${characterResult.candidates.length}` : '人物卡 未打开（跳过）',
        `浏览器存储 ${storageResult.candidates.length - storagePluginCount}`,
        `变量 ${variablesResult.candidates.length}`,
        `疑似 ${suggestions.size}`,
    ].join(' · ');
    return {
        candidates: [...candidates.values()],
        suggestions: [...suggestions.values()],
        summary,
        characterName: characterResult.characterName,
    };
}

/**
 * 由候选生成一条前端仓库条目。
 * @param {object} candidate 候选
 * @returns {object} 条目
 */
export function entryFromCandidate(candidate) {
    const keyHint = keyHintOf(candidate.apiKey);
    return {
        cfgId: candidate.cfgId,
        enabled: true,
        manual: false,
        autoImported: true,
        source: candidate.source,
        matchBaseUrl: candidate.baseUrl,
        baseUrl: candidate.baseUrl,
        model: candidate.model || '',
        pathRewrite: '',
        authStyle: 'header',
        authHeader: 'authorization',
        authPrefix: 'Bearer ',
        authQueryName: 'api_key',
        timeoutMs: 600000,
        extraHeaders: {},
        keyHint,
        hasKey: false,
        keyPreview: '',
        // 浏览器存储 / 变量里读到的配置天然是“确认在前端用的”，插件则要靠后面探测入口代码。
        probe: candidate.confidence === 'high' && candidate.source?.type !== 'extension' ? 'yes' : 'unknown',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        backendPending: false,
    };
}
