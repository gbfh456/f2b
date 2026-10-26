/**
 * f2b-takeover — per-user storage.
 *
 * Layout (relative to `request.user.directories.root`):
 *   f2b-takeover/config.json   → non-secret config, keyed by cfgId
 *   f2b-takeover/secrets.json  → API keys, keyed by cfgId (never leave this process)
 *
 * Plus an in-memory, per-user-handle ring buffer for request metadata logs.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

export const PLUGIN_DIR_NAME = 'f2b-takeover';
export const MAX_LOG_ENTRIES = 200;
const URL_LOG_LIMIT = 300;
/** Query parameter names that look secret-ish and get redacted in logs. */
const SENSITIVE_QUERY = /key|token|secret|password|sig/i;

/** Default target overrides, used for any field a stored entry omits. */
export const DEFAULT_TARGET = Object.freeze({
    baseUrl: '',
    model: '',
    pathRewrite: '',
    authStyle: 'header',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    authQueryName: 'api_key',
    timeoutMs: 600000,
});

/** @type {Map<string, Array<object>>} handle → log entries, newest first */
const logs = new Map();
/** @type {Map<string, Promise<any>>} serializes read-modify-write cycles per storage dir */
const locks = new Map();

/** Never let two writers clobber each other's read-modify-write cycle. */
function withLock(key, fn) {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(key, next.then(() => { }, () => { }));
    return next;
}

/**
 * Resolve the plugin storage directory for a request.
 * @param {object} request Express request carrying `user.directories.root`
 * @returns {string} Absolute plugin storage directory
 */
export function storageDir(request) {
    const root = request?.user?.directories?.root;
    if (typeof root !== 'string' || root.length === 0) throw new Error('Missing request.user.directories.root');
    return path.join(root, PLUGIN_DIR_NAME);
}

/**
 * Short key fingerprint, e.g. `sk-…cdef`. Full keys are never returned to clients.
 * @param {string} key Stored API key
 * @returns {string} Fingerprint, or `…` for short/absent keys
 */
export function keyPreview(key) {
    if (typeof key !== 'string' || key.length === 0) return '';
    return key.length < 8 ? '…' : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/**
 * Coerce arbitrary client input into a safe, fully-populated target object.
 * @param {object} raw Untrusted `target` object
 * @returns {typeof DEFAULT_TARGET} Normalised target
 */
export function normalizeTarget(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const str = (value, fallback) => (typeof value === 'string' ? value : fallback);
    const target = {
        baseUrl: str(src.baseUrl, '').trim(),
        model: str(src.model, '').trim(),
        pathRewrite: str(src.pathRewrite, '').trim(),
        authStyle: src.authStyle === 'query' ? 'query' : 'header',
        authHeader: str(src.authHeader, DEFAULT_TARGET.authHeader).trim() || DEFAULT_TARGET.authHeader,
        authPrefix: str(src.authPrefix, DEFAULT_TARGET.authPrefix),
        authQueryName: str(src.authQueryName, DEFAULT_TARGET.authQueryName).trim() || DEFAULT_TARGET.authQueryName,
        timeoutMs: DEFAULT_TARGET.timeoutMs,
    };
    const ms = Number(src.timeoutMs);
    if (Number.isFinite(ms) && ms > 0) target.timeoutMs = Math.min(Math.floor(ms), 900000);
    return target;
}

/** Only plain scalar→string pairs survive; secrets never belong in here. */
export function normalizeExtraHeaders(raw) {
    const out = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [key, value] of Object.entries(raw)) {
            if (!key) continue;
            if (typeof value === 'string') out[key] = value;
            else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
        }
    }
    return out;
}

const configPath = (dir) => path.join(dir, 'config.json');
const secretsPath = (dir) => path.join(dir, 'secrets.json');

/** Parse a JSON store file; missing/corrupt files degrade to `{}` with a warning. */
async function readJson(file) {
    try {
        const raw = await fsp.readFile(file, 'utf8');
        const parsed = raw.trim() ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        console.warn(`[f2b-takeover] ${path.basename(file)} is not a JSON object, treating as empty.`);
    } catch (error) {
        if (error?.code !== 'ENOENT') console.warn(`[f2b-takeover] Could not read ${file}: ${error?.message}. Treating as empty.`);
    }
    return {};
}

/** Atomic write: `<file>.tmp` then rename, with a best-effort 0600 (no-op on Windows). */
async function writeJson(file, data) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fsp.rename(`${file}.tmp`, file);
    try {
        await fsp.chmod(file, 0o600);
    } catch {
        // Windows and some filesystems do not support chmod — ignore.
    }
}

async function readBoth(dir) {
    return Promise.all([readJson(configPath(dir)), readJson(secretsPath(dir))]);
}

/**
 * All stored entries for a user, secrets reduced to a fingerprint.
 * @param {string} dir Plugin storage directory
 * @returns {Promise<object>} `{ cfgId: { target, extraHeaders, hasKey, keyPreview, updatedAt } }`
 */
export async function listEntries(dir) {
    const [config, secrets] = await readBoth(dir);
    const entries = {};
    for (const [cfgId, value] of Object.entries(config)) {
        const key = typeof secrets[cfgId] === 'string' ? secrets[cfgId] : '';
        entries[cfgId] = {
            target: normalizeTarget(value?.target),
            extraHeaders: normalizeExtraHeaders(value?.extraHeaders),
            hasKey: key.length > 0,
            keyPreview: keyPreview(key),
            updatedAt: Number.isFinite(value?.updatedAt) ? value.updatedAt : 0,
        };
    }
    return entries;
}

/**
 * Resolve everything the proxy needs for one `cfgId`, including the raw secret key.
 * @param {string} dir Plugin storage directory
 * @param {string} cfgId Configuration id
 * @returns {Promise<{target: object, extraHeaders: object, apiKey: string}|null>} Entry, or null
 */
export async function resolveEntry(dir, cfgId) {
    if (!cfgId) return null;
    const [config, secrets] = await readBoth(dir);
    if (!config[cfgId]) return null;
    return {
        target: normalizeTarget(config[cfgId].target),
        extraHeaders: normalizeExtraHeaders(config[cfgId].extraHeaders),
        apiKey: typeof secrets[cfgId] === 'string' ? secrets[cfgId] : '',
    };
}

/**
 * Create, update or delete a config entry.
 * `apiKey === undefined` keeps the stored key; `''` or `delete:true` removes config *and* secret.
 * @param {string} dir Plugin storage directory
 * @param {{cfgId: string, target?: object, extraHeaders?: object, apiKey?: string, delete?: boolean}} input
 * @returns {Promise<{cfgId: string, deleted: boolean, hasKey: boolean, keyPreview: string}>} Result summary
 */
export async function saveEntry(dir, input) {
    const cfgId = String(input.cfgId ?? '').trim();
    if (!cfgId) throw new Error('Missing "cfgId"');
    const remove = input.delete === true || input.apiKey === '';
    return withLock(dir, async () => {
        const [config, secrets] = await readBoth(dir);
        if (remove) {
            delete config[cfgId];
            delete secrets[cfgId];
        } else {
            config[cfgId] = { target: normalizeTarget(input.target), extraHeaders: normalizeExtraHeaders(input.extraHeaders), updatedAt: Date.now() };
            if (typeof input.apiKey === 'string') secrets[cfgId] = input.apiKey;
        }
        await Promise.all([writeJson(configPath(dir), config), writeJson(secretsPath(dir), secrets)]);
        const key = typeof secrets[cfgId] === 'string' ? secrets[cfgId] : '';
        return { cfgId, deleted: remove, hasKey: key.length > 0, keyPreview: keyPreview(key) };
    });
}

/**
 * Redact secret-looking query values, then truncate for logging.
 * @param {string} raw Target URL
 * @returns {string} At most {@link URL_LOG_LIMIT} characters, safe to log
 */
export function redactUrl(raw) {
    let text = typeof raw === 'string' ? raw : '';
    try {
        const url = new URL(text);
        let touched = false;
        for (const name of [...url.searchParams.keys()]) {
            if (SENSITIVE_QUERY.test(name)) {
                url.searchParams.set(name, '***');
                touched = true;
            }
        }
        if (touched) text = url.toString();
    } catch {
        // Not parseable — fall back to a regex pass.
        text = text.replace(/([?&][^=&#]*(?:key|token|secret|password|sig)[^=&#]*=)[^&#]*/gi, '$1***');
    }
    return text.length > URL_LOG_LIMIT ? `${text.slice(0, URL_LOG_LIMIT - 1)}…` : text;
}

/**
 * Append a metadata-only log entry (no bodies, no headers, no keys). Newest first.
 * @param {string} handle User handle
 * @param {object} entry Partial entry; `ts` is filled in here
 * @returns {void}
 */
export function pushLog(handle, entry) {
    const key = handle || 'default';
    if (!logs.has(key)) logs.set(key, []);
    const list = logs.get(key);
    list.unshift({ ts: Date.now(), cfgId: '', label: '', url: '', method: '', status: 0, ms: 0, bytes: 0, error: '', ...entry, url: redactUrl(entry?.url) });
    if (list.length > MAX_LOG_ENTRIES) list.length = MAX_LOG_ENTRIES; // Hard-capped ring buffer.
}

/**
 * Read the newest-first log.
 * @param {string} handle User handle
 * @param {number} [limit] Maximum number of entries
 * @returns {Array<object>} Log entries, newest first
 */
export function getLog(handle, limit = 50) {
    const list = logs.get(handle || 'default') ?? [];
    const size = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : 50;
    return list.slice(0, Math.min(size, MAX_LOG_ENTRIES));
}

/**
 * Drop all log entries for a user handle.
 * @param {string} handle User handle
 * @returns {number} Number of removed entries
 */
export function clearLog(handle) {
    const key = handle || 'default';
    const size = logs.get(key)?.length ?? 0;
    logs.set(key, []);
    return size;
}
