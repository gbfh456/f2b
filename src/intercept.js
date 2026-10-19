/**
 * 请求转发层：把“已转换”的前端直连请求改走服务端。
 *
 * 只拦截命中已转换配置的请求（同源 + 路径前缀，或密钥指纹匹配），
 * 其余请求原样交给原生 fetch / XHR，因此对酒馆本体与未转换的插件零影响。
 * 拦截后的响应会被原样重建（状态码 / 响应头 / 流式 body），调用方无法感知差异。
 */

import { getRequestHeaders } from '../../../../../script.js';
import { PLUGIN_BASE, proxyFetch } from './backend.js';
import { getSettings, matchRoute } from './store.js';
import { createRuntimeEntry } from './sync.js';
import { bytesToBase64, toBackendUrl, tryUrl } from './util.js';

/** 超过该体积的请求体不做转发（避免把内存打爆）。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** 重建响应时丢弃的头：由 Response 自己管理或会误导浏览器。 */
const RESPONSE_HEADER_DROP = new Set([
    'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie',
]);
/** 请求头里不需要再带给后端的（后端会自己算/自己剥）。 */
const REQUEST_HEADER_DROP = new Set(['host', 'content-length', 'cookie', 'origin', 'referer', 'x-csrf-token']);
/** 兜底转发时排除的主机：CDN / 字体 / 图床，这些不是模型接口。 */
const RESCUE_HOST_DENY = /(jsdelivr|unpkg|cdnjs|npmjs|npmmirror|githubusercontent|github\.com|gstatic|googleapis|fontsapi|fontawesome|bootstrapcdn|huggingface|imgur|discordapp|gyazo|catbox|telegraph|w3\.org|jsonschema)/i;
/** 看起来像模型接口的路径（方舟 /api/coding/v3、OpenAI /v1/chat/completions 等）。 */
const LLM_PATH = /(chat\/completions|\/completions\b|\/messages\b|\/embeddings|\/rerank\b|\/models\b|\/responses\b|\/generate\b|\/api\/v\d|\/v1\/|\/v3\/|\/v4\/)/i;
/**
 * 有些前端脚本会把 `/v1` 硬拼在基础地址后面（银麒赎世的小手机就是这么干的：
 * `base + "/v1/models"`），而火山方舟这类接口的实际路径里没有 `/v1`
 * （`.../api/coding/v3/models` 是 200，`.../api/coding/v3/v1/models` 是 404）。
 * 这里只对模型接口形态的路径做“去掉 /v1”的修正，先按原样发，404/405 时自动重试一次。
 */
const V1_SEGMENT = /\/v1(?=\/)/i;
const LLM_TAIL = /\/(models|chat\/completions|completions|embeddings|messages|responses|rerank)\/?$/i;
/** 已经确认需要去掉 /v1 的 “cfgId|baseUrl” 组合。 */
const v1StrippedKeys = new Set();

/** 本机地址浏览器本来就能直连，不做兜底。 */
const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1)$/i;

/** 运行时捕获事件的回调（由 index.js 接到 UI 上）。 */
let runtimeHook = null;

/**
 * 注册“运行时捕获/自动转后端”事件的回调。
 * @param {((info: {kind: string, host: string, href: string, label?: string}) => void)|null} handler 回调
 * @returns {void}
 */
export function onRuntimeEvent(handler) {
    runtimeHook = typeof handler === 'function' ? handler : null;
}

let installed = false;
/** @type {Function|null} */
let originalFetch = null;
/** @type {Function|null} */
let originalOpen = null;
/** @type {Function|null} */
let originalSend = null;
/** @type {Function|null} */
let originalSetRequestHeader = null;
/** @type {WeakMap<XMLHttpRequest, {method: string, url: string, headers: Record<string, string>, async: boolean}>} */
const xhrInfo = new WeakMap();

/** 统计信息，方便在 UI 里显示“已转发 N 次”。 */
const stats = { forwarded: 0, failed: 0, lastAt: 0, lastUrl: '', lastCfgId: '' };

/**
 * 统计快照。
 * @returns {{forwarded: number, failed: number, lastAt: number, lastUrl: string, lastCfgId: string}} 统计
 */
export function getStats() {
    return { ...stats };
}

/**
 * 转发层是否已安装。
 * @returns {boolean} 已安装为 true
 */
export function isInstalled() {
    return installed;
}

/**
 * 把 headers 归一化成小写普通对象。
 * @param {HeadersInit|undefined} headers 头部来源
 * @param {Record<string, string>} [out] 输出
 * @returns {Record<string, string>} 结果
 */
function absorbHeaders(headers, out = {}) {
    if (!headers) return out;
    try {
        if (typeof Headers !== 'undefined' && headers instanceof Headers) {
            headers.forEach((value, key) => { out[String(key).toLowerCase()] = value; });
            return out;
        }
        if (Array.isArray(headers)) {
            for (const item of headers) {
                if (Array.isArray(item) && item.length >= 2) out[String(item[0]).toLowerCase()] = String(item[1]);
            }
            return out;
        }
        if (typeof headers === 'object') {
            for (const [key, value] of Object.entries(headers)) {
                if (value === undefined || value === null) continue;
                out[String(key).toLowerCase()] = String(value);
            }
        }
    } catch {
        // 头部形态异常时按“没有头部”处理，让匹配自然失败。
    }
    return out;
}

/**
 * 是否为需要处理的 http(s) 地址。
 * @param {string} url 地址
 * @returns {URL|null} 解析结果
 */
function httpUrlOf(url) {
    const parsed = tryUrl(url, window.location.href);
    if (!parsed) return null;
    // 绝不拦截插件自身接口，避免递归。
    if (parsed.origin === window.location.origin && parsed.pathname.startsWith('/api/plugins/')) return null;
    // 也不拦截酒馆自己的后端接口：把酒馆 API 转发出去只会造成死循环或数据错乱。
    // 反向代理场景下第三方接口一般带有自有路径前缀（/ark/api/v1 之类），不受影响。
    if (parsed.origin === window.location.origin && parsed.pathname.startsWith('/api/')) return null;
    return parsed;
}

/**
 * 把请求体读成字节。FormData 会顺带带上浏览器生成的 content-type（含 boundary）。
 * @param {Request|undefined} request Request 输入
 * @param {BodyInit|null|undefined} body init.body
 * @returns {Promise<{bytes: Uint8Array|null, contentType: string}>} 字节与可能的 content-type
 */
async function readBodyBytes(request, body) {
    const none = { bytes: null, contentType: '' };
    if (body === undefined || body === null) {
        if (request instanceof Request) {
            const buffer = await request.clone().arrayBuffer();
            return { bytes: buffer.byteLength > 0 ? new Uint8Array(buffer) : null, contentType: '' };
        }
        return none;
    }
    if (typeof body === 'string') return { bytes: new TextEncoder().encode(body), contentType: '' };
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        return { bytes: new TextEncoder().encode(body.toString()), contentType: '' };
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
        return { bytes: new Uint8Array(await body.arrayBuffer()), contentType: body.type ? `${body.type}` : '' };
    }
    if (body instanceof ArrayBuffer) return { bytes: new Uint8Array(body.slice(0)), contentType: '' };
    if (ArrayBuffer.isView(body)) {
        const view = /** @type {ArrayBufferView} */ (body);
        return {
            bytes: new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)),
            contentType: '',
        };
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const response = new Response(body);
        return {
            bytes: new Uint8Array(await response.arrayBuffer()),
            contentType: response.headers.get('content-type') || '',
        };
    }
    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
        const response = new Response(body);
        return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: '' };
    }
    return none;
}

/**
 * 去掉相对地址里的 `/v1` 段（只对模型接口形态的路径生效）。
 * @param {string} urlString 相对地址
 * @returns {string} 修正后的地址（不适用时返回空串）
 */
function stripV1Path(urlString) {
    const url = tryUrl(urlString);
    if (!url) return '';
    if (!V1_SEGMENT.test(url.pathname) || !LLM_TAIL.test(url.pathname)) return '';
    const path = url.pathname.replace(V1_SEGMENT, '');
    if (path === url.pathname) return '';
    url.pathname = path;
    return url.href;
}

/**
 * `/v1` 修正的缓存键：换了接口地址就重新试探。
 * @param {object} route 路由
 * @returns {string} 键
 */
function v1KeyOf(route) {
    return `${route.cfgId}|${route.baseUrl || ''}`;
}

/**
 * 组装转发参数。
 * @param {object} options 参数
 * @param {URL} options.url 原始地址
 * @param {string} options.method 方法
 * @param {Record<string, string>} options.headers 原始头部
 * @param {Uint8Array|null} options.bytes 请求体字节
 * @param {object} options.route 命中的路由
 * @returns {object} /proxy 参数
 */
function buildProxyPayload({ url, method, headers, bytes, route }) {
    /** @type {Record<string, string>} */
    const cleanHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
        if (REQUEST_HEADER_DROP.has(key)) continue;
        if (key.startsWith('sec-') || key.startsWith('x-forwarded-')) continue;
        cleanHeaders[key] = value;
    }
    const payload = {
        // 相对化必须按“前端匹配地址”算：用户把 baseUrl 改成中转站后，前缀仍由服务端拼接。
        url: toBackendUrl(url.href, route.matchBaseUrl || route.baseUrl),
        method,
        headers: cleanHeaders,
        bodyEncoding: 'none',
        cfgId: route.cfgId,
        label: route.label,
    };
    if (bytes && bytes.byteLength > 0) {
        payload.bodyEncoding = 'base64';
        payload.body = bytesToBase64(bytes);
    }
    return payload;
}

/**
 * 用上游响应重建一个前端可直接使用的 Response。
 * @param {Response} upstream 后端返回的响应
 * @returns {Response} 重建后的响应
 */
function rebuildResponse(upstream) {
    const headers = new Headers();
    upstream.headers.forEach((value, key) => {
        if (RESPONSE_HEADER_DROP.has(key.toLowerCase())) return;
        try {
            headers.set(key, value);
        } catch {
            // 个别头部不允许被脚本设置，忽略即可。
        }
    });
    try {
        headers.set('x-f2b-proxied', '1');
    } catch {
        // 忽略。
    }
    const status = upstream.status >= 200 && upstream.status <= 599 ? upstream.status : 502;
    const nullBody = status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : upstream.body, {
        status,
        statusText: upstream.statusText,
        headers,
    });
}

/**
 * 处理一次 fetch 调用。
 * @param {RequestInfo|URL} input 输入
 * @param {RequestInit|undefined} init 参数
 * @returns {Promise<Response>} 响应
 */
async function forwardFetch(input, init) {
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    const rawUrl = request ? request.url : String(input instanceof URL ? input.href : input);
    const url = httpUrlOf(rawUrl);
    if (!url) return null;
    const method = String(init?.method || request?.method || 'GET').toUpperCase();
    const headers = absorbHeaders(request?.headers);
    absorbHeaders(init?.headers, headers);
    const route = matchRoute({ url, method, headers });
    if (!route) return null;

    const signal = init?.signal ?? request?.signal ?? null;
    const controller = new AbortController();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const { bytes, contentType } = await readBodyBytes(request ?? undefined, init?.body);
    if (bytes && bytes.byteLength > MAX_BODY_BYTES) {
        console.warn('[f2b] 请求体过大，跳过后端转发：', rawUrl);
        return null;
    }
    if (contentType) headers['content-type'] = contentType;
    const payload = buildProxyPayload({ url, method, headers, bytes, route });
    const v1Key = v1KeyOf(route);
    if (v1StrippedKeys.has(v1Key)) {
        const fixed = stripV1Path(payload.url);
        if (fixed) payload.url = fixed;
    }
    stats.forwarded++;
    stats.lastAt = Date.now();
    stats.lastUrl = rawUrl;
    stats.lastCfgId = route.cfgId;
    try {
        let upstream = await proxyFetch(payload, controller.signal);
        // 前端把 /v1 硬拼在地址后面时，上游会 404；去掉 /v1 再试一次就通了。
        if (!upstream.ok && (upstream.status === 404 || upstream.status === 405) && !v1StrippedKeys.has(v1Key)) {
            const fixed = stripV1Path(payload.url);
            if (fixed) {
                try {
                    const retry = await proxyFetch({ ...payload, url: fixed }, controller.signal);
                    if (retry.ok) {
                        v1StrippedKeys.add(v1Key);
                        console.info('[f2b] 上游不接受 /v1 前缀，已自动改为：', fixed);
                        runtimeHook?.({ kind: 'v1', host: url.host, href: url.href, label: route.label });
                        upstream = retry;
                    }
                } catch {
                    // 重试失败就保留第一次的结果。
                }
            }
        }
        if (!upstream.ok) {
            console.warn(`[f2b] 后端转发失败（${upstream.status}）：${route.label}`, rawUrl);
            stats.failed++;
        }
        return rebuildResponse(upstream);
    } catch (error) {
        stats.failed++;
        if (error?.name === 'AbortError') {
            throw new DOMException('The operation was aborted.', 'AbortError');
        }
        console.warn('[f2b] 后端不可用，回退为前端直连：', error?.message ?? error);
        return null;
    }
}

/**
 * 这个地址是否值得在“前端直连失败”之后改走服务端。
 * 只认模型接口形态的跨域地址：CDN、字体、图床、本机地址一概不碰。
 * @param {URL|null} url 地址
 * @returns {boolean} 是否值得兜底
 */
function isRescuableUrl(url) {
    if (!url) return false;
    if (url.origin === window.location.origin) return false;
    if (!/^https?:$/.test(url.protocol)) return false;
    if (LOOPBACK_HOST.test(url.hostname)) return false;
    if (RESCUE_HOST_DENY.test(url.hostname)) return false;
    return LLM_PATH.test(url.pathname);
}

/**
 * 从请求头里取密钥（Authorization / x-api-key）。
 * @param {Record<string, string>} headers 头部
 * @returns {string} 密钥（取不到返回空串）
 */
function extractApiKey(headers) {
    const raw = headers['authorization'] || headers['x-api-key'] || headers['api-key'] || headers['x-auth-token'] || '';
    const token = String(raw).replace(/^(bearer|token|basic)\s+/i, '').trim();
    if (token.length < 6 || token.length > 512) return '';
    if (/\s/.test(token)) return '';
    if (/^https?:\/\//i.test(token)) return '';
    return token;
}

/**
 * 前端直连失败（CORS / 网络错误）时的兜底：
 * 把接口登记成后端配置，然后把这次请求改走服务端重发。
 * @param {RequestInfo|URL} input 输入
 * @param {RequestInit|undefined} init 参数
 * @param {unknown} cause 原始错误
 * @returns {Promise<Response|null>} 转发后的响应（无法兜底时 null）
 */
async function rescueThroughBackend(input, init, cause) {
    try {
        const settings = getSettings();
        if (!settings.intercept || !settings.rescueOnFailure) return null;
        const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
        const rawUrl = request ? request.url : String(input instanceof URL ? input.href : input);
        const url = httpUrlOf(rawUrl);
        if (!isRescuableUrl(url)) return null;
        const method = String(init?.method || request?.method || 'GET').toUpperCase();
        const headers = absorbHeaders(request?.headers);
        absorbHeaders(init?.headers, headers);
        const apiKey = extractApiKey(headers);
        console.info('[f2b] 前端直连失败，改走后端：', url.href, cause?.message ?? '');
        const entry = await createRuntimeEntry({ href: url.href, apiKey, method });
        if (!entry) return null;
        const forwarded = await forwardFetch(input, init);
        if (!forwarded) return null;
        runtimeHook?.({ kind: 'rescued', host: url.host, href: url.href, label: entry.source?.name ?? '' });
        return forwarded;
    } catch (error) {
        console.warn('[f2b] 兜底转发失败：', error?.message ?? error);
        return null;
    }
}

/**
 * XHR 直连失败（status 0 / 网络错误）时，把接口登记成后端配置，下次同样请求就会被转发。
 * 已经失败的那次没法重发，所以只登记不重试。
 * @param {XMLHttpRequest} xhr 请求
 * @param {{method: string, url: string, headers: Record<string, string>}} info 请求信息
 * @param {URL} url 地址
 * @returns {void}
 */
function captureFailedXhr(xhr, info, url) {
    try {
        const settings = getSettings();
        if (!settings.intercept || !settings.rescueOnFailure) return;
        if (!isRescuableUrl(url)) return;
        let done = false;
        const onEnd = () => {
            if (done) return;
            done = true;
            xhr.removeEventListener('loadend', onEnd);
            if (xhr.status !== 0) return;
            void createRuntimeEntry({ href: url.href, apiKey: extractApiKey(info.headers), method: info.method })
                .then((entry) => {
                    if (!entry) return;
                    runtimeHook?.({ kind: 'captured', host: url.host, href: url.href, label: entry.source?.name ?? '' });
                })
                .catch(() => {
                    // 兜底失败时保持原样，不影响业务。
                });
        };
        xhr.addEventListener('loadend', onEnd);
    } catch {
        // 忽略。
    }
}

/**
 * 统一的 fetch 包装：没命中就原样透传，命中则走服务端；
 * 直连失败（方舟这类浏览器调不通的接口）会兜底改走后端。
 * @param {RequestInfo|URL} input 输入
 * @param {RequestInit|undefined} init 参数
 * @returns {Promise<Response>} 响应
 */
function f2bFetch(input, init) {
    return (async () => {
        let forwarded = null;
        try {
            forwarded = await forwardFetch(input, init);
        } catch (error) {
            console.warn('[f2b] 转发异常，回退为前端直连：', error?.message ?? error);
        }
        if (forwarded) return forwarded;
        // 原生 fetch 会消耗 Request 的 body，先留一个克隆给兜底用。
        let spare = null;
        if (typeof Request !== 'undefined' && input instanceof Request) {
            try {
                spare = input.clone();
            } catch {
                spare = null;
            }
        }
        try {
            return await originalFetch.call(window, input, init);
        } catch (error) {
            const rescued = await rescueThroughBackend(spare ?? input, init, error);
            if (rescued) return rescued;
            throw error;
        }
    })();
}

/**
 * 读取 XHR 的请求体。
 * @param {Document|BodyInit|null|undefined} body 请求体
 * @returns {Promise<Uint8Array|null>} 字节
 */
async function readXhrBody(body) {
    if (body === undefined || body === null) return null;
    if (typeof body === 'string') return new TextEncoder().encode(body);
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        return new TextEncoder().encode(body.toString());
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
    if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
    if (ArrayBuffer.isView(body)) {
        const view = /** @type {ArrayBufferView} */ (body);
        return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
        return new Uint8Array(await new Response(body).arrayBuffer());
    }
    return null;
}

/**
 * 安装转发层（fetch + XMLHttpRequest）。
 * @returns {void}
 */
export function installInterception() {
    if (installed) return;
    originalFetch = window.fetch;
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;
    const nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    originalOpen = nativeOpen;
    originalSend = nativeSend;
    originalSetRequestHeader = nativeSetRequestHeader;

    window.fetch = f2bFetch;

    XMLHttpRequest.prototype.open = function patchedOpen(method, url, async = true, user, password) {
        try {
            xhrInfo.set(this, {
                method: String(method || 'GET').toUpperCase(),
                url: String(url),
                headers: {},
                async: async !== false,
            });
        } catch {
            // 记录失败时退化为不拦截。
        }
        return nativeOpen.call(this, method, url, async, user, password);
    };

    XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
        const info = xhrInfo.get(this);
        if (info) {
            try {
                info.headers[String(name).toLowerCase()] = String(value);
            } catch {
                // 忽略。
            }
        }
        return nativeSetRequestHeader.call(this, name, value);
    };

    XMLHttpRequest.prototype.send = function patchedSend(body) {
        const info = xhrInfo.get(this);
        if (!info || !info.async) return nativeSend.call(this, body);
        const url = httpUrlOf(info.url);
        if (!url) return nativeSend.call(this, body);
        const route = matchRoute({ url, method: info.method, headers: info.headers });
        if (!route) {
            captureFailedXhr(this, info, url);
            return nativeSend.call(this, body);
        }

        const xhr = this;
        const restore = {
            timeout: xhr.timeout,
            withCredentials: xhr.withCredentials,
            responseType: xhr.responseType,
        };
        (async () => {
            let bytes = null;
            try {
                bytes = await readXhrBody(body);
            } catch (error) {
                console.warn('[f2b] 读取 XHR 请求体失败，回退为前端直连：', error?.message ?? error);
                nativeSend.call(xhr, body);
                return;
            }
            if (bytes && bytes.byteLength > MAX_BODY_BYTES) {
                nativeSend.call(xhr, body);
                return;
            }
            if (typeof FormData !== 'undefined' && body instanceof FormData) {
                // FormData 的 content-type（含 boundary）是浏览器在 send 时才生成的，这里补回去。
                const hint = new Response(body).headers.get('content-type');
                if (hint) info.headers['content-type'] = hint;
            }
            const payload = buildProxyPayload({ url, method: info.method, headers: info.headers, bytes, route });
            if (v1StrippedKeys.has(v1KeyOf(route))) {
                const fixed = stripV1Path(payload.url);
                if (fixed) payload.url = fixed;
            }
            try {
                nativeOpen.call(xhr, 'POST', PLUGIN_BASE + '/proxy', true);
                xhr.timeout = restore.timeout;
                xhr.withCredentials = restore.withCredentials;
                xhr.responseType = restore.responseType;
                const headers = getRequestHeaders();
                for (const [name, value] of Object.entries(headers)) {
                    nativeSetRequestHeader.call(xhr, name, String(value));
                }
                stats.forwarded++;
                stats.lastAt = Date.now();
                stats.lastUrl = info.url;
                stats.lastCfgId = route.cfgId;
                nativeSend.call(xhr, JSON.stringify(payload));
            } catch (error) {
                // 已经把 xhr 切成“发往转发接口”了，此时再发原始 body 只会得到 400，
                // 所以尽最大努力把转发请求发出去。
                console.warn('[f2b] XHR 转发失败：', error?.message ?? error);
                stats.failed++;
                try {
                    nativeSend.call(xhr, JSON.stringify(payload));
                } catch (inner) {
                    console.warn('[f2b] XHR 回退也失败，放弃本次转发：', inner?.message ?? inner);
                }
            }
        })();
        return undefined;
    };

    installed = true;
    console.debug('[f2b] 请求转发层已安装');
}

/**
 * 卸载转发层。
 * @returns {void}
 */
export function uninstallInterception() {
    if (!installed) return;
    if (originalFetch) window.fetch = originalFetch;
    if (originalOpen) XMLHttpRequest.prototype.open = originalOpen;
    if (originalSend) XMLHttpRequest.prototype.send = originalSend;
    if (originalSetRequestHeader) XMLHttpRequest.prototype.setRequestHeader = originalSetRequestHeader;
    installed = false;
}

/** 已经接管过 fetch / XMLHttpRequest 的窗口（含 iframe）。 */
const adoptedWindows = new WeakSet();
/** 已经挂过 MutationObserver 的 document。 */
const observedDocs = new WeakSet();
/** 已经接过管（并挂好 load 监听）的帧元素，避免定期补扫时重复挂监听。 */
const adoptedFrames = new WeakSet();
/** 累计接管了多少个窗口（含顶层）。 */
let adoptedTotal = 0;

/**
 * 接管一个窗口的 fetch / XMLHttpRequest。
 * 「小手机」这类卡片内 HTML 界面跑在同源 iframe（blob: / srcdoc）里，顶层 window 上的补丁
 * 看不到它的请求，必须逐个窗口接管；否则它的请求仍然走浏览器直连，被 CORS 拦掉，
 * 表现就是"获取模型失败 / 生成失败"。
 * @param {Window} win 目标窗口
 * @returns {boolean} 是否接管成功
 */
function adoptWindow(win) {
    if (!win || adoptedWindows.has(win)) return false;
    try {
        if (typeof win.fetch !== 'function') return false;
    } catch {
        return false;
    }
    adoptedWindows.add(win);
    try {
        win.fetch = f2bFetch;
    } catch {
        return false;
    }
    try {
        win.XMLHttpRequest = XMLHttpRequest;
    } catch {
        // 个别窗口不让改构造器，fetch 接管住就够了。
    }
    adoptedTotal++;
    return true;
}

/**
 * 接管一个 iframe：先接管当前窗口，再监听 load 事件。
 * blob: / srcdoc 文档是异步解析的，脚本可能比我们更早发请求，所以短时间内补几次。
 * @param {HTMLIFrameElement|HTMLFrameElement} frame 帧元素
 * @returns {void}
 */
function adoptFrameElement(frame) {
    if (!frame || adoptedFrames.has(frame)) return;
    adoptedFrames.add(frame);
    const adopt = () => {
        try {
            const win = frame.contentWindow;
            if (!win) return;
            adoptWindow(win);
            try {
                adoptFramesIn(win.document);
            } catch {
                // 跨域帧读不到 document，忽略。
            }
        } catch {
            // 跨域帧连 contentWindow 都读不到，忽略。
        }
    };
    adopt();
    try {
        frame.addEventListener('load', adopt);
    } catch {
        // 忽略。
    }
    setTimeout(adopt, 0);
    setTimeout(adopt, 150);
    setTimeout(adopt, 800);
}

/**
 * 递归接管一个 document 里的所有帧，并监听后续新增的帧。
 * @param {Document|null} doc 文档
 * @returns {void}
 */
function adoptFramesIn(doc) {
    if (!doc) return;
    let frames = [];
    try {
        frames = Array.from(doc.querySelectorAll('iframe, frame'));
    } catch {
        return;
    }
    for (const frame of frames) adoptFrameElement(frame);
    observeFrameDoc(doc);
}

/**
 * 监听某个文档里新增的 iframe / frame。
 * @param {Document|null} doc 文档
 * @returns {void}
 */
function observeFrameDoc(doc) {
    if (!doc || observedDocs.has(doc)) return;
    if (typeof MutationObserver !== 'function') return;
    observedDocs.add(doc);
    try {
        const observer = new MutationObserver((records) => {
            for (const record of records) {
                const added = record.addedNodes || [];
                for (const node of added) {
                    if (!node || node.nodeType !== 1) continue;
                    const name = String(node.tagName || '').toUpperCase();
                    if (name === 'IFRAME' || name === 'FRAME') {
                        adoptFrameElement(node);
                    } else if (typeof node.querySelectorAll === 'function') {
                        for (const inner of node.querySelectorAll('iframe, frame')) adoptFrameElement(inner);
                    }
                }
            }
        });
        observer.observe(doc.documentElement || doc, { childList: true, subtree: true });
    } catch {
        // 观察失败不致命：adoptAllFrames() 会被定期再调用一次。
    }
}

/**
 * 重新扫一遍现有的所有 iframe 并接管（可重复调用，已接管过的窗口会跳过）。
 * @returns {number} 累计接管的窗口数
 */
export function adoptAllFrames() {
    try {
        adoptFramesIn(document);
    } catch {
        // 忽略。
    }
    return adoptedTotal;
}

/**
 * 安装 iframe 接管。卡片内界面（如小手机）都跑在同源 iframe 里，
 * 不接管的话它们的请求根本不会经过转发层。
 * @returns {number} 累计接管的窗口数
 */
export function installFrameInterception() {
    return adoptAllFrames();
}

