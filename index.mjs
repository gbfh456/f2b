/**
 * f2b-takeover — SillyTavern server plugin entry point.
 *
 * 本文件位于仓库根目录，和前端扩展共用同一个仓库（见 README「安装」）：
 *   - 作为前端扩展被克隆到 public/scripts/extensions/third-party/f2b/ 时，酒馆只会加载
 *     manifest.json 里的 frontend.js，index.mjs 不会被浏览器请求；
 *   - 作为服务端插件被克隆到 plugins/<任意目录名>/ 时，酒馆的插件加载器按
 *     index.js → index.cjs → index.mjs 的顺序探测，于是加载本文件。
 * 因此两处装的是同一份代码、同一个 commit，不会出现前后端版本不一致。
 *
 * Routes are registered on the injected router, so the effective base path is
 * `/api/plugins/f2b-takeover`. SillyTavern applies `requireLogin` + CSRF before plugin routes,
 * and this plugin additionally requires an admin user on every route.
 *
 * Mounted as: GET /health · POST /proxy · POST /test · GET|POST /config · GET /log · POST /log/clear
 */

import { fail, handleProxy, handleTest } from './proxy.mjs';
import { clearLog, getLog, listEntries, saveEntry, storageDir } from './store.mjs';

const VERSION = '1.1.0';
/** Reject request bodies beyond this size (in characters of the serialized JSON body). */
const MAX_BODY_CHARS = 64 * 1024 * 1024;

/** Plugin metadata consumed by SillyTavern's plugin loader. */
export const info = {
    id: 'f2b-takeover',
    name: 'F2B Takeover',
    description: 'Admin-only transparent streaming reverse proxy for third-party frontends: server-side config/key storage, connectivity tests and metadata-only request logs.',
};

/** 403 unless the caller is an authenticated administrator. */
function requireAdmin(req, res, next) {
    if (req.user?.profile?.admin === true) return next();
    return fail(res, 403, 'Admin privileges are required', 'FORBIDDEN');
}

/** 413 when the JSON body exceeds the cap. Never throws. */
function limitBodySize(req, res, next) {
    try {
        if (req.body !== undefined && req.body !== null) {
            const size = JSON.stringify(req.body)?.length ?? 0;
            if (size > MAX_BODY_CHARS) return fail(res, 413, 'Request body is too large', 'PAYLOAD_TOO_LARGE');
        }
    } catch {
        return fail(res, 400, 'Request body is not valid JSON', 'BAD_BODY');
    }
    return next();
}

/** Wrap a handler so nothing ever escapes into Express' default error handling. */
function guard(handler) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (error) {
            console.error(`[f2b-takeover] ${req.method} ${req.path} failed: ${error?.message}`);
            fail(res, 500, error?.message ?? 'Internal plugin error', 'INTERNAL');
        }
    };
}

/**
 * Register all plugin routes.
 * @param {import('express').Router} router Router injected by SillyTavern
 * @returns {Promise<void>} Resolves once routes are mounted
 */
export async function init(router) {
    router.use(requireAdmin);

    // 1) Health — intentionally allocation-free so it stays cheap.
    router.get('/health', (req, res) => {
        res.status(200).json({
            ok: true,
            id: info.id,
            version: VERSION,
            node: process.version,
            features: { proxy: true, test: true, config: true, log: true },
        });
    });

    // 2) Transparent streaming proxy.
    router.post('/proxy', limitBodySize, guard(handleProxy));

    // 3) Server-side connectivity test (always HTTP 200).
    router.post('/test', limitBodySize, guard(handleTest));

    // 4) Config + secret storage (secrets are never returned, only fingerprinted).
    router.get('/config', guard(async (req, res) => {
        const entries = await listEntries(storageDir(req));
        res.status(200).json({ ok: true, entries });
    }));

    router.post('/config', limitBodySize, guard(async (req, res) => {
        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const cfgId = typeof body.cfgId === 'string' ? body.cfgId.trim() : '';
        if (!cfgId) return fail(res, 400, 'Missing "cfgId"', 'BAD_CFG_ID');

        const result = await saveEntry(storageDir(req), {
            cfgId,
            target: body.target,
            extraHeaders: body.extraHeaders,
            // `undefined` keeps the stored key; `''` deletes the whole entry.
            apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
            delete: body.delete === true,
        });
        res.status(200).json({ ok: true, ...result });
    }));

    // 5) Metadata-only request log (newest first, max 200 entries per user handle).
    router.get('/log', guard((req, res) => {
        const limit = Number.parseInt(String(req.query?.limit ?? '50'), 10);
        res.status(200).json({ ok: true, entries: getLog(req.user?.handle ?? 'default', Number.isFinite(limit) ? limit : 50) });
    }));

    router.post('/log/clear', guard((req, res) => {
        const removed = clearLog(req.user?.handle ?? 'default');
        res.status(200).json({ ok: true, removed });
    }));
}

export default { info, init };
