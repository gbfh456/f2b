/**
 * f2b-takeover 服务端插件的前端客户端。
 *
 * 接口约定见 <SillyTavern>/plugins/f2b-takeover/README.md：
 *   GET  /health         存活探测
 *   GET  /config         读取配置条目（密钥只返回指纹）
 *   POST /config         写入 / 更新 / 删除
 *   POST /test           服务端连通性测试（始终 200）
 *   POST /proxy          透明流式转发
 *
 * 所有请求都带 CSRF 头，且必须是管理员账号，否则服务端返回 403。
 */

import { getRequestHeaders } from '../../../../../script.js';
import { nativeFetch } from './native.js';
import { safeJsonParse } from './util.js';

/** 服务端插件 id，与 <ST>/plugins 目录名保持一致。 */
export const PLUGIN_ID = 'f2b-takeover';
/** 服务端插件路由前缀。 */
export const PLUGIN_BASE = `/api/plugins/${PLUGIN_ID}`;
/** 仓库地址：前端扩展与服务端插件共用同一个仓库，装哪边都是同一份代码。 */
export const REPO_URL = 'https://github.com/gbfh456/f2b.git';
/** 在酒馆根目录执行这一条命令即可装上服务端插件（克隆到 plugins/f2b）。 */
export const INSTALL_COMMAND = `node plugins.js install ${REPO_URL}`;

/** @type {{state: 'unknown'|'ready'|'missing'|'forbidden'|'error', version: string, error: string, node: string}} */
const backendInfo = { state: 'unknown', version: '', error: '', node: '' };

/**
 * 当前后端状态快照。
 * @returns {{state: string, version: string, error: string, node: string}} 状态
 */
export function getBackendInfo() {
    return { ...backendInfo };
}

/**
 * 后端是否可用。
 * @returns {boolean} 可用为 true
 */
export function isBackendReady() {
    return backendInfo.state === 'ready';
}

/**
 * 统一的后端 JSON 请求。
 * @param {string} path 相对插件根路径（以 / 开头）
 * @param {object} [options] 选项
 * @param {string} [options.method] HTTP 方法
 * @param {unknown} [options.body] JSON 请求体
 * @param {number} [options.timeoutMs] 超时
 * @returns {Promise<any>} 解析后的 JSON
 */
async function requestJson(path, { method = 'GET', body, timeoutMs = 20000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await nativeFetch(`${PLUGIN_BASE}${path}`, {
            method,
            headers: getRequestHeaders(),
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
        });
        const text = await response.text();
        const data = safeJsonParse(text, null);
        if (!response.ok) {
            const error = new Error(data?.error || `HTTP ${response.status}`);
            error.code = data?.code || `HTTP_${response.status}`;
            error.status = response.status;
            throw error;
        }
        if (data === null) {
            throw Object.assign(new Error('后端返回了无法解析的响应'), { code: 'BAD_JSON' });
        }
        return data;
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw Object.assign(new Error('后端请求超时'), { code: 'TIMEOUT' });
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 探测后端插件是否可用，并缓存状态。
 * @returns {Promise<{state: string, version: string, error: string, node: string}>} 状态
 */
export async function checkBackend() {
    try {
        const data = await requestJson('/health', { timeoutMs: 10000 });
        backendInfo.state = data?.ok === true ? 'ready' : 'error';
        backendInfo.version = String(data?.version ?? '');
        backendInfo.node = String(data?.node ?? '');
        backendInfo.error = data?.ok === true ? '' : '后端返回异常';
    } catch (error) {
        backendInfo.version = '';
        backendInfo.node = '';
        backendInfo.error = String(error?.message ?? error);
        if (error?.status === 404) backendInfo.state = 'missing';
        else if (error?.status === 403) backendInfo.state = 'forbidden';
        else backendInfo.state = 'error';
    }
    return getBackendInfo();
}

/**
 * 读取服务端保存的全部配置条目。
 * @returns {Promise<Record<string, any>>} cfgId → 条目
 */
export async function fetchServerEntries() {
    const data = await requestJson('/config');
    return (data && typeof data.entries === 'object' && data.entries) ? data.entries : {};
}

/**
 * 写入 / 更新一个配置条目（密钥留在服务端）。
 * @param {object} input 参数
 * @param {string} input.cfgId 配置 id
 * @param {object} input.target 目标（baseUrl / model / auth…）
 * @param {object} [input.extraHeaders] 额外请求头
 * @param {string} [input.apiKey] 新密钥；省略表示保持原值
 * @returns {Promise<{hasKey: boolean, keyPreview: string}>} 结果
 */
export async function saveServerEntry(input) {
    const data = await requestJson('/config', { method: 'POST', body: input });
    return { hasKey: data?.hasKey === true, keyPreview: String(data?.keyPreview ?? '') };
}

/**
 * 删除服务端条目（配置与密钥一起删除）。
 * @param {string} cfgId 配置 id
 * @returns {Promise<void>} 完成
 */
export async function deleteServerEntry(cfgId) {
    await requestJson('/config', { method: 'POST', body: { cfgId, delete: true } });
}

/**
 * 服务端连通性测试。
 * @param {object} payload 参数
 * @param {string} payload.url 目标地址
 * @param {string} [payload.method] 方法
 * @param {string} [payload.cfgId] 关联配置（用于套用服务端保存的地址/密钥/模型）
 * @param {string} [payload.label] 日志标签
 * @param {number} [payload.timeoutMs] 超时
 * @param {object} [payload.headers] 附加请求头
 * @returns {Promise<object>} {ok, status, statusText, ms, preview, truncated, authError, error, code}
 */
export async function testConnection(payload) {
    return await requestJson('/test', { method: 'POST', body: payload, timeoutMs: 60000 });
}

/**
 * 透明转发一次请求，返回后端的原始 Response（含流式 body），不做二次解析。
 * @param {object} payload 转发参数，见后端 README 的 POST /proxy
 * @param {AbortSignal} [signal] 取消信号（前端取消请求时一并中断）
 * @returns {Promise<Response>} 原始响应
 */
export async function proxyFetch(payload, signal = undefined) {
    return await nativeFetch(`${PLUGIN_BASE}/proxy`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(payload),
        signal,
    });
}

/** 服务端标记为“不能用”的状态（方舟的 /models 里大量是 Shutdown）。 */
const MODEL_DEAD = /^(shutdown|disabled|offline|unavailable|deleted|inactive|suspended?|stopped)$/i;
/** 还能用但要过期/弃用的状态。 */
const MODEL_RETIRING = /^(retiring|deprecated?|legacy|sunset)/i;

/**
 * 拉取模型列表（走服务端转发，避免跨域与密钥泄露）。
 * 会把“已下线/已停用”的模型单独标出来 —— 方舟的 /models 里 136 个模型有 83 个是 Shutdown，
 * 直接把这堆死模型列给人挑，挑完请求必然失败。
 * @param {string} url 模型列表地址
 * @param {string} [cfgId] 关联配置
 * @param {string} [label] 日志标签
 * @returns {Promise<{models: Array<{id: string, name: string, status: string, available: boolean, note: string}>, total: number, dead: number}>} 模型列表
 */
export async function fetchModels(url, cfgId = '', label = '') {
    const response = await proxyFetch({ url, method: 'GET', cfgId, label, bodyEncoding: 'none' });
    const text = await response.text();
    if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`), { status: response.status });
    }
    const data = safeJsonParse(text, null);
    /** @type {Array<{id: string, name: string, status: string, available: boolean, note: string}>} */
    const all = [];
    const seen = new Set();
    const push = (item) => {
        const raw = typeof item === 'string' ? { id: item } : (item && typeof item === 'object' ? item : null);
        if (!raw) return;
        const id = String(raw.id ?? raw.model ?? raw.name ?? '').trim();
        if (!id || seen.has(id)) return;
        seen.add(id);
        const status = String(raw.status ?? raw.state ?? raw.availability ?? '').trim();
        const dead = MODEL_DEAD.test(status);
        const retiring = !dead && MODEL_RETIRING.test(status);
        all.push({
            id,
            name: String(raw.name ?? '').trim(),
            status,
            available: !dead,
            note: dead ? `已下线（${status}）` : retiring ? `即将下线（${status}）` : '',
        });
    };
    if (Array.isArray(data?.data)) {
        for (const item of data.data) push(item);
    }
    if (Array.isArray(data?.models)) {
        for (const item of data.models) push(item);
    }
    if (Array.isArray(data)) {
        for (const item of data) push(item);
    }
    if (all.length === 0) {
        throw Object.assign(new Error('响应里没有可识别的模型列表'), { code: 'NO_MODELS' });
    }
    // 可用的排前面（各自保持服务端顺序），已下线的挪到最后。
    const models = [...all.filter(item => item.available), ...all.filter(item => !item.available)];
    return { models, total: all.length, dead: all.filter(item => !item.available).length };
}
