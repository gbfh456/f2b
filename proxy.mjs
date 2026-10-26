/**
 * f2b-takeover — transparent streaming reverse proxy.
 *
 * Outbound traffic deliberately uses `node-fetch` (never the global `fetch`/undici) so requests
 * inherit SillyTavern's SSRF-protecting global agents installed by `src/private-request-filter.js`.
 * Responses are piped with `compress: false` so bytes stay byte-identical and `content-encoding`
 * is preserved for the browser to decode.
 */

import { Buffer } from 'node:buffer';
import nodeFetch from 'node-fetch';
import { pushLog, resolveEntry, storageDir } from './store.mjs';

const DEFAULT_TIMEOUT_MS = 600000;
const MAX_TIMEOUT_MS = 900000;
/** `/test` preview bounds — response bodies are never buffered beyond this. */
const TEST_PREVIEW_BYTES = 64 * 1024;
const TEST_PREVIEW_CHARS = 2000;

/** Hop-by-hop headers dropped in both directions (RFC 7230 §6.1). */
const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** Client headers that must never be forwarded upstream. */
const STRIP_EXACT = new Set([
    ...HOP_BY_HOP,
    'host', 'cookie', 'referer', 'referrer', 'origin', 'x-csrf-token', 'content-length', 'accept-encoding',
]);
const STRIP_PREFIXES = ['sec-', 'x-forwarded-'];

/** Methods that must not carry a request body (node-fetch throws otherwise). */
const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

/** Invalid input or stored config (e.g. an unparseable baseUrl) → 400 with a stable code. */
class ProxyError extends Error {
    constructor(message, status, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

/**
 * Send a JSON error response, unless headers already went out.
 * @param {import('express').Response} res Express response
 * @param {number} status HTTP status
 * @param {string} error Human readable message
 * @param {string} [code] Stable machine code
 * @returns {void}
 */
export function fail(res, status, error, code) {
    if (res.headersSent) {
        try { res.end(); } catch { /* already dying */ }
        return;
    }
    const payload = { ok: false, error: String(error ?? 'Unknown error') };
    if (code) payload.code = String(code);
    try {
        res.status(status).json(payload);
    } catch {
        try { res.end(); } catch { /* already dying */ }
    }
}

/** Most useful error code from a node-fetch / Node system error, e.g. `ENOTFOUND`. */
function errorCode(error) {
    for (const candidate of [error?.code, error?.cause?.code, error?.errno, error?.erroredSysCall]) {
        if (typeof candidate === 'string' && /^[A-Z][A-Z0-9_]+$/.test(candidate)) return candidate;
    }
    const match = /\b(E[A-Z]{3,}|CERT_[A-Z_]+)\b/.exec(String(error?.message ?? ''));
    return match ? match[1] : 'UPSTREAM_ERROR';
}

/** Readable one-liner for a failed outbound request. */
function errorMessage(error) {
    const message = String(error?.message ?? error ?? 'Upstream request failed');
    return message.length > 400 ? `${message.slice(0, 400)}…` : message;
}

/** True when the target would loop back into this very SillyTavern instance. */
function isCircular(req, target) {
    const host = String(req.get?.('host') ?? '');
    if (!host) return false;
    const protocol = req.protocol || 'http';
    if (target.origin === `${protocol}://${host}`) return true;

    const selfPort = host.includes(':') ? host.slice(host.lastIndexOf(':') + 1) : (protocol === 'https' ? '443' : '80');
    const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80');
    if (targetPort !== selfPort) return false;
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(target.hostname.toLowerCase());
}

/** Validate the client-supplied target URL; only http/https is allowed. */
function parseTargetUrl(rawUrl) {
    let target;
    try {
        target = new URL(rawUrl);
    } catch {
        throw new ProxyError('Invalid "url"', 400, 'BAD_URL');
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new ProxyError('Only http/https URLs are allowed', 400, 'BAD_PROTOCOL');
    }
    return target;
}

/** Normalise an HTTP method, defaulting to POST. */
function parseMethod(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return 'POST';
    const method = raw.trim().toUpperCase();
    return /^[A-Z]+$/.test(method) ? method : 'POST';
}

/**
 * Lowercase headers and drop everything forbidden. Applied twice: before and after merging the
 * stored `extraHeaders`, so a stored header cannot smuggle one back in.
 * @param {object} headers Raw header map
 * @returns {Record<string,string>} Sanitised copy
 */
function sanitizeHeaders(headers) {
    const out = {};
    if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
        for (const [key, value] of Object.entries(headers)) {
            if (!key) continue;
            if (typeof value !== 'string' && typeof value !== 'number') continue;
            // Drop CR/LF so a crafted header cannot inject extra header lines.
            out[key.toLowerCase()] = String(value).replace(/[\r\n]+/g, ' ');
        }
    }
    for (const key of Object.keys(out)) {
        if (STRIP_EXACT.has(key) || STRIP_PREFIXES.some(prefix => key.startsWith(prefix))) delete out[key];
    }
    return out;
}

/** Decode the client body according to `bodyEncoding` (`none` by default). */
function decodeBody(body) {
    const encoding = body?.bodyEncoding === 'base64' ? 'base64' : body?.bodyEncoding === 'text' ? 'text' : 'none';
    const raw = body?.body;
    if (encoding === 'none' || typeof raw !== 'string' || raw.length === 0) return undefined;
    return Buffer.from(raw, encoding === 'base64' ? 'base64' : 'utf8');
}

/** Rewrite a JSON body's top-level `model`; non-JSON bodies pass through untouched. */
function injectModel(buffer, model) {
    if (!buffer || !model) return buffer;
    let parsed;
    try {
        parsed = JSON.parse(buffer.toString('utf8'));
    } catch {
        return buffer;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return buffer;
    parsed.model = model;
    return Buffer.from(JSON.stringify(parsed), 'utf8');
}

/**
 * Apply the stored `baseUrl` + `pathRewrite` overrides.
 * An empty `pathRewrite` (default) keeps the original path+search appended to `baseUrl`;
 * a non-empty one replaces the original path (its query string is kept).
 */
function applyBaseUrl(target, cfgTarget) {
    const baseUrl = String(cfgTarget?.baseUrl ?? '').trim();
    if (!baseUrl) return target;
    let base;
    try {
        base = new URL(baseUrl);
    } catch {
        throw new ProxyError('Stored "target.baseUrl" is not a valid URL', 400, 'BAD_CONFIG');
    }
    const prefix = `${base.origin}${base.pathname}`.replace(/\/+$/, '');
    const rewrite = String(cfgTarget?.pathRewrite ?? '').trim();
    const suffix = rewrite
        ? `${(rewrite.startsWith('/') ? rewrite : `/${rewrite}`).replace(/\/+$/, '')}${target.search}`
        : target.pathname + target.search;
    const next = new URL(`${prefix}${suffix}` || prefix);
    // Keep query parameters declared on the base URL (e.g. azure `api-version`) unless already set.
    for (const [key, value] of base.searchParams) {
        if (!next.searchParams.has(key)) next.searchParams.append(key, value);
    }
    return next;
}

/**
 * Assemble the final outbound request from the client body plus stored overrides, in contract order:
 * baseUrl → model → extraHeaders → server-side auth.
 * @param {object} reqBody Client request body
 * @param {{target: object, extraHeaders: object, apiKey: string}|null} cfg Stored entry
 * @returns {{url: URL, method: string, headers: Record<string,string>, body: Buffer|undefined, ms: number}}
 */
function prepareRequest(reqBody, cfg) {
    const original = parseTargetUrl(String(reqBody.url ?? '').trim());
    const target = cfg ? applyBaseUrl(original, cfg.target) : original;
    const method = parseMethod(reqBody.method);
    const headers = sanitizeHeaders(reqBody.headers);
    let buffer = decodeBody(reqBody);

    if (cfg) {
        if (cfg.target?.model) buffer = injectModel(buffer, cfg.target.model);
        for (const [key, value] of Object.entries(cfg.extraHeaders ?? {})) headers[key.toLowerCase()] = value;
        const apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey : '';
        if (cfg.target?.authStyle === 'query') {
            if (apiKey) target.searchParams.set(cfg.target.authQueryName, apiKey);
            delete headers[cfg.target.authHeader]; // Never leave a stale client credential behind.
        } else if (apiKey) {
            headers[cfg.target.authHeader] = `${cfg.target.authPrefix}${apiKey}`; // Overrides the client value.
        }
    }

    const finalHeaders = sanitizeHeaders(headers); // Strip again: extraHeaders could reintroduce one.
    finalHeaders['accept-encoding'] = 'gzip, deflate, br';

    const requested = Number(reqBody.timeoutMs);
    const stored = Number(cfg?.target?.timeoutMs);
    const fallback = Number.isFinite(requested) && requested > 0 ? requested : (Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_TIMEOUT_MS);

    return {
        url: target,
        method,
        headers: finalHeaders,
        body: BODYLESS_METHODS.has(method) ? undefined : buffer,
        ms: Math.min(Math.floor(fallback), MAX_TIMEOUT_MS),
    };
}

/** Log context shared by both handlers (never contains credentials). */
function contextOf(req) {
    return {
        handle: req.user?.handle ?? 'default',
        cfgId: typeof req.body?.cfgId === 'string' ? req.body.cfgId : '',
        label: typeof req.body?.label === 'string' ? req.body.label : '',
    };
}

/** Load the stored override entry for `cfgId`, when one is requested. */
async function loadEntry(req, cfgId) {
    if (!cfgId) return null;
    try {
        return await resolveEntry(storageDir(req), cfgId);
    } catch (error) {
        console.warn(`[f2b-takeover] Could not load cfgId "${cfgId}": ${error?.message}`);
        return null;
    }
}

/**
 * POST /proxy — stream an upstream response back to the client untouched.
 * @param {import('express').Request} req Express request
 * @param {import('express').Response} res Express response
 * @returns {Promise<void>} Resolves once the response has been fully handled
 */
export async function handleProxy(req, res) {
    const started = Date.now();
    const ctx = contextOf(req);
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    let url = String(body.url ?? '');
    let method = parseMethod(body.method);
    let status = 0;
    let bytes = 0;
    let errorText = '';
    const done = () => pushLog(ctx.handle, {
        cfgId: ctx.cfgId, label: ctx.label, url, method, status, ms: Date.now() - started, bytes, error: errorText,
    });

    try {
        if (typeof body.url !== 'string' || !body.url.trim()) {
            errorText = 'Missing "url"';
            done();
            return fail(res, 400, errorText, 'BAD_URL');
        }

        const cfg = await loadEntry(req, ctx.cfgId);
        const prepared = prepareRequest(body, cfg);
        url = prepared.url.toString();
        method = prepared.method;

        // The client may have pointed straight back at this server.
        if (isCircular(req, parseTargetUrl(String(body.url).trim())) || isCircular(req, prepared.url)) {
            errorText = 'Circular request to this SillyTavern server';
            done();
            return fail(res, 400, errorText, 'CIRCULAR');
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), prepared.ms);
        let upstream;
        try {
            upstream = await nodeFetch(url, {
                method,
                headers: prepared.headers,
                body: prepared.body,
                redirect: 'follow',
                compress: false, // Keep bytes byte-identical (preserve content-encoding).
                signal: controller.signal,
            });
        } catch (error) {
            clearTimeout(timer);
            if (controller.signal.aborted || error?.name === 'AbortError') {
                errorText = `Upstream request timed out after ${prepared.ms} ms`;
                status = 504;
                done();
                return fail(res, 504, errorText, 'TIMEOUT');
            }
            errorText = errorMessage(error);
            status = 502;
            done();
            return fail(res, 502, errorText, errorCode(error));
        }

        status = upstream.status;
        res.statusCode = upstream.status;
        try { res.statusMessage = upstream.statusText; } catch { /* invalid status text — keep default */ }

        const copied = [];
        for (const [name, values] of Object.entries(upstream.headers.raw())) {
            if (HOP_BY_HOP.has(name.toLowerCase())) continue;
            res.setHeader(name, values.length === 1 ? values[0] : values);
            copied.push(name);
        }
        // Disables SillyTavern's global compression() for this response, so SSE is not buffered.
        res.setHeader('Cache-Control', 'no-transform');
        if (!res.getHeader('X-Accel-Buffering')) res.setHeader('X-Accel-Buffering', 'no');

        await new Promise((resolve) => {
            const source = upstream.body;
            let settled = false;
            const finish = () => { if (!settled) { settled = true; res.off('close', onClose); resolve(); } };
            function onClose() {
                try { source?.destroy?.(); } catch { /* already closed */ }
                finish();
            }
            res.on('close', onClose);
            if (!source) {
                clearTimeout(timer);
                res.end();
                return finish();
            }
            source.on('data', (chunk) => {
                bytes += chunk.length;
                if (!res.write(chunk)) {
                    source.pause();
                    res.once('drain', () => source.resume());
                }
                try { res.flush?.(); } catch { /* compression disabled, no flush needed */ }
            });
            source.on('end', () => {
                clearTimeout(timer);
                try { res.end(); } catch { /* client already gone */ }
                finish();
            });
            source.on('error', (error) => {
                clearTimeout(timer);
                errorText = errorMessage(error);
                if (res.headersSent) {
                    try { res.end(); } catch { /* client already gone */ }
                } else {
                    for (const name of copied) res.removeHeader(name);
                    fail(res, 502, errorText, errorCode(error));
                }
                finish();
            });
        });

        done();
    } catch (error) {
        errorText = errorMessage(error);
        status = error instanceof ProxyError ? error.status : 502;
        if (!(error instanceof ProxyError)) console.error(`[f2b-takeover] /proxy failed: ${errorText}`);
        done();
        return fail(res, status, errorText, errorCode(error));
    }
}

/** Read at most 64 KB, decode as UTF-8 and truncate to the preview length. */
async function readPreview(upstream) {
    const source = upstream.body;
    if (!source) return { preview: '', truncated: false };
    const chunks = [];
    let size = 0;
    let capped = false;
    await new Promise((resolve) => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(); } };
        const stop = () => {
            capped = true;
            try { source.destroy(); } catch { /* ignore */ }
            finish();
        };
        source.on('data', (chunk) => {
            const room = TEST_PREVIEW_BYTES - size;
            if (room <= 0) return stop();
            chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
            size += Math.min(chunk.length, room);
            if (size >= TEST_PREVIEW_BYTES) stop();
        });
        source.on('end', finish);
        source.on('error', finish);
    });
    const text = Buffer.concat(chunks).toString('utf8');
    return { preview: text.slice(0, TEST_PREVIEW_CHARS), truncated: capped || text.length > TEST_PREVIEW_CHARS };
}

/**
 * POST /test — server-side connectivity probe. Always answers HTTP 200.
 * Uses `compress: true` (unlike /proxy) so a compressed body can be previewed as text.
 * @param {import('express').Request} req Express request
 * @param {import('express').Response} res Express response
 * @returns {Promise<void>} Resolves once the response has been sent
 */
export async function handleTest(req, res) {
    const started = Date.now();
    const ctx = contextOf(req);
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const elapsed = () => Date.now() - started;
    const bail = (message, code) => res.status(200).json({ ok: false, error: message, code, ms: elapsed() });
    let url = String(body.url ?? '');
    let method = 'GET';
    let status = 0;
    let errorText = '';
    const done = () => pushLog(ctx.handle, {
        cfgId: ctx.cfgId, label: ctx.label, url, method, status, ms: elapsed(), bytes: 0, error: errorText,
    });

    try {
        if (typeof body.url !== 'string' || !body.url.trim()) {
            errorText = 'Missing "url"';
            done();
            return bail(errorText, 'BAD_URL');
        }
        const cfg = await loadEntry(req, ctx.cfgId);
        const prepared = prepareRequest({ ...body, method: body.method ?? 'GET' }, cfg);
        url = prepared.url.toString();
        method = prepared.method;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), prepared.ms);
        try {
            const upstream = await nodeFetch(url, {
                method,
                headers: { ...prepared.headers, accept: 'text/plain, application/json, */*' },
                body: prepared.body,
                redirect: 'follow',
                compress: true, // /test previews text, so let node-fetch decompress.
                signal: controller.signal,
            });
            status = upstream.status;
            const { preview, truncated } = await readPreview(upstream);
            clearTimeout(timer);
            done();
            return res.status(200).json({
                ok: true,
                status: upstream.status,
                statusText: upstream.statusText,
                ms: elapsed(),
                headers: { 'content-type': upstream.headers.get('content-type') ?? '' },
                preview,
                truncated,
                authError: upstream.status === 401 || upstream.status === 403,
            });
        } catch (error) {
            clearTimeout(timer);
            errorText = (controller.signal.aborted || error?.name === 'AbortError')
                ? `Request timed out after ${prepared.ms} ms`
                : errorMessage(error);
            done();
            return bail(errorText, controller.signal.aborted || error?.name === 'AbortError' ? 'TIMEOUT' : errorCode(error));
        }
    } catch (error) {
        // Never throw: /test always answers 200 with a structured result.
        errorText = errorMessage(error);
        done();
        return bail(errorText, error instanceof ProxyError ? error.code : errorCode(error));
    }
}
