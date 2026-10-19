/**
 * 扫描 → 转换 → 同步 的编排层。
 *
 * 转换的含义：
 *   - 前端仓库里出现一条“后端配置”条目（来源、地址、模型、匹配规则）；
 *   - 服务端插件里保存同样的 target 与密钥（密钥只留在服务端）；
 *   - 之后的同源请求由转发层改走 /api/plugins/f2b-takeover/proxy。
 * 删除条目则反转这三步，回到插件原本的前端直连行为。
 */

import { getExtensionManifest } from '../../../../extensions.js';
import { checkBackend, deleteServerEntry, fetchServerEntries, isBackendReady, saveServerEntry } from './backend.js';
import { cfgIdFor, detectAll, entryFromCandidate, extensionRegistryReady, isExtensionDisabled, isLoopbackHost, isPluginNamespace, storageKeyExists } from './detect.js';
import { findEntry, getSettings, invalidateRoutes, labelOf, removeEntry, removeTombstone, saveSettings, upsertEntry } from './store.js';
import { nativeFetch } from './native.js';
import { apiBaseOf, keyHintOf, tryUrl } from './util.js';

/** 探测结果缓存：cfgId → 'yes' | 'no' | 'unknown' */
const probeCache = new Map();
/** /api/extensions/discover 结果缓存。 */
let discoveredExtensions = null;

/**
 * 把条目的可编辑字段整理成后端 target。
 * @param {object} entry 条目
 * @returns {object} target
 */
export function buildTarget(entry) {
    return {
        baseUrl: String(entry.baseUrl ?? '').trim(),
        // 模型默认不覆盖：插件/脚本自己写在请求体里的模型才是它当下的选择，
        // 只有用户在面板里改过“模型”栏（forceModel）才强制替换。
        model: entry.forceModel === true ? String(entry.model ?? '').trim() : '',
        pathRewrite: String(entry.pathRewrite ?? '').trim(),
        authStyle: entry.authStyle === 'query' ? 'query' : 'header',
        authHeader: String(entry.authHeader ?? 'authorization').trim() || 'authorization',
        authPrefix: typeof entry.authPrefix === 'string' ? entry.authPrefix : 'Bearer ',
        authQueryName: String(entry.authQueryName ?? 'api_key').trim() || 'api_key',
        timeoutMs: Number(entry.timeoutMs) || 600000,
    };
}

/**
 * 把条目推送到服务端（密钥可选）。
 * @param {object} entry 条目
 * @param {string} [apiKey] 新密钥；省略表示保持服务端已有值
 * @returns {Promise<{hasKey: boolean, keyPreview: string}>} 结果
 */
export async function pushEntry(entry, apiKey = undefined) {
    const payload = {
        cfgId: entry.cfgId,
        target: buildTarget(entry),
        extraHeaders: entry.extraHeaders ?? {},
    };
    if (typeof apiKey === 'string' && apiKey.trim()) payload.apiKey = apiKey.trim();
    const result = await saveServerEntry(payload);
    entry.hasKey = result.hasKey;
    entry.keyPreview = result.keyPreview;
    entry.backendPending = false;
    entry.updatedAt = Date.now();
    return result;
}

/**
 * 把服务端已有的条目合并进前端仓库（服务端为准：是否已有密钥）。
 * @returns {Promise<{imported: number, merged: number}>} 统计
 */
export async function reconcileWithServer() {
    const settings = getSettings();
    /** @type {Record<string, any>} */
    let serverEntries = {};
    try {
        serverEntries = await fetchServerEntries();
    } catch {
        return { imported: 0, merged: 0 };
    }
    let imported = 0;
    let merged = 0;
    for (const [cfgId, remote] of Object.entries(serverEntries)) {
        const local = findEntry(cfgId);
        if (local) {
            local.hasKey = remote?.hasKey === true;
            local.keyPreview = String(remote?.keyPreview ?? '');
            // 服务端还存着旧地址（例如 …/v3/v1 这种多一层 /v1 的）时，用本地净化后的值回写一次，
            // 不然每次转发都靠 /v1 兜底重试。只在确实不一致时推，正常情况不会多发请求。
            const remoteBase = String(remote?.target?.baseUrl ?? '');
            if (local.baseUrl && remoteBase && remoteBase !== local.baseUrl && isBackendReady()) {
                try {
                    await pushEntry(local);
                } catch (error) {
                    console.warn('[f2b] 回写服务端地址失败：', error?.message ?? error);
                }
            }
            merged++;
            continue;
        }
        // 服务端残留（例如换过浏览器）：导入成可管理的条目，避免“看不见的密钥”。
        const target = remote?.target ?? {};
        upsertEntry({
            cfgId,
            enabled: true,
            manual: false,
            autoImported: false,
            source: {
                type: 'server',
                key: cfgId,
                name: '服务端遗留配置',
                detail: '来自服务端 f2b-takeover/config.json',
                path: cfgId,
                identity: `server|${cfgId}`,
            },
            baseUrl: String(target.baseUrl ?? ''),
            model: String(target.model ?? ''),
            pathRewrite: String(target.pathRewrite ?? ''),
            authStyle: target.authStyle === 'query' ? 'query' : 'header',
            authHeader: String(target.authHeader ?? 'authorization'),
            authPrefix: typeof target.authPrefix === 'string' ? target.authPrefix : 'Bearer ',
            authQueryName: String(target.authQueryName ?? 'api_key'),
            timeoutMs: Number(target.timeoutMs) || 600000,
            extraHeaders: remote?.extraHeaders ?? {},
            hasKey: remote?.hasKey === true,
            keyPreview: String(remote?.keyPreview ?? ''),
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
        imported++;
    }
    saveSettings();
    return { imported, merged };
}

/**
 * 执行一次完整扫描与自动转换。
 * @param {object} [options] 选项
 * @param {boolean} [options.autoConvert] 是否自动转换（默认读设置）
 * @returns {Promise<{created: number, updated: number, skipped: number, failed: number, summary: string, suggestions: Array<object>}>} 结果
 */
export async function runScan(options = {}) {
    const settings = getSettings();
    const autoConvert = options.autoConvert ?? settings.autoConvert;
    const detection = detectAll();
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    /** @type {Array<object>} 检测到但因“未开启自动转换”而没有建条的候选，UI 里以“疑似”形式提供手动转换 */
    const unconverted = [];

    await checkBackend();
    const backendReady = isBackendReady();

    // 先清理：插件被停用、或目标只是本机地址的“自动生成”配置直接移除
    // （不留墓碑：插件重新启用后还能再转回来）。
    let pruned = 0;
    for (const entry of [...getSettings().entries]) {
        if (entry.manual) continue;
        // 插件被停用就清理：不管是 extension_settings 里的配置，还是它存在 localStorage 里的设置。
        const disabled = entry.source?.type === 'extension'
            ? isExtensionDisabled(entry.source?.key, entry.source?.name)
            : Boolean(entry.source?.plugin) && isExtensionDisabled(entry.source.plugin, entry.source.name);
        const loopback = isLoopbackHost(entry.baseUrl) || isLoopbackHost(entry.matchBaseUrl);
        // 浏览器存储里的配置被删掉后，对应条目也应该跟着消失。
        const goneStorage = entry.source?.type === 'storage' && !storageKeyExists(entry.source?.key);
        // 命名空间对不上任何已安装插件：它不是插件的 API 配置（人物卡脚本写进 extension_settings 的、
        // 或插件卸载后的残留），不该留在后端配置列表里。
        const unowned = entry.source?.type === 'extension'
            && extensionRegistryReady()
            && !isPluginNamespace(entry.source?.key);
        if (!disabled && !loopback && !goneStorage && !unowned) continue;
        removeEntry(entry.cfgId, false);
        pruned++;
        try {
            await deleteServerEntry(entry.cfgId);
        } catch {
            // 服务端没这条或后端不可用，忽略。
        }
    }

    for (const candidate of detection.candidates) {
        if (settings.tombstones.includes(candidate.cfgId)) {
            skipped++;
            continue;
        }
        const existing = findEntry(candidate.cfgId);
        if (!existing && !autoConvert) {
            unconverted.push(candidate);
            skipped++;
            continue;
        }
        if (!existing) {
            const entry = entryFromCandidate(candidate);
            entry.source = candidate.source;
            let synced = false;
            if (backendReady) {
                try {
                    await pushEntry(entry, candidate.apiKey);
                    synced = true;
                } catch (error) {
                    failed++;
                    console.warn(`[f2b] 同步到服务端失败（${entry.cfgId}）：`, error?.message ?? error);
                }
            }
            // 注意：upsertEntry 存的是规整后的副本，所以状态要先写好再入库。
            entry.backendPending = !synced;
            upsertEntry(entry);
            created++;
            continue;
        }

        // 已存在：只在用户没有手动改过时跟随插件/人物卡里的最新值。
        let changed = false;
        const sourceChanged = Boolean(candidate.source) && (
            candidate.source.name !== existing.source?.name
            // 插件存储在 localStorage 里的配置会补上 plugin 字段，标签跟着从“浏览器存储”变成“插件”。
            || String(candidate.source.plugin ?? '') !== String(existing.source?.plugin ?? '')
        );
        if (sourceChanged) {
            existing.source = { ...existing.source, ...candidate.source };
            changed = true;
        }
        if (!existing.manual) {
            if (candidate.baseUrl && candidate.baseUrl !== existing.baseUrl) {
                existing.baseUrl = candidate.baseUrl;
                changed = true;
            }
            if (candidate.model && candidate.model !== existing.model) {
                existing.model = candidate.model;
                changed = true;
            }
        }
        if (changed) {
            existing.updatedAt = Date.now();
            updated++;
        }
        if (backendReady && (!existing.hasKey && candidate.apiKey)) {
            try {
                await pushEntry(existing, candidate.apiKey);
            } catch (error) {
                existing.backendPending = true;
                failed++;
            }
        } else if (backendReady && existing.backendPending) {
            try {
                await pushEntry(existing);
            } catch {
                // 仍然不可用，保持 pending。
            }
        }
    }

    // 与服务端对齐“是否已有密钥”，并导入服务端残留条目（换浏览器也能看到并管理）。
    if (backendReady) {
        try {
            await reconcileWithServer();
        } catch (error) {
            console.warn('[f2b] 与服务端配置对齐失败：', error?.message ?? error);
        }
    }

    settings.lastScanAt = Date.now();
    settings.lastScanSummary = detection.summary;
    saveSettings();
    invalidateRoutes();

    // 已删除 / 已忽略的配置在设置里只剩一个 cfg_xxx，界面要靠这张表说明“来自哪个插件或人物卡”。
    const known = {};
    for (const item of [...detection.candidates, ...detection.suggestions, ...settings.entries]) {
        if (!item?.cfgId || known[item.cfgId]) continue;
        known[item.cfgId] = {
            label: labelOf(item),
            baseUrl: item.baseUrl || item.matchBaseUrl || '',
            type: item.source?.type || '',
        };
    }

    // 历史墓碑（旧版本只存了 id）能对上就补一次来源，省得界面上只显示 cfg_xxx。
    let backfilled = false;
    for (const cfgId of settings.tombstones) {
        const info = known[cfgId];
        if (!info) continue;
        if (settings.tombstoneInfo[cfgId]) continue;
        settings.tombstoneInfo[cfgId] = { ...info, at: Date.now() };
        backfilled = true;
    }
    if (backfilled) saveSettings();

    return {
        created,
        updated,
        skipped,
        failed,
        pruned,
        known,
        summary: detection.summary,
        // 用户点过“忽略”的（墓碑）不再回到疑似列表，否则下次扫描又会冒出来。
        suggestions: [...detection.suggestions, ...unconverted].filter(item => !settings.tombstones.includes(item.cfgId)),
    };
}

/**
 * 保存一条配置（UI 的“保存”按钮）。
 * @param {object} input 参数
 * @param {string} input.cfgId 配置 id
 * @param {object} input.patch 改动字段
 * @param {string} [input.apiKey] 新密钥（留空表示不修改）
 * @param {boolean} [input.markManual] 是否标记为“用户手动改过”（默认 true）
 * @returns {Promise<{entry: object, hasKey: boolean, keyPreview: string}>} 保存后的条目
 */
export async function saveEntry({ cfgId, patch, apiKey = '', markManual = true }) {
    const entry = findEntry(cfgId);
    if (!entry) throw new Error('配置不存在或已被删除');
    const modelBefore = String(entry.model ?? '').trim();
    Object.assign(entry, patch, { manual: markManual ? true : entry.manual, updatedAt: Date.now() });
    const modelAfter = String(entry.model ?? '').trim();
    if (modelAfter !== modelBefore) {
        // 改过模型 → 之后转发时强制用它；把空模型清空保存则恢复“跟随插件请求”。
        entry.forceModel = Boolean(modelAfter);
        if (modelBefore) entry.prevModel = modelBefore;
    }
    entry.baseUrl = String(entry.baseUrl ?? '').trim();
    entry.model = String(entry.model ?? '').trim();
    if (entry.baseUrl && !tryUrl(entry.baseUrl)) {
        throw new Error('接口地址不是合法的 http(s) 地址');
    }
    if (typeof apiKey === 'string' && apiKey.trim()) entry.keyHint = keyHintOf(apiKey.trim());
    upsertEntry(entry);
    try {
        const result = await pushEntry(entry, apiKey);
        upsertEntry(entry);
        return { entry, ...result };
    } catch (error) {
        entry.backendPending = true;
        upsertEntry(entry);
        throw new Error(`本地已保存，但同步服务端失败：${error?.message ?? error}`);
    }
}

/**
 * 删除一条配置并恢复前端直连（服务端条目一并删除，留下墓碑避免再次自动转换）。
 * @param {string} cfgId 配置 id
 * @returns {Promise<{serverDeleted: boolean}>} 结果
 */
export async function deleteEntry(cfgId) {
    removeEntry(cfgId, true);
    let serverDeleted = false;
    try {
        await deleteServerEntry(cfgId);
        serverDeleted = true;
    } catch (error) {
        console.warn(`[f2b] 删除服务端条目失败（${cfgId}）：`, error?.message ?? error);
    }
    invalidateRoutes();
    saveSettings();
    return { serverDeleted };
}

/**
 * 撤销“已恢复前端直连”，让该来源可以重新被扫描转换。
 * @param {string} cfgId 配置 id
 * @returns {Promise<object>} 扫描结果
 */
export async function restoreTombstone(cfgId) {
    removeTombstone(cfgId);
    probeCache.delete(cfgId);
    return await runScan();
}

/**
 * 一键删除全部后端配置：逐条删除并留下墓碑（可在“已忽略”里逐条恢复）。
 * @returns {Promise<{count: number, serverDeleted: number}>} 结果
 */
export async function deleteAllEntries() {
    const settings = getSettings();
    const ids = settings.entries.map(entry => entry.cfgId);
    let serverDeleted = 0;
    for (const cfgId of ids) {
        try {
            const result = await deleteEntry(cfgId);
            if (result?.serverDeleted) serverDeleted++;
        } catch (error) {
            console.warn(`[f2b] 删除 ${cfgId} 失败：`, error?.message ?? error);
        }
    }
    invalidateRoutes();
    saveSettings();
    return { count: ids.length, serverDeleted };
}

/**
 * 一键清空“已忽略 / 已恢复前端直连”的记录（只清记录，不动任何配置）。
 * @returns {{count: number}} 结果
 */
export function forgetAllTombstones() {
    const settings = getSettings();
    const count = Array.isArray(settings.tombstones) ? settings.tombstones.length : 0;
    settings.tombstones = [];
    settings.tombstoneInfo = {};
    probeCache.clear();
    invalidateRoutes();
    saveSettings();
    return { count };
}

/**
 * 彻底清除一条墓碑记录：只是把它从“已忽略 / 已恢复前端直连”里划掉，不重新扫描。
 * 该来源在下一次扫描时会被当成新配置重新判定（可能又变成疑似，也可能被自动转换）。
 * @param {string} cfgId 配置 id
 * @returns {void}
 */
export function forgetTombstone(cfgId) {
    if (!cfgId) return;
    removeTombstone(cfgId);
    probeCache.delete(cfgId);
    invalidateRoutes();
    saveSettings();
}

/**
 * 手动转换一条“疑似”配置（低可信度候选）。
 * @param {object} candidate 候选
 * @returns {Promise<object>} 新建的条目
 */
export async function convertSuggestion(candidate) {
    const settings = getSettings();
    settings.tombstones = settings.tombstones.filter(item => item !== candidate.cfgId);
    const entry = entryFromCandidate(candidate);
    entry.source = candidate.source;
    upsertEntry(entry);
    invalidateRoutes();
    await checkBackend();
    if (isBackendReady()) {
        try {
            await pushEntry(entry, candidate.apiKey);
        } catch {
            entry.backendPending = true;
        }
    } else {
        entry.backendPending = true;
    }
    upsertEntry(entry);
    return entry;
}

/**
 * 运行时捕获：为一条“前端直连失败”的请求建后端配置，并推到服务端。
 * 用于静态扫描看不到的场景（配置存在 localStorage、脚本加密、远程下发等）。
 * @param {object} input 参数
 * @param {string} input.href 实际请求地址
 * @param {string} [input.apiKey] 请求里带的密钥（存进服务端，前端只留指纹）
 * @param {string} [input.method] 请求方法
 * @param {string} [input.model] 模型名（可选）
 * @returns {Promise<object|null>} 新建或已存在的条目
 */
export async function createRuntimeEntry({ href, apiKey = '', method = 'POST', model = '' }) {
    const url = tryUrl(href);
    if (!url) return null;
    const base = apiBaseOf(url.href);
    if (!base) return null;
    const cfgId = cfgIdFor('runtime', url.host, base);
    let entry = findEntry(cfgId);
    const isNew = !entry;
    if (!entry) {
        const candidate = {
            cfgId,
            source: {
                type: 'runtime',
                key: url.host,
                name: url.host,
                detail: `运行时捕获：${String(method).toUpperCase()} ${url.origin}${url.pathname}`,
                path: `${String(method).toUpperCase()} ${url.pathname}`,
                identity: `runtime|${url.host}|${base}`,
            },
            baseUrl: base,
            model: model || '',
            apiKey,
            confidence: 'high',
        };
        entry = entryFromCandidate(candidate);
        entry.source = candidate.source;
        entry.probe = 'yes';
        entry.autoImported = true;
        upsertEntry(entry);
    }
    invalidateRoutes();
    await checkBackend();
    if (isBackendReady()) {
        try {
            await pushEntry(entry, apiKey || undefined);
        } catch (error) {
            entry.backendPending = true;
            console.warn('[f2b] 运行时配置同步失败：', error?.message ?? error);
        }
    } else {
        entry.backendPending = true;
    }
    upsertEntry(entry);
    saveSettings();
    invalidateRoutes();
    entry.isNew = isNew;
    return entry;
}

/**
 * 读取扩展发现列表（用于定位插件入口文件）。
 * @returns {Promise<Array<{name: string, type: string}>>} 列表
 */
async function getDiscoveredExtensions() {
    if (discoveredExtensions) return discoveredExtensions;
    try {
        const response = await nativeFetch('/api/extensions/discover');
        if (!response.ok) return [];
        const data = await response.json();
        discoveredExtensions = Array.isArray(data) ? data : [];
        return discoveredExtensions;
    } catch {
        return [];
    }
}

/**
 * 在插件入口文件里确认“该地址确实被前端调用”。
 * 只是启发式判断：没搜到不等于没在用（地址可能是拼出来的）。
 * @param {object} entry 条目
 * @returns {Promise<'yes'|'no'|'unknown'>} 判断结果
 */
export async function probeFrontendUsage(entry) {
    const cached = probeCache.get(entry?.cfgId);
    if (cached) return cached;
    const source = entry?.source ?? {};
    if (source.type !== 'extension') return 'unknown';
    const base = tryUrl(entry.baseUrl);
    if (!base) return 'unknown';
    const namespace = String(source.key ?? '');
    const manifest = getExtensionManifest(namespace);
    if (!manifest?.js) return 'unknown';
    const list = await getDiscoveredExtensions();
    const target = list.find(item => {
        const short = String(item.name ?? '').split('/').pop() ?? '';
        return short.toLowerCase() === namespace.toLowerCase();
    });
    const internalName = target?.name ?? `third-party/${namespace}`;
    try {
        const response = await nativeFetch(`/scripts/extensions/${internalName}/${manifest.js}`);
        if (!response.ok) {
            probeCache.set(entry.cfgId, 'unknown');
            return 'unknown';
        }
        const text = await response.text();
        const verdict = text.includes(base.hostname) ? 'yes' : 'no';
        probeCache.set(entry.cfgId, verdict);
        return verdict;
    } catch {
        return 'unknown';
    }
}
