/**
 * f2b — 通用工具函数（无外部依赖）。
 * 全部为纯函数，方便在 UI、探测器与转发层之间共享。
 */

/**
 * HTML 转义，任何用户/插件来源的字符串进入 innerHTML 前都必须经过这里。
 * @param {unknown} value 任意值
 * @returns {string} 转义后的字符串
 */
export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 稳定哈希（FNV-1a 32 位），用于由“来源标识”生成固定的 cfgId。
 * 同一来源每次扫描都会得到同一个 id，因此配置不会被重复创建。
 * @param {string} input 输入字符串
 * @returns {string} 8 位十六进制字符串
 */
export function hashString(input) {
    let hash = 0x811c9dc5;
    const text = String(input ?? '');
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/**
 * 防抖。
 * @param {Function} fn 目标函数
 * @param {number} wait 等待毫秒
 * @returns {Function} 包装后的函数
 */
export function debounce(fn, wait = 300) {
    let timer = null;
    return function debounced(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), wait);
    };
}

/**
 * 判断是否为普通对象（排除数组 / null）。
 * @param {unknown} value 任意值
 * @returns {boolean} 是否为普通对象
 */
export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 安全解析 URL。
 * @param {unknown} raw 原始地址
 * @param {string} [fallbackBase] 相对地址的基准
 * @returns {URL|null} URL 或 null
 */
export function tryUrl(raw, fallbackBase = undefined) {
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!text || /\s/.test(text)) return null;
    try {
        const url = fallbackBase ? new URL(text, fallbackBase) : new URL(text);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return url;
    } catch {
        return null;
    }
}

/**
 * 把插件里常见的“省略协议”的接口地址补全成合法 URL。
 * @param {unknown} raw 原始地址
 * @returns {string} 规范化后的地址（无法识别时返回空串）
 */
export function normalizeEndpoint(raw) {
    if (typeof raw !== 'string') return '';
    const text = raw.trim();
    if (!text || /\s/.test(text)) return '';
    if (/^https?:\/\//i.test(text)) {
        const url = tryUrl(text);
        return url ? url.href : '';
    }
    // 允许 api.example.com/v1 这类写法，但不能是明显的非地址文本。
    if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(text)) {
        const url = tryUrl(`https://${text}`);
        return url ? url.href : '';
    }
    return '';
}

/**
 * 拆出用于匹配前端请求的 origin / 路径前缀。
 * @param {unknown} raw 基础地址
 * @returns {{origin: string, pathPrefix: string, href: string}|null} 解析结果
 */
export function parseBase(raw) {
    const href = normalizeEndpoint(raw);
    const url = href ? tryUrl(href) : null;
    if (!url) return null;
    return {
        origin: url.origin,
        pathPrefix: url.pathname.replace(/\/+$/, ''),
        href: url.href,
    };
}

/**
 * 把完整请求地址裁剪成“相对 base 的部分”，交给后端插件拼接 baseUrl。
 * 后端插件的 /proxy 会在 `target.baseUrl` 非空时用“baseUrl + 原始 path”重建地址，
 * 因此这里必须先去掉 base 的路径前缀，否则会出现 /api/v3/api/v3 这样的重复。
 * @param {string} originalUrl 前端真实请求地址
 * @param {string} baseUrl 配置里的接口地址
 * @returns {string} 交给后端的地址
 */
export function toBackendUrl(originalUrl, baseUrl) {
    const target = tryUrl(originalUrl, window.location.href);
    const base = parseBase(baseUrl);
    if (!target || !base) return originalUrl;
    if (target.origin !== base.origin) return originalUrl;
    if (base.pathPrefix && !target.pathname.startsWith(base.pathPrefix)) return originalUrl;
    const rest = target.pathname.slice(base.pathPrefix.length) || '/';
    return `${target.origin}${rest}${target.search}`;
}

/** 形如 v1 / v3 / v1beta / v2.1 的“版本段”。 */
const VERSION_SEGMENT = /^v\d+([._-]?\d+)*([a-z]+)?$/i;

/**
 * 去掉路径里“重复的版本段”。
 * 人物卡脚本常把 /v1 硬拼在用户填的地址后面，于是请求变成 …/api/coding/v3/v1/models，
 * 反推基础地址时会得到 …/api/coding/v3/v1（多一层）。这里把相邻重复的版本段去掉一个。
 * @param {string[]} segments 路径段
 * @returns {string[]} 处理后的路径段
 */
function dropDuplicateVersion(segments) {
    const parts = [...segments];
    while (parts.length >= 2 && VERSION_SEGMENT.test(parts[parts.length - 1]) && VERSION_SEGMENT.test(parts[parts.length - 2])) {
        parts.pop();
    }
    return parts;
}

/**
 * 清理基础地址里重复的版本段：…/api/coding/v3/v1 → …/api/coding/v3。
 * 只处理“相邻两段都是版本号”的情况，所以 https://api.openai.com/v1 这类正常地址不受影响。
 * @param {string} raw 基础地址
 * @returns {string} 清理后的地址（无法解析时原样返回）
 */
export function dedupeApiBase(raw) {
    if (typeof raw !== 'string') return '';
    const base = parseBase(raw);
    if (!base) return raw;
    const segments = dropDuplicateVersion(base.pathPrefix.split('/').filter(Boolean));
    if (segments.length === 0) return base.origin;
    return `${base.origin}/${segments.join('/')}`;
}

/** 常见的端点尾巴：反推基础地址时从路径末尾剥掉。 */
const ENDPOINT_TAIL_SEGMENT = /^(chat|completions|completion|models|model|messages|message|embeddings|embedding|rerank|images|image|generations|generation|responses|response|audio|speech|transcriptions|translations|moderations|batches|files|predictions|invocations|generate)$/i;

/**
 * 由一次实际请求地址反推“基础地址”（origin + 版本/接口前缀）。
 * https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions → https://ark.cn-beijing.volces.com/api/coding/v3
 * @param {string} href 请求地址
 * @param {number} [maxSegments] 最多保留几段路径
 * @returns {string} 基础地址（无法解析时返回空串）
 */
export function apiBaseOf(href, maxSegments = 4) {
    const url = tryUrl(href);
    if (!url) return '';
    let parts = url.pathname.split('/').filter(Boolean);
    while (parts.length > 0 && ENDPOINT_TAIL_SEGMENT.test(parts[parts.length - 1])) parts = parts.slice(0, -1);
    // 前端硬拼 /v1 时会出现 …/v3/v1/models，基础地址不该把那一层 /v1 带进来。
    parts = dropDuplicateVersion(parts).slice(0, maxSegments);
    return parts.length ? `${url.origin}/${parts.join('/')}` : url.origin;
}

/**
 * 由接口地址推导模型列表地址（OpenAI 兼容约定）。
 * @param {string} baseUrl 接口地址
 * @returns {string} /models 地址
 */
export function modelsUrlOf(baseUrl) {
    const base = parseBase(baseUrl);
    if (!base) return '';
    let path = base.pathPrefix;
    if (/\/chat\/completions$/i.test(path)) path = path.slice(0, -'/chat/completions'.length);
    if (!/\/models$/i.test(path)) path = `${path}/models`;
    return `${base.origin}${path}`;
}

/**
 * 由接口地址推导一次“连通性探测”地址：
 * 优先 /models；有的服务只支持 /chat/completions 或裸地址，交给调用方按状态码回退。
 * @param {string} baseUrl 接口地址
 * @returns {string} 探测地址
 */
export function probeUrlOf(baseUrl) {
    return modelsUrlOf(baseUrl) || normalizeEndpoint(baseUrl);
}

/**
 * 记录密钥指纹（只保留首尾若干字符），用于前端“是否已经有 key”的提示与头部匹配。
 * @param {unknown} key 密钥
 * @returns {{head: string, tail: string, length: number}|null} 指纹
 */
export function keyHintOf(key) {
    if (typeof key !== 'string' || key.length < 6) return null;
    return {
        head: key.slice(0, 3),
        tail: key.slice(-4),
        length: key.length,
    };
}

/**
 * 头部里的密钥是否符合指纹。
 * @param {{head: string, tail: string, length: number}} hint 指纹
 * @param {string} value 头部值（可能是 "Bearer sk-xxx"）
 * @returns {boolean} 是否匹配
 */
export function matchesKeyHint(hint, value) {
    if (!hint || typeof value !== 'string') return false;
    const token = value.replace(/^\s*(bearer|token|basic)\s+/i, '').trim();
    if (!token) return false;
    if (token.length !== hint.length) return false;
    return token.startsWith(hint.head) && token.endsWith(hint.tail);
}

/**
 * 字节数组 → base64（分块处理，避免超长参数导致调用栈溢出）。
 * @param {Uint8Array} bytes 字节
 * @returns {string} base64 字符串
 */
export function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return btoa(binary);
}

/**
 * 数值裁剪。
 * @param {number} value 值
 * @param {number} min 最小值
 * @param {number} max 最大值
 * @returns {number} 裁剪结果
 */
export function clamp(value, min, max) {
    return Math.min(Math.max(Number.isFinite(value) ? value : min, min), max);
}

/**
 * 人类可读的耗时。
 * @param {number} ms 毫秒
 * @returns {string} 文本
 */
export function formatMs(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return '-';
    return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}

/**
 * 深度遍历对象，回调里给出路径、键与值。带节点数与深度上限，绝不因脏数据卡死。
 * @param {unknown} root 根对象
 * @param {(info: {path: string, key: string, value: unknown, parent: object|null, depth: number}) => void} visit 访问器
 * @param {object} [options] 选项
 * @param {number} [options.maxDepth] 最大深度
 * @param {number} [options.maxNodes] 最大节点数
 * @returns {void}
 */
export function deepWalk(root, visit, options = {}) {
    const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 6;
    const maxNodes = Number.isFinite(options.maxNodes) ? options.maxNodes : 4000;
    const seen = new WeakSet();
    let nodes = 0;
    /** @type {Array<{value: unknown, path: string, depth: number, parent: object|null}>} */
    const stack = [{ value: root, path: '', depth: 0, parent: null }];
    while (stack.length > 0) {
        const item = stack.pop();
        if (!item || item.depth > maxDepth) continue;
        if (++nodes > maxNodes) return;
        const { value, path, depth, parent } = item;
        if (isPlainObject(value)) {
            if (seen.has(value)) continue;
            seen.add(value);
            for (const [key, child] of Object.entries(value)) {
                const childPath = path ? `${path}.${key}` : key;
                visit({ path: childPath, key, value: child, parent: value, depth });
                if (typeof child === 'object' && child !== null) {
                    stack.push({ value: child, path: childPath, depth: depth + 1, parent: value });
                }
            }
        }
    }
}

/**
 * 只保留字符集安全的自定义头部名/值（CR/LF 一律剔除）。
 * @param {unknown} raw 头部对象
 * @returns {Record<string, string>} 干净的头
 */
export function sanitizeHeadersObject(raw) {
    const out = {};
    if (!isPlainObject(raw)) return out;
    for (const [key, value] of Object.entries(raw)) {
        if (!key || typeof key !== 'string') continue;
        if (typeof value !== 'string' && typeof value !== 'number') continue;
        const name = key.trim().toLowerCase();
        if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;
        out[name] = String(value).replace(/[\r\n]+/g, ' ').trim();
    }
    return out;
}

/**
 * 解析 JSON 文本，失败返回 fallback。
 * @param {string} text JSON 文本
 * @param {unknown} fallback 兜底值
 * @returns {unknown} 解析结果
 */
export function safeJsonParse(text, fallback = null) {
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}
