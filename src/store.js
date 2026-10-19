/**
 * f2b 前端侧配置仓库。
 *
 * 这里只持久化“非敏感”的部分：来源信息、接口地址、模型、匹配规则、悬浮球位置等。
 * API Key 只存在于服务端插件（<数据目录>/<用户>/f2b-takeover/secrets.json），
 * 前端最多保留一个首尾指纹（keyHint）用于提示与请求匹配。
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { dedupeApiBase, isPlainObject, matchesKeyHint, parseBase } from './util.js';

/** extension_settings 下的命名空间。 */
export const SETTINGS_KEY = 'f2b';

/** 单条配置的默认值。 */
export const DEFAULT_ENTRY = Object.freeze({
    cfgId: '',
    enabled: true,
    manual: false,
    autoImported: false,
    source: { type: 'extension', key: '', name: '', detail: '', path: '', identity: '', character: '' },
    /** 前端实际调用地址（用于匹配请求）；改 baseUrl 不会让拦截失效。 */
    matchBaseUrl: '',
    baseUrl: '',
    model: '',
    /** 只有用户真的改过“模型”栏时，才在转发时强制覆盖请求里的 model（否则沿用插件自己的选择）。 */
    forceModel: false,
    /** 改模型之前的值，方便一键改回来。 */
    prevModel: '',
    pathRewrite: '',
    authStyle: 'header',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    authQueryName: 'api_key',
    timeoutMs: 600000,
    extraHeaders: {},
    keyHint: null,
    hasKey: false,
    keyPreview: '',
    probe: 'unknown',
    createdAt: 0,
    updatedAt: 0,
    backendPending: false,
});

/** 扩展级设置的默认值。 */
export const DEFAULT_SETTINGS = Object.freeze({
    entries: [],
    tombstones: [],
    /** 墓碑对应的来源信息（cfgId → {label, baseUrl, type, at}），用于在面板上标明“是哪个插件/人物卡”。 */
    tombstoneInfo: {},
    ball: { x: null, y: null, visible: true },
    /** 面板位置与大小（w/h 为 null 表示用样式表里的默认尺寸）。 */
    panel: { x: null, y: null, w: null, h: null },
    intercept: true,
    autoConvert: true,
    probeFrontend: true,
    /** 前端直连失败时自动改走服务端（解决方舟这类浏览器调不通的接口）。 */
    rescueOnFailure: true,
    lastScanAt: 0,
    lastScanSummary: '',
});

/** @type {Array<object>|null} 路由快照缓存 */
let routesCache = null;

/**
 * 规整一条配置，补齐缺失字段并保证类型安全。
 * @param {any} raw 原始条目
 * @returns {typeof DEFAULT_ENTRY} 规整后的条目
 */
function normalizeEntry(raw) {
    const src = isPlainObject(raw) ? raw : {};
    const source = isPlainObject(src.source) ? src.source : {};
    const entry = {
        ...structuredClone(DEFAULT_ENTRY),
        ...src,
        source: {
            ...DEFAULT_ENTRY.source,
            type: typeof source.type === 'string' ? source.type : 'extension',
            key: typeof source.key === 'string' ? source.key : '',
            name: typeof source.name === 'string' ? source.name : '',
            detail: typeof source.detail === 'string' ? source.detail : '',
            path: typeof source.path === 'string' ? source.path : '',
            identity: typeof source.identity === 'string' ? source.identity : '',
            character: typeof source.character === 'string' ? source.character : '',
            plugin: typeof source.plugin === 'string' ? source.plugin : '',
        },
        // 人物卡脚本可能在地址后面硬拼 /v1，存成 …/v3/v1；统一在这里清掉重复的版本段。
        matchBaseUrl: typeof src.matchBaseUrl === 'string' ? dedupeApiBase(src.matchBaseUrl) : '',
        baseUrl: typeof src.baseUrl === 'string' ? dedupeApiBase(src.baseUrl) : '',
        model: typeof src.model === 'string' ? src.model : '',
        forceModel: src.forceModel === true,
        prevModel: typeof src.prevModel === 'string' ? src.prevModel : '',
        pathRewrite: typeof src.pathRewrite === 'string' ? src.pathRewrite : '',
        authStyle: src.authStyle === 'query' ? 'query' : 'header',
        authHeader: typeof src.authHeader === 'string' && src.authHeader.trim() ? src.authHeader.trim() : 'authorization',
        authPrefix: typeof src.authPrefix === 'string' ? src.authPrefix : 'Bearer ',
        authQueryName: typeof src.authQueryName === 'string' && src.authQueryName.trim() ? src.authQueryName.trim() : 'api_key',
        extraHeaders: isPlainObject(src.extraHeaders) ? { ...src.extraHeaders } : {},
        keyHint: isPlainObject(src.keyHint) ? { ...src.keyHint } : null,
        enabled: src.enabled !== false,
        manual: src.manual === true,
        autoImported: src.autoImported === true,
        hasKey: src.hasKey === true,
        keyPreview: typeof src.keyPreview === 'string' ? src.keyPreview : '',
        probe: typeof src.probe === 'string' ? src.probe : 'unknown',
        backendPending: src.backendPending === true,
        createdAt: Number.isFinite(Number(src.createdAt)) ? Number(src.createdAt) : 0,
        updatedAt: Number.isFinite(Number(src.updatedAt)) ? Number(src.updatedAt) : 0,
        timeoutMs: Number.isFinite(Number(src.timeoutMs)) && Number(src.timeoutMs) > 0 ? Math.min(Number(src.timeoutMs), 900000) : 600000,
    };
    if (!entry.cfgId) entry.cfgId = `cfg_${Math.random().toString(16).slice(2, 10)}`;
    return entry;
}

/**
 * 读取（并修复结构）扩展设置。返回 extension_settings 中的实时对象，
 * 调用方可以直接改字段，然后 saveSettings()；条目的字段规整由 normalizeAllEntries() / upsertEntry() 负责。
 * @returns {typeof DEFAULT_SETTINGS & {entries: Array<typeof DEFAULT_ENTRY>}} 设置
 */
export function getSettings() {
    if (!isPlainObject(extension_settings[SETTINGS_KEY])) {
        extension_settings[SETTINGS_KEY] = structuredClone(DEFAULT_SETTINGS);
    }
    const settings = extension_settings[SETTINGS_KEY];
    if (!Array.isArray(settings.entries)) settings.entries = [];
    if (!Array.isArray(settings.tombstones)) settings.tombstones = [];
    if (!isPlainObject(settings.tombstoneInfo)) settings.tombstoneInfo = {};
    if (!isPlainObject(settings.ball)) settings.ball = { x: null, y: null, visible: true };
    if (typeof settings.ball.visible !== 'boolean') settings.ball.visible = true;
    if (!isPlainObject(settings.panel)) settings.panel = { x: null, y: null, w: null, h: null };
    for (const field of ['w', 'h']) {
        const value = Number(settings.panel[field]);
        settings.panel[field] = Number.isFinite(value) && value > 0 ? Math.round(value) : null;
    }
    if (typeof settings.intercept !== 'boolean') settings.intercept = true;
    if (typeof settings.autoConvert !== 'boolean') settings.autoConvert = true;
    if (typeof settings.probeFrontend !== 'boolean') settings.probeFrontend = true;
    if (typeof settings.rescueOnFailure !== 'boolean') settings.rescueOnFailure = true;
    if (!Number.isFinite(Number(settings.lastScanAt))) settings.lastScanAt = 0;
    if (typeof settings.lastScanSummary !== 'string') settings.lastScanSummary = '';
    return settings;
}

/**
 * 一次性规整全部条目（启动时调用；也会剔除脏数据）。
 * @returns {void}
 */
export function normalizeAllEntries() {
    const settings = getSettings();
    settings.entries = settings.entries.filter(isPlainObject).map(normalizeEntry);
    invalidateRoutes();
    // 规整可能改掉了地址（例如去掉多余的 /v1），顺手落盘，免得每次刷新都要重新算。
    saveSettings();
}

/** 标记设置已变更（下次取路由快照时重建）。 */
export function invalidateRoutes() {
    routesCache = null;
}

/** 持久化设置（防抖）。 */
export function saveSettings() {
    invalidateRoutes();
    saveSettingsDebounced();
}

/**
 * 按 cfgId 查找条目。
 * @param {string} cfgId 配置 id
 * @returns {object|null} 条目或 null
 */
export function findEntry(cfgId) {
    return getSettings().entries.find(entry => entry.cfgId === cfgId) ?? null;
}

/**
 * 新增条目（已存在则替换）。
 * @param {object} entry 条目
 * @returns {object} 规整后的条目
 */
export function upsertEntry(entry) {
    const settings = getSettings();
    const normalized = normalizeEntry(entry);
    const index = settings.entries.findIndex(item => item.cfgId === normalized.cfgId);
    if (index >= 0) settings.entries[index] = normalized;
    else settings.entries.push(normalized);
    saveSettings();
    return normalized;
}

/**
 * 记一条墓碑，并顺便记下它“来自哪个插件/人物卡”。
 * 删除配置后条目就没了，如果不把来源一起存下来，面板上只剩一个 cfg_xxx，
 * 用户根本认不出那是什么；这里把来源标签、地址、类型一起存进 tombstoneInfo。
 * @param {string} cfgId 配置 id
 * @param {{label?: string, baseUrl?: string, type?: string}} [info] 来源信息
 * @returns {void}
 */
export function addTombstone(cfgId, info = {}) {
    if (!cfgId) return;
    const settings = getSettings();
    if (!settings.tombstones.includes(cfgId)) settings.tombstones.push(cfgId);
    const label = typeof info.label === 'string' ? info.label : '';
    const baseUrl = typeof info.baseUrl === 'string' ? info.baseUrl : '';
    const type = typeof info.type === 'string' ? info.type : '';
    if (label || baseUrl || type) {
        const previous = settings.tombstoneInfo[cfgId];
        const at = Number.isFinite(Number(previous?.at)) && Number(previous.at) > 0 ? Number(previous.at) : Date.now();
        settings.tombstoneInfo[cfgId] = { label: label || previous?.label || '', baseUrl: baseUrl || previous?.baseUrl || '', type: type || previous?.type || '', at };
    }
    saveSettings();
}

/**
 * 读取墓碑的来源信息。
 * @param {string} cfgId 配置 id
 * @returns {{label: string, baseUrl: string, type: string, at: number}|null} 来源信息
 */
export function getTombstoneInfo(cfgId) {
    const info = getSettings().tombstoneInfo?.[cfgId];
    if (!isPlainObject(info)) return null;
    return {
        label: typeof info.label === 'string' ? info.label : '',
        baseUrl: typeof info.baseUrl === 'string' ? info.baseUrl : '',
        type: typeof info.type === 'string' ? info.type : '',
        at: Number.isFinite(Number(info.at)) ? Number(info.at) : 0,
    };
}

/**
 * 删除条目；默认留下墓碑，避免下次扫描又被自动转回来。
 * @param {string} cfgId 配置 id
 * @param {boolean} [tombstone] 是否留下墓碑
 * @returns {void}
 */
export function removeEntry(cfgId, tombstone = true) {
    const settings = getSettings();
    const removed = settings.entries.find(item => item.cfgId === cfgId) ?? null;
    settings.entries = settings.entries.filter(item => item.cfgId !== cfgId);
    if (tombstone) {
        addTombstone(cfgId, removed ? {
            label: labelOf(removed),
            baseUrl: removed.matchBaseUrl || removed.baseUrl || '',
            type: removed.source?.type || '',
        } : {});
    }
    saveSettings();
}

/**
 * 取消墓碑（允许重新自动转换）。
 * @param {string} cfgId 配置 id
 * @returns {void}
 */
export function removeTombstone(cfgId) {
    const settings = getSettings();
    settings.tombstones = settings.tombstones.filter(item => item !== cfgId);
    if (settings.tombstoneInfo) delete settings.tombstoneInfo[cfgId];
    saveSettings();
}

/**
 * 展示用的来源标签。
 * @param {object} entry 条目
 * @returns {string} 形如 “插件 · 小说自动生成器”
 */
export function labelOf(entry) {
    const source = entry?.source ?? {};
    const name = source.name || source.key || '未知来源';
    if (source.type === 'character') return `角色卡 · ${name}`;
    if (source.type === 'script') return `脚本 · ${name}`;
    if (source.type === 'storage') {
        // 插件存在 localStorage 里的设置（txtToWorldbookSettings 之类）标成插件，别让用户以为是人物卡的。
        if (source.plugin) return `插件 · ${source.name || source.plugin}（浏览器存储）`;
        return source.character ? `角色卡 · ${source.character}` : `浏览器存储 · ${name}`;
    }
    if (source.type === 'variables') return `变量 · ${name}`;
    if (source.type === 'runtime') return `运行时捕获 · ${name}`;
    if (source.type === 'server') return `服务端 · ${name}`;
    return `插件 · ${name}`;
}

/**
 * 当前生效的匹配路由（仅在启用且开启转发时参与匹配）。
 * 结果被缓存，设置变更时通过 invalidateRoutes() 失效。
 * @returns {Array<{cfgId: string, label: string, origin: string, pathPrefix: string, baseUrl: string, keyHint: object|null}>} 路由
 */
export function getActiveRoutes() {
    if (routesCache) return routesCache;
    const settings = getSettings();
    if (!settings.intercept) {
        routesCache = [];
        return routesCache;
    }
    /** @type {Array<any>} */
    const routes = [];
    for (const entry of settings.entries) {
        if (!entry.enabled) continue;
        // 匹配用“前端调用地址”，转发目标用 baseUrl：这样用户改目标地址不会导致拦截失效。
        const base = parseBase(entry.matchBaseUrl || entry.baseUrl);
        routes.push({
            cfgId: entry.cfgId,
            label: labelOf(entry),
            origin: base ? base.origin : '',
            pathPrefix: base ? base.pathPrefix : '',
            matchBaseUrl: entry.matchBaseUrl || entry.baseUrl,
            baseUrl: entry.baseUrl,
            keyHint: entry.keyHint,
        });
    }
    routesCache = routes;
    return routesCache;
}

/**
 * 命中判断：同源 + 路径前缀；没有 baseUrl 时退化为“密钥指纹匹配”。
 * @param {{url: URL, method: string, headers: Record<string, string>}} request 请求
 * @returns {{cfgId: string, label: string, baseUrl: string}|null} 命中的路由
 */
export function matchRoute(request) {
    const routes = getActiveRoutes();
    if (!routes.length || !request?.url) return null;
    const { url, headers = {} } = request;
    for (const route of routes) {
        if (!route.origin || route.origin !== url.origin) continue;
        if (route.pathPrefix && !url.pathname.startsWith(route.pathPrefix)) continue;
        return route;
    }
    const authValue = headers['authorization'] || headers['x-api-key'] || headers['api-key'] || '';
    if (authValue) {
        for (const route of routes) {
            if (route.keyHint && matchesKeyHint(route.keyHint, authValue)) return route;
        }
    }
    return null;
}
