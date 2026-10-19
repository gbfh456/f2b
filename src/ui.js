/**
 * f2b 界面层：左上角悬浮球 + 可拖动的配置面板。
 *
 * 悬浮球：默认固定在页面左上角（顶栏下方），可拖动，位置写入设置；
 * 面板：点击悬浮球展开，列出所有已转成后端的 API 配置；
 * 每张卡片左上角显示来源（插件 / 人物卡），右上角是删除按钮（删除即回到前端直连），
 * 输入框下方是“保存”和“测试连接”，模型输入框右侧是“拉取模型”。
 */

import { callPopup } from '../../../../../script.js';
import { POPUP_TYPE } from '../../../../popup.js';
import { convertSuggestion, deleteAllEntries, deleteEntry, forgetAllTombstones, forgetTombstone, probeFrontendUsage, restoreTombstone, runScan, saveEntry } from './sync.js';
import { checkBackend, fetchModels, getBackendInfo, isBackendReady, PLUGIN_ID, testConnection } from './backend.js';
import { addTombstone, findEntry, getSettings, getTombstoneInfo, invalidateRoutes, labelOf, saveSettings, upsertEntry } from './store.js';
import { currentCharacter, isExtensionDisabled } from './detect.js';
import { clamp, escapeHtml, formatMs, keyHintOf, modelsUrlOf, normalizeEndpoint, parseBase, probeUrlOf, sanitizeHeadersObject, toBackendUrl } from './util.js';

/** 面板 / 悬浮球的 z-index，必须高于酒馆自身的顶栏与抽屉。 */
const Z_BALL = 4000;
const Z_PANEL = 4001;

/** 每张卡片的临时状态文本，刷新渲染时保留。 */
const cardStatus = new Map();
/** 最近一次扫描得到的“疑似”配置。 */
let lastSuggestions = [];
/** 最近一次扫描里所有见过的 cfgId → 来源信息，用来给已删除/已忽略的配置标出来源。 */
let detectedLabels = {};
/** 面板是否打开。 */
let panelOpen = false;
/** @type {HTMLElement|null} */
let ballEl = null;
/** @type {HTMLElement|null} */
let panelEl = null;
/** @type {boolean} 是否已完成首次挂载 */
let mounted = false;

/**
 * 轻提示。酒馆自带 toastr，不可用时退化为控制台。
 * @param {string} message 文本
 * @param {'info'|'success'|'warning'|'error'} [type] 类型
 * @returns {void}
 */
function notify(message, type = 'info') {
    const toastr = globalThis.toastr;
    if (toastr && typeof toastr[type] === 'function') {
        toastr[type](message, 'F2B');
        return;
    }
    console.log(`[f2b] ${message}`);
}

/**
 * 通用拖拽：把 element 按 handle 拖动，回调里给出新的左上角坐标。
 * @param {HTMLElement} element 被拖动的元素
 * @param {HTMLElement} handle 拖拽把手
 * @param {object} options 选项
 * @param {(x: number, y: number) => void} options.onEnd 拖动结束回调
 * @param {() => void} [options.onClick] 未发生拖动时的点击回调
 * @returns {void}
 */
function makeDraggable(element, handle, { onEnd, onClick = undefined }) {
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let moved = false;
    let active = false;

    handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        // 悬浮球本身就是按钮：只跳过“把手内部真正的交互控件”，否则连拖都拖不动。
        const interactive = event.target instanceof HTMLElement
            ? event.target.closest('button, input, select, textarea, a')
            : null;
        if (interactive && interactive !== handle) return;
        active = true;
        moved = false;
        startX = event.clientX;
        startY = event.clientY;
        const rect = element.getBoundingClientRect();
        originLeft = rect.left;
        originTop = rect.top;
        handle.setPointerCapture?.(event.pointerId);
        element.classList.add('f2b-dragging');
    });

    handle.addEventListener('pointermove', (event) => {
        if (!active) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        event.preventDefault();
        const width = element.offsetWidth;
        const height = element.offsetHeight;
        const x = clamp(originLeft + dx, 0, Math.max(0, window.innerWidth - width));
        const y = clamp(originTop + dy, 0, Math.max(0, window.innerHeight - height));
        element.style.left = `${x}px`;
        element.style.top = `${y}px`;
        element.style.right = 'auto';
        element.style.bottom = 'auto';
    });

    const finish = (event) => {
        if (!active) return;
        active = false;
        handle.releasePointerCapture?.(event.pointerId);
        element.classList.remove('f2b-dragging');
        if (moved) {
            const rect = element.getBoundingClientRect();
            onEnd?.(rect.left, rect.top);
        } else {
            onClick?.();
        }
    };

    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
}

/**
 * 通用缩放：拖动 element 右下角的把手改变宽高，回调里给出新的尺寸。
 * @param {HTMLElement} element 被缩放的元素
 * @param {HTMLElement} handle 右下角把手
 * @param {object} options 选项
 * @param {(w: number, h: number) => void} options.onEnd 缩放结束回调
 * @returns {void}
 */
function makeResizable(element, handle, { onEnd }) {
    const MIN_W = 320;
    const MIN_H = 220;
    let active = false;
    let startX = 0;
    let startY = 0;
    let originW = 0;
    let originH = 0;
    let changed = false;

    handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        active = true;
        changed = false;
        startX = event.clientX;
        startY = event.clientY;
        const rect = element.getBoundingClientRect();
        originW = rect.width;
        originH = rect.height;
        handle.setPointerCapture?.(event.pointerId);
        element.classList.add('f2b-resizing');
    });

    handle.addEventListener('pointermove', (event) => {
        if (!active) return;
        event.preventDefault();
        const rect = element.getBoundingClientRect();
        // 上限跟着窗口走：右下角拖不出视口，左上角仍留在原位。
        const maxW = Math.max(MIN_W, window.innerWidth - rect.left - 8);
        const maxH = Math.max(MIN_H, window.innerHeight - rect.top - 8);
        const width = clamp(originW + (event.clientX - startX), MIN_W, maxW);
        const height = clamp(originH + (event.clientY - startY), MIN_H, maxH);
        element.style.width = `${Math.round(width)}px`;
        element.style.height = `${Math.round(height)}px`;
        element.style.maxHeight = 'none';
        changed = true;
    });

    const finish = (event) => {
        if (!active) return;
        active = false;
        handle.releasePointerCapture?.(event.pointerId);
        element.classList.remove('f2b-resizing');
        if (!changed) return;
        const rect = element.getBoundingClientRect();
        onEnd?.(Math.round(rect.width), Math.round(rect.height));
    };

    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
}
/**
 * 把面板夹回视口内。
 * @returns {void}
 */
function clampPanel() {
    if (!panelEl) return;
    // 窗口变小 / 换过屏幕时，把记住的尺寸收进视口，免得面板伸出屏幕外。
    const rect = panelEl.getBoundingClientRect();
    const maxW = Math.max(320, window.innerWidth - 16);
    const maxH = Math.max(220, window.innerHeight - 16);
    if (rect.width > maxW) panelEl.style.width = `${maxW}px`;
    if (rect.height > maxH) panelEl.style.height = `${maxH}px`;
    const after = panelEl.getBoundingClientRect();
    const x = clamp(after.left, 4, Math.max(4, window.innerWidth - after.width - 4));
    const y = clamp(after.top, 4, Math.max(4, window.innerHeight - after.height - 4));
    panelEl.style.left = `${x}px`;
    panelEl.style.top = `${y}px`;
}

/**
 * 打开面板（定位在悬浮球右侧，越界后自动收进视口）。
 * @returns {void}
 */
function openPanel() {
    if (!panelEl) return;
    panelOpen = true;
    panelEl.classList.add('f2b-panel-open');
    ballEl?.classList.add('f2b-ball-active');
    const settings = getSettings();
    if (Number.isFinite(settings.panel?.x) && Number.isFinite(settings.panel?.y)) {
        panelEl.style.left = `${settings.panel.x}px`;
        panelEl.style.top = `${settings.panel.y}px`;
    } else if (ballEl) {
        const rect = ballEl.getBoundingClientRect();
        panelEl.style.left = `${Math.round(rect.right + 10)}px`;
        panelEl.style.top = `${Math.round(rect.top)}px`;
    }
    // 记住的宽高（拖动右下角调整过才会有值）。
    const width = Number(settings.panel?.w);
    const height = Number(settings.panel?.h);
    panelEl.style.width = Number.isFinite(width) && width > 0 ? `${width}px` : '';
    panelEl.style.height = Number.isFinite(height) && height > 0 ? `${height}px` : '';
    panelEl.style.maxHeight = Number.isFinite(height) && height > 0 ? 'none' : '';
    clampPanel();
    render();
}

/**
 * 关闭面板。
 * @returns {void}
 */
function closePanel() {
    if (!panelEl) return;
    panelOpen = false;
    panelEl.classList.remove('f2b-panel-open');
    ballEl?.classList.remove('f2b-ball-active');
}

/**
 * 切换面板。
 * @returns {void}
 */
function togglePanel() {
    if (panelOpen) closePanel();
    else openPanel();
}

/**
 * 设置悬浮球可见性。
 * @param {boolean} visible 是否可见
 * @returns {void}
 */
export function setBallVisible(visible) {
    const settings = getSettings();
    settings.ball.visible = visible !== false;
    saveSettings();
    if (ballEl) ballEl.style.display = settings.ball.visible ? '' : 'none';
    if (!settings.ball.visible) closePanel();
}

/**
 * 刷新悬浮球上的计数徽标。
 * @returns {void}
 */
function updateBadge() {
    if (!ballEl) return;
    const entries = getSettings().entries.filter(entry => entry.enabled);
    const badge = ballEl.querySelector('.f2b-badge');
    if (!badge) return;
    badge.textContent = String(entries.length);
    badge.style.display = entries.length > 0 ? '' : 'none';
    ballEl.title = `F2B 后端 API 配置：${entries.length} 项（点击展开，拖动可移动）`;
}

/**
 * 右上角“重新扫描”按钮的提示文字。
 * 没打开人物卡时这一轮只扫插件，提示要说清楚，免得用户以为人物卡配置丢了。
 * @returns {string} 提示
 */
function scanButtonTitle() {
    return currentCharacter()
        ? '重新扫描：插件 + 当前打开的人物卡（含这张卡的浏览器存储）'
        : '重新扫描：只扫插件（还没打开人物卡，卡片里的配置要打开后再扫）';
}

/**
 * 后端状态文案。
 * @returns {string} HTML
 */
function backendStatusText() {
    const info = getBackendInfo();
    if (info.state === 'ready') {
        return `<span class="f2b-dot f2b-dot-ok"></span>后端已连接 <span class="f2b-dim">v${escapeHtml(info.version || '?')}</span>`;
    }
    if (info.state === 'missing') {
        return `<span class="f2b-dot f2b-dot-bad"></span>未检测到后端插件 <code>${PLUGIN_ID}</code>`;
    }
    if (info.state === 'forbidden') {
        return '<span class="f2b-dot f2b-dot-bad"></span>需要管理员账号';
    }
    if (info.state === 'error') {
        return `<span class="f2b-dot f2b-dot-bad"></span>后端异常：${escapeHtml(info.error)}`;
    }
    return '<span class="f2b-dot f2b-dot-warn"></span>正在检测后端…';
}

/**
 * 探测徽标。
 * @param {string} probe 'yes' | 'no' | 'unknown'
 * @returns {string} HTML
 */
function probeBadge(probe) {
    if (probe === 'yes') return '<span class="f2b-tag f2b-tag-ok" title="在插件入口代码里找到了该地址，确认是前端调用">前端调用</span>';
    if (probe === 'no') return '<span class="f2b-tag f2b-tag-warn" title="插件入口代码里没有找到该地址（可能是动态拼接）">未确认</span>';
    return '<span class="f2b-tag" title="人物卡/脚本类配置无法自动确认调用方式">来源未知</span>';
}

/**
 * 非插件来源的类型徽标。
 * @param {string} type 来源类型
 * @param {object} [source] 来源信息（用来看是不是“插件存在 localStorage 里的设置”）
 * @returns {string} HTML
 */
function sourceTypeBadge(type, source = {}) {
    if (type === 'character') return '<span class="f2b-tag f2b-tag-ok" title="来自人物卡数据">人物卡</span>';
    if (type === 'storage' && source?.plugin) {
        return `<span class="f2b-tag f2b-tag-ok" title="插件把设置存在浏览器 localStorage 里（与人物卡无关）">插件存储</span>`;
    }
    if (type === 'storage') return '<span class="f2b-tag f2b-tag-ok" title="来自浏览器 localStorage（人物卡脚本常把配置存在这里）">浏览器存储</span>';
    if (type === 'variables') return '<span class="f2b-tag f2b-tag-ok" title="来自酒馆变量">变量</span>';
    if (type === 'runtime') return '<span class="f2b-tag f2b-tag-warn" title="运行时才发现的前端调用（直连失败后自动接管）">运行时捕获</span>';
    if (type === 'server') return '<span class="f2b-tag" title="服务端遗留配置">服务端</span>';
    return '<span class="f2b-tag">未知来源</span>';
}

/**
 * 渲染一张配置卡片。
 * @param {object} entry 条目
 * @returns {string} HTML
 */
function cardHtml(entry) {
    const settings = getSettings();
    const status = cardStatus.get(entry.cfgId) ?? { text: '', kind: '' };
    const keyPlaceholder = entry.hasKey
        ? `已保存：${entry.keyPreview || '…'}（留空表示不修改）`
        : '未保存密钥（将透传插件自己的 key）';
    const disabledClass = entry.enabled ? '' : ' f2b-card-off';
    const sourceTitle = `${entry.source?.detail || ''}\n字段：${entry.source?.path || '-'}`;
    return `
    <section class="f2b-card${disabledClass}" data-cfg-id="${escapeHtml(entry.cfgId)}">
        <div class="f2b-card-head">
            <div class="f2b-card-source" title="${escapeHtml(sourceTitle)}">
                <i class="fa-solid fa-plug f2b-src-icon"></i>
                <span class="f2b-src-text">来自：${escapeHtml(labelOf(entry))}</span>
                ${entry.source?.type === 'extension' ? probeBadge(entry.probe) : sourceTypeBadge(entry.source?.type, entry.source)}
                ${entry.source?.type === 'extension' && isExtensionDisabled(entry.source?.key, entry.source?.name)
                    ? '<span class="f2b-tag f2b-tag-warn" title="所属插件已停用，这条配置不会生效（可删除）">插件未启用</span>'
                    : ''}
                ${entry.backendPending ? '<span class="f2b-tag f2b-tag-bad" title="尚未同步到服务端">未同步</span>' : ''}
            </div>
            <div class="f2b-card-tools">
                <label class="f2b-switch" title="关闭后该配置不再参与转发（等同于临时回到前端直连）">
                    <input type="checkbox" class="f2b-in-enabled" ${entry.enabled ? 'checked' : ''}>
                    <span></span>
                </label>
                <button class="f2b-icon-btn f2b-del" title="删除该后端配置，回到前端 API 配置" data-act="delete">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        </div>
        <label class="f2b-row">
            <span class="f2b-label">接口地址</span>
            <input type="text" class="text_pole f2b-in-base" spellcheck="false" value="${escapeHtml(entry.baseUrl)}" placeholder="https://ark.cn-beijing.volces.com/api/v3">
        </label>
        <label class="f2b-row">
            <span class="f2b-label">API Key</span>
            <input type="password" class="text_pole f2b-in-key" autocomplete="off" spellcheck="false" value="" placeholder="${escapeHtml(keyPlaceholder)}">
        </label>
        <div class="f2b-row">
            <span class="f2b-label">模型${entry.forceModel ? '<i class="fa-solid fa-lock f2b-dim" title="已锁定：转发时会覆盖请求里的模型；清空模型再保存即恢复“跟随插件请求”"></i>' : ''}</span>
            <div class="f2b-model-wrap">
                <input type="text" class="text_pole f2b-in-model" spellcheck="false" value="${escapeHtml(entry.model)}" placeholder="doubao-seed-1-6-250615" title="${entry.forceModel ? '已锁定：转发时会强制覆盖请求里的模型' : '留空/不改则沿用插件自己请求里的模型'}">
                <button class="menu_button f2b-fetch-models" data-act="models" title="从 /models 拉取可用模型">拉取模型</button>
            </div>
        </div>
        <div class="f2b-model-list" data-role="model-list" hidden></div>
        <details class="f2b-adv">
            <summary>高级</summary>
            <div class="f2b-adv-grid">
                <label class="f2b-row"><span class="f2b-label">前端地址</span><input type="text" class="text_pole f2b-in-match" spellcheck="false" value="${escapeHtml(entry.matchBaseUrl || entry.baseUrl)}" title="插件/人物卡实际请求的地址，用于匹配请求；一般不需要改"></label>
                <label class="f2b-row"><span class="f2b-label">路径重写</span><input type="text" class="text_pole f2b-in-path" spellcheck="false" value="${escapeHtml(entry.pathRewrite)}" placeholder="留空表示沿用原路径"></label>
                <label class="f2b-row">
                    <span class="f2b-label">认证方式</span>
                    <select class="text_pole f2b-in-authstyle">
                        <option value="header" ${entry.authStyle === 'header' ? 'selected' : ''}>请求头（Authorization）</option>
                        <option value="query" ${entry.authStyle === 'query' ? 'selected' : ''}>查询参数（?api_key=）</option>
                    </select>
                </label>
                <label class="f2b-row"><span class="f2b-label">认证头名</span><input type="text" class="text_pole f2b-in-authheader" spellcheck="false" value="${escapeHtml(entry.authHeader)}"></label>
                <label class="f2b-row"><span class="f2b-label">认证前缀</span><input type="text" class="text_pole f2b-in-authprefix" spellcheck="false" value="${escapeHtml(entry.authPrefix)}"></label>
                <label class="f2b-row"><span class="f2b-label">查询参数名</span><input type="text" class="text_pole f2b-in-authquery" spellcheck="false" value="${escapeHtml(entry.authQueryName)}"></label>
                <label class="f2b-row"><span class="f2b-label">超时 (ms)</span><input type="number" class="text_pole f2b-in-timeout" min="1000" max="900000" step="1000" value="${Number(entry.timeoutMs) || 600000}"></label>
                <label class="f2b-row f2b-row-wide"><span class="f2b-label">额外请求头</span><textarea class="text_pole f2b-in-headers" rows="2" spellcheck="false" placeholder='{"x-foo":"bar"}'>${escapeHtml(JSON.stringify(entry.extraHeaders ?? {}))}</textarea></label>
            </div>
            <div class="f2b-adv-meta">
                <span>匹配：${escapeHtml(parseBase(entry.matchBaseUrl || entry.baseUrl)?.origin || '（未设置地址，按密钥指纹匹配）')}${escapeHtml(parseBase(entry.matchBaseUrl || entry.baseUrl)?.pathPrefix || '')}</span>
                <span>来源字段：<code>${escapeHtml(entry.source?.path || '-')}</code></span>
                ${settings.intercept ? '' : '<span class="f2b-tag f2b-tag-bad">全局转发已关闭</span>'}
            </div>
        </details>
        <div class="f2b-card-foot">
            <button class="menu_button f2b-save" data-act="save"><i class="fa-solid fa-floppy-disk"></i> 保存</button>
            <button class="menu_button f2b-test" data-act="test"><i class="fa-solid fa-tower-broadcast"></i> 测试连接</button>
            <span class="f2b-card-status ${status.kind ? `f2b-status-${status.kind}` : ''}" data-role="status">${escapeHtml(status.text)}</span>
        </div>
    </section>`;
}

/**
 * 墓碑（已忽略 / 已恢复直连）对应的来源信息。
 * 优先用删除时存下来的信息；老数据没有时，退回到最近一次扫描里同 cfgId 的来源标签。
 * @param {string} cfgId 配置 id
 * @returns {{label: string, baseUrl: string, type: string, at: number}} 来源信息
 */
function tombstoneInfoOf(cfgId) {
    const stored = getTombstoneInfo(cfgId) ?? {};
    const detected = detectedLabels[cfgId] ?? {};
    return {
        label: stored.label || detected.label || '',
        baseUrl: stored.baseUrl || detected.baseUrl || '',
        type: stored.type || detected.type || '',
        at: stored.at || 0,
    };
}

/**
 * 墓碑的类型徽标（插件 / 人物卡 / 浏览器存储…）。
 * @param {string} type 来源类型
 * @returns {string} HTML
 */
function tombstoneBadge(type) {
    if (!type) return '';
    if (type === 'extension') return '<span class="f2b-tag" title="来自插件">插件</span>';
    if (type === 'script') return '<span class="f2b-tag" title="来自人物卡脚本">脚本</span>';
    return sourceTypeBadge(type);
}

/**
 * 时间戳 → “MM-DD HH:mm”。
 * @param {number} ms 毫秒时间戳
 * @returns {string} 文案
 */
function timeLabelOf(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const date = new Date(ms);
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 折叠区外壳：标题（可点开/收起）+ 右侧一键删除按钮 + 内容。
 * @param {object} options 参数
 * @param {string} options.key data-section 键（用于记住展开状态）
 * @param {string} options.title 标题
 * @param {number} options.count 数量
 * @param {string} [options.hint] 标题后的说明
 * @param {string} [options.action] data-act
 * @param {string} [options.actionLabel] 按钮文字（空表示不放按钮）
 * @param {string} [options.actionTitle] 按钮提示
 * @param {string} [options.group] 同源分组的标识（有值时渲染成「同一插件 / 同一张卡」的第二层折叠）
 * @param {string} [options.body] 内容 HTML
 * @returns {string} HTML
 */
function sectionHtml({ key, title, count, hint = '', action = '', actionLabel = '', actionTitle = '', group = '', body = '' }) {
    return `
    <details class="f2b-suggest" data-section="${escapeHtml(key)}"${group ? ` data-group="${escapeHtml(group)}"` : ''}>
        <summary>
            <span class="f2b-suggest-title">${escapeHtml(title)}（${count}）${hint ? `<span class="f2b-dim">— ${escapeHtml(hint)}</span>` : ''}</span>
            ${action ? `<button class="f2b-clear" data-act="${escapeHtml(action)}" title="${escapeHtml(actionTitle)}">${escapeHtml(actionLabel)}</button>` : ''}
        </summary>
        <div class="f2b-section-body">${body}</div>
    </details>`;
}


/**
 * 一条配置属于哪个来源分组：同一插件（含它存在 localStorage 里的设置）、同一张人物卡、
 * 同一份浏览器存储、同一运行时主机归到一组。
 * @param {object} entry 配置条目
 * @returns {{key: string, label: string}} 分组信息
 */
/**
 * 分组用的插件身份：命名空间与目录名常常对不上（txtToWorldbookSettings / txtToWorldbook、
 * novel-auto-generator / Novel-Auto-Generator），归一化之后当作同一个插件。
 * @param {string} name 插件名 / 命名空间 / 目录名
 * @returns {string} 归一化身份
 */
function pluginIdentity(name) {
    return String(name ?? '')
        .replace(/[_\-\s]?(?:settings?|config|configuration)\d*$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function groupOf(entry) {
    const source = entry.source ?? {};
    const type = source.type || 'extension';
    if (type === 'storage' && !source.plugin && source.character) {
        return { key: `card:${source.character}`, label: `角色卡 · ${source.character}` };
    }
    if (type === 'storage' && !source.plugin) {
        return { key: `storage:${source.key || source.name || ''}`, label: labelOf(entry) };
    }
    if (type === 'character') {
        const name = source.character || source.name || '';
        return { key: `card:${name}`, label: `角色卡 · ${name || '未知'}` };
    }
    if (type === 'runtime') {
        return { key: `runtime:${source.host || source.name || ''}`, label: labelOf(entry) };
    }
    if (type === 'variables') return { key: 'variables', label: '酒馆变量' };
    if (type === 'server') return { key: 'server', label: '服务端已有配置' };
    // 插件（含插件自己存在 localStorage 里的配置）：按插件身份归组，同插件的多条 API 折叠在一起。
    const plugin = source.plugin || source.key || source.name || '';
    const identity = pluginIdentity(plugin) || plugin;
    const display = source.name || source.plugin || plugin;
    return { key: `plugin:${identity}`, label: `插件 · ${display || '未知'}` };
}

/**
 * 按来源分组（保持第一次出现的顺序）。
 * @param {Array<object>} entries 条目
 * @returns {Array<{key: string, label: string, entries: Array<object>}>} 分组
 */
function groupEntries(entries) {
    const groups = [];
    const index = new Map();
    for (const entry of entries) {
        const info = groupOf(entry);
        let group = index.get(info.key);
        if (!group) {
            group = { key: info.key, label: info.label, entries: [] };
            index.set(info.key, group);
            groups.push(group);
        }
        group.entries.push(entry);
    }
    return groups;
}

/**
 * 已转换列表的 HTML：同一来源只有一条时直接显示卡片，多条时折进一个同源分组。
 * @param {Array<object>} entries 条目
 * @returns {string} HTML
 */
function entriesBodyHtml(entries) {
    return groupEntries(entries).map(group => {
        if (group.entries.length === 1) return cardHtml(group.entries[0]);
        return sectionHtml({
            key: 'group',
            group: group.key,
            title: group.label,
            count: group.entries.length,
            hint: '同一来源',
            action: 'clear-group',
            actionLabel: '全部删除',
            actionTitle: `删除「${group.label}」下的全部 ${group.entries.length} 条后端配置（回到前端直连，会记进“已忽略”里）`,
            body: group.entries.map(entry => cardHtml(entry)).join(''),
        });
    }).join('');
}

/**
 * 渲染“疑似配置 / 已忽略”两个折叠区。
 * @returns {string} HTML
 */
function footerSectionsHtml() {
    const settings = getSettings();
    const suggestions = lastSuggestions.filter(item => !findEntry(item.cfgId) && !settings.tombstones.includes(item.cfgId));
    const tombstones = settings.tombstones.filter(cfgId => !findEntry(cfgId));
    // 疑似列表也按来源归组：同一插件 / 同一张卡挖出好几条时，折成一组更清爽。
    const suggestionBody = groupEntries(suggestions).map(group => {
        const rows = group.entries.map(item => `
                <div class="f2b-suggest-item" data-cfg-id="${escapeHtml(item.cfgId)}">
                    <div class="f2b-suggest-text">
                        <span class="f2b-src-text">来自：${escapeHtml(labelOf(item))}</span>
                        <code>${escapeHtml(item.baseUrl)}</code>
                        ${item.reason ? `<span class="f2b-dim">${escapeHtml(item.reason)}</span>` : ''}
                    </div>
                    <button class="menu_button" data-act="convert">转为后端</button>
                    <button class="f2b-icon-btn f2b-del" data-act="dismiss" title="忽略这条疑似配置（不再提示，也不会自动转换）">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>`).join('');
        if (group.entries.length === 1) return rows;
        return sectionHtml({
            key: 'group',
            group: `sug:${group.key}`,
            title: group.label,
            count: group.entries.length,
            hint: '同一来源',
            body: rows,
        });
    }).join('');
    const suggestionHtml = suggestions.length === 0 ? '' : sectionHtml({
        key: 'suggestion',
        title: '疑似前端调用',
        count: suggestions.length,
        hint: '需手动确认后转换',
        action: 'clear-suggestions',
        actionLabel: '全部忽略',
        actionTitle: '把下面所有疑似配置都标记为忽略（不再提示、也不会自动转换；可在“已忽略”里恢复）',
        body: suggestionBody,
    });
    const tombstoneHtml = tombstones.length === 0 ? '' : sectionHtml({
        key: 'tombstone',
        title: '已忽略 / 已恢复前端直连',
        count: tombstones.length,
        hint: '不会再自动转换',
        action: 'clear-tombstones',
        actionLabel: '全部清除',
        actionTitle: '清空这些记录（只清记录、不动配置；下次扫描会重新判定这些来源）',
        body: tombstones.map(cfgId => {
            const info = tombstoneInfoOf(cfgId);
            const label = info.label ? `来自：${info.label}` : '来源未知（原始配置已不存在）';
            const when = timeLabelOf(info.at);
            return `
                <div class="f2b-suggest-item" data-cfg-id="${escapeHtml(cfgId)}">
                    <div class="f2b-suggest-text">
                        <span class="f2b-tomb-line">
                            <span class="f2b-src-text">${escapeHtml(label)}</span>
                            ${tombstoneBadge(info.type)}
                        </span>
                        ${info.baseUrl ? `<code>${escapeHtml(info.baseUrl)}</code>` : ''}
                        <span class="f2b-dim">${when ? `${escapeHtml(when)} · ` : ''}id ${escapeHtml(cfgId)}</span>
                    </div>
                    <button class="menu_button" data-act="restore" title="取消忽略并重新扫描，把它转回后端配置">重新转换</button>
                    <button class="f2b-icon-btn f2b-del" data-act="forget" title="删除这条记录（不再保留忽略标记；下次扫描会重新判定该来源）">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>`;
        }).join(''),
    });
    return suggestionHtml + tombstoneHtml;
}

/**
 * 读取卡片上的输入值。
 * @param {HTMLElement} card 卡片元素
 * @returns {{patch: object, apiKey: string}} 表单值
 */
function readCard(card) {
    const value = (selector) => card.querySelector(selector)?.value ?? '';
    let extraHeaders = {};
    const rawHeaders = value('.f2b-in-headers').trim();
    if (rawHeaders) {
        try {
            extraHeaders = sanitizeHeadersObject(JSON.parse(rawHeaders));
        } catch {
            throw new Error('额外请求头必须是合法 JSON 对象');
        }
    }
    const timeoutValue = Number(value('.f2b-in-timeout'));
    return {
        patch: {
            matchBaseUrl: normalizeEndpoint(value('.f2b-in-match')) || value('.f2b-in-match').trim(),
            baseUrl: normalizeEndpoint(value('.f2b-in-base')) || value('.f2b-in-base').trim(),
            model: value('.f2b-in-model').trim(),
            pathRewrite: value('.f2b-in-path').trim(),
            authStyle: value('.f2b-in-authstyle') === 'query' ? 'query' : 'header',
            authHeader: value('.f2b-in-authheader').trim() || 'authorization',
            authPrefix: value('.f2b-in-authprefix'),
            authQueryName: value('.f2b-in-authquery').trim() || 'api_key',
            timeoutMs: Number.isFinite(timeoutValue) && timeoutValue >= 1000 ? Math.min(timeoutValue, 900000) : 600000,
            extraHeaders,
        },
        apiKey: value('.f2b-in-key').trim(),
    };
}

/**
 * 条目的有效目标地址：优先 baseUrl，其次匹配地址。
 * @param {object|null} entry 条目
 * @returns {string} 地址
 */
function effectiveBaseOf(entry) {
    if (!entry) return '';
    return normalizeEndpoint(entry.baseUrl) || normalizeEndpoint(entry.matchBaseUrl) || '';
}

/**
 * 更新卡片状态文本。
 * @param {string} cfgId 配置 id
 * @param {string} text 文本
 * @param {''|'ok'|'bad'|'busy'} [kind] 样式
 * @returns {void}
 */
function setStatus(cfgId, text, kind = '') {
    cardStatus.set(cfgId, { text, kind });
    const card = panelEl?.querySelector(`.f2b-card[data-cfg-id="${CSS.escape(cfgId)}"]`);
    const el = card?.querySelector('[data-role="status"]');
    if (!el) return;
    el.textContent = text;
    el.className = `f2b-card-status${kind ? ` f2b-status-${kind}` : ''}`;
}

/**
 * 全量渲染面板内容。
 * @returns {void}
 */
/** 用户明确展开 / 明确收起的折叠块（重绘后按 key 恢复，避免删一条就全部折叠或全部弹开）。 */
const openDetails = new Set();
const closedDetails = new Set();

/**
 * 没被用户动过时，这一块默认是不是展开的。
 * @param {string} key 折叠块 key
 * @returns {boolean} 是否默认展开
 */
function defaultOpen(key) {
    // 「已转换」是主列表；同源分组（同一插件 / 同一张卡的多条配置）也是主内容，都默认展开。
    return key === 'section:entries' || key.startsWith('group:');
}

/**
 * 折叠块的稳定 key：折叠区用 data-section，卡片内的“高级”用 cfgId。
 * @param {Element} el details 元素
 * @returns {string} key（空表示不需要记住）
 */
function detailsKeyOf(el) {
    if (!el?.classList) return '';
    if (!el.classList.contains('f2b-adv') && !el.classList.contains('f2b-suggest')) return '';
    // 同源分组优先：它和顶层区块一样带 data-section，但要按来源单独记住状态。
    const group = el.dataset?.group;
    if (group) return 'group:' + group;
    const section = el.dataset?.section;
    if (section) return 'section:' + section;
    if (el.classList.contains('f2b-adv')) {
        const cfgId = el.closest?.('.f2b-card')?.dataset?.cfgId;
        if (cfgId) return 'adv:' + cfgId;
    }
    return '';
}

/**
 * 重绘前把当前 DOM 里各折叠块的展开状态记下来。
 * @returns {void}
 */
function captureDetailsState() {
    for (const el of panelEl?.querySelectorAll('details') ?? []) {
        const key = detailsKeyOf(el);
        if (!key) continue;
        if (el.open) {
            openDetails.add(key);
            closedDetails.delete(key);
        } else {
            closedDetails.add(key);
            openDetails.delete(key);
        }
    }
}

/**
 * 重绘后按 key 恢复展开状态。
 * @returns {void}
 */
function restoreDetailsState() {
    for (const el of panelEl?.querySelectorAll('details') ?? []) {
        const key = detailsKeyOf(el);
        if (!key) continue;
        if (openDetails.has(key)) {
            el.open = true;
        } else if (closedDetails.has(key)) {
            el.open = false;
        } else {
            el.open = defaultOpen(key);
        }
    }
}
function render() {
    if (!panelEl) return;
    const settings = getSettings();
    const status = panelEl.querySelector('[data-role="backend"]');
    if (status) {
        status.innerHTML = backendStatusText();
        status.title = status.textContent?.trim() ?? '';
    }
    const scanButton = panelEl.querySelector('[data-act="scan"]');
    if (scanButton) scanButton.title = scanButtonTitle();
    const list = panelEl.querySelector('[data-role="list"]');
    if (!list) return;
    const entries = settings.entries;
    const counts = { extension: 0, character: 0, storage: 0, variables: 0, runtime: 0, server: 0, script: 0 };
    for (const entry of entries) {
        const type = entry.source?.type;
        // 插件存在 localStorage 里的配置也算「插件」，只有人物卡的存储才算「存储」。
        if (type === 'storage' && entry.source?.plugin) {
            counts.extension++;
            continue;
        }
        if (Object.hasOwn(counts, type)) counts[type]++;
    }
    // 只列“有值”的来源，避免出现「插件 0 · 变量 0」这种占位把一行撑爆。
    const parts = [`已转换 ${entries.length} 项`];
    if (counts.extension) parts.push(`插件 ${counts.extension}`);
    if (counts.character) parts.push(`角色卡 ${counts.character}`);
    if (counts.storage) parts.push(`存储 ${counts.storage}`);
    if (counts.variables) parts.push(`变量 ${counts.variables}`);
    if (counts.runtime) parts.push(`运行时 ${counts.runtime}`);
    if (counts.server) parts.push(`服务端 ${counts.server}`);
    const pending = lastSuggestions.filter(item => !findEntry(item.cfgId) && !settings.tombstones.includes(item.cfgId)).length;
    if (pending) parts.push(`疑似 ${pending}`);
    if (entries.length === 0 && pending === 0) parts.push(settings.lastScanSummary || '尚未扫描');
    const summary = parts.filter(Boolean).join(' · ');
    const summaryEl = panelEl.querySelector('[data-role="summary"]');
    if (summaryEl) {
        summaryEl.innerHTML = `<span class="f2b-dim">${escapeHtml(summary)}</span>`;
        summaryEl.title = summary;
    }
    const cards = entriesBodyHtml(entries);
    const entriesSection = entries.length === 0 ? '' : sectionHtml({
        key: 'entries',
        title: '已转换',
        count: entries.length,
        hint: '点标题可折叠',
        action: 'clear-entries',
        actionLabel: '全部删除',
        actionTitle: '删除全部后端配置、回到插件原本的前端直连（会记进“已忽略”里，可逐条恢复）',
        body: cards,
    });
    const empty = entries.length === 0
        ? `<div class="f2b-empty">还没有转换任何配置。<br>点击右上角 ⟳ ${currentCharacter()
            ? '重新扫描插件与当前人物卡'
            : '重新扫描插件（尚未打开人物卡：只扫插件自己的配置，卡片里的配置要打开后再扫）'}。</div>`
        : '';
    // 重绘前先记下哪些折叠块是展开的、滚到哪儿了 —— 否则删/存一条之后
    // “已忽略 / 已恢复前端直连”“高级”会自己折叠回去，滚动也跳回顶部。
    captureDetailsState();
    const scrollTop = list.scrollTop;
    list.innerHTML = entriesSection + empty + footerSectionsHtml();
    restoreDetailsState();
    list.scrollTop = scrollTop;
    updateBadge();
    void loadProbes();
}

/**
 * 后台补齐“前端调用”探测结果（只更新徽标，不整表重绘）。
 * @returns {void}
 */
async function loadProbes() {
    const settings = getSettings();
    if (!settings.probeFrontend) return;
    const pending = settings.entries.filter(entry => entry.probe === 'unknown' && entry.source?.type === 'extension');
    if (pending.length === 0) return;
    for (const entry of pending) {
        const verdict = await probeFrontendUsage(entry);
        if (verdict === 'unknown') continue;
        const current = findEntry(entry.cfgId);
        if (!current) continue;
        current.probe = verdict;
        invalidateRoutes();
        saveSettings();
        const card = panelEl?.querySelector(`.f2b-card[data-cfg-id="${CSS.escape(entry.cfgId)}"]`);
        const source = card?.querySelector('.f2b-card-source');
        if (source) {
            const old = source.querySelector('.f2b-tag');
            const template = document.createElement('template');
            template.innerHTML = probeBadge(verdict);
            if (old) old.replaceWith(template.content.firstElementChild);
            else source.appendChild(template.content.firstElementChild);
        }
    }
    saveSettings();
}

/**
 * 保存一张卡片（静默模式供“测试连接”复用）。
 * @param {HTMLElement} card 卡片元素
 * @param {boolean} silent 是否静默
 * @returns {Promise<object|null>} 保存后的条目
 */
async function saveCard(card, silent = false) {
    const cfgId = card.dataset.cfgId;
    let form;
    try {
        form = readCard(card);
    } catch (error) {
        setStatus(cfgId, error.message, 'bad');
        return null;
    }
    if (!isBackendReady()) {
        await checkBackend();
    }
    // 只是“测试连接 / 拉取模型”顺手保存一次时，值没变就别把配置标成“手动改过”，
    // 否则之后扫描就不再跟随插件/人物卡里的最新配置了。
    const before = findEntry(cfgId);
    const changed = !before || Object.entries(form.patch).some(([key, value]) => {
        if (key === 'extraHeaders') return JSON.stringify(value) !== JSON.stringify(before.extraHeaders ?? {});
        return String(value ?? '') !== String(before[key] ?? '');
    });
    setStatus(cfgId, '正在保存…', 'busy');
    try {
        const result = await saveEntry({ cfgId, patch: form.patch, apiKey: form.apiKey, markManual: changed });
        card.querySelector('.f2b-in-key').value = '';
        card.querySelector('.f2b-in-key').placeholder = result.hasKey
            ? `已保存：${result.keyPreview || '…'}（留空表示不修改）`
            : '未保存密钥（将透传插件自己的 key）';
        setStatus(cfgId, silent ? '已保存' : `已保存 · ${result.hasKey ? '密钥在服务端' : '无密钥'}`, 'ok');
        if (!silent) notify('配置已保存（密钥仅保存在服务端）', 'success');
        return result.entry;
    } catch (error) {
        setStatus(cfgId, `保存失败：${error?.message ?? error}`, 'bad');
        if (!silent) notify(`保存失败：${error?.message ?? error}`, 'error');
        return null;
    }
}

/**
 * 测试连接（会先保存当前表单值，确保测试的是面板上看到的内容）。
 * @param {HTMLElement} card 卡片元素
 * @returns {Promise<void>} 完成
 */
async function testCard(card) {
    const cfgId = card.dataset.cfgId;
    const entry = await saveCard(card, true);
    if (!entry) return;
    const base = effectiveBaseOf(entry);
    const urls = [probeUrlOf(base), base].filter(Boolean).map(url => toBackendUrl(url, entry.baseUrl || base));
    if (urls.length === 0) {
        setStatus(cfgId, '请先填写接口地址', 'bad');
        return;
    }
    setStatus(cfgId, '正在测试连接…', 'busy');
    for (const url of urls) {
        try {
            const result = await testConnection({ url, method: 'GET', cfgId, label: labelOf(entry) });
            if (result?.ok === false) {
                setStatus(cfgId, `连接失败：${result.error || result.code || '未知错误'}`, 'bad');
                continue;
            }
            const auth = result.authError ? '（认证失败）' : '';
            const ok = Number(result.status) > 0 && Number(result.status) < 400 && !result.authError;
            setStatus(
                cfgId,
                `HTTP ${result.status || '-'} · ${formatMs(result.ms)}${auth} ${ok ? '可用' : result.status ? '可连通但不通' : ''}`,
                ok ? 'ok' : 'bad',
            );
            card.querySelector('.f2b-card-status')?.setAttribute('title', String(result.preview ?? '').slice(0, 400));
            if (ok) return;
        } catch (error) {
            setStatus(cfgId, `测试失败：${error?.message ?? error}`, 'bad');
        }
    }
}

/**
 * 拉取模型列表。
 * @param {HTMLElement} card 卡片元素
 * @returns {Promise<void>} 完成
 */
async function fetchModelList(card) {
    const cfgId = card.dataset.cfgId;
    const listEl = card.querySelector('[data-role="model-list"]');
    const input = card.querySelector('.f2b-in-model');
    const typedBase = normalizeEndpoint(card.querySelector('.f2b-in-base')?.value ?? '') || effectiveBaseOf(findEntry(cfgId));
    const modelsUrl = modelsUrlOf(typedBase);
    if (!modelsUrl) {
        setStatus(cfgId, '请先填写合法的接口地址', 'bad');
        return;
    }
    if (listEl) {
        listEl.hidden = false;
        listEl.innerHTML = '<div class="f2b-dim">正在拉取模型…</div>';
    }
    setStatus(cfgId, '正在拉取模型…', 'busy');
    // 先用面板里的值保存一次，否则服务端还没有该 cfgId 的地址/密钥，/models 多半 401。
    const saved = await saveCard(card, true);
    if (!saved) return;
    const url = toBackendUrl(modelsUrl, effectiveBaseOf(saved));
    try {
        const result = await fetchModels(url, cfgId, labelOf(saved));
        const usable = result.models.filter(model => model.available).length;
        // 等待期间面板可能被重绘，元素要按最新的重新取一次，否则列表会画在已脱离文档的节点上。
        const live = card.isConnected ? (card.querySelector('[data-role="model-list"]') || listEl) : listEl;
        if (!live) return;
        live.hidden = false;
        renderModelList(live, card, cfgId, result, saved);
        setStatus(
            cfgId,
            '可用 ' + usable + (result.dead > 0 ? ' · 已下线 ' + result.dead + '（已折叠）' : ''),
            usable > 0 ? 'ok' : 'bad',
        );
    } catch (error) {
        const live = card.isConnected ? (card.querySelector('[data-role="model-list"]') || listEl) : listEl;
        if (live) {
            live.hidden = false;
            live.innerHTML = '<div class="f2b-model-head"><span class="f2b-status-bad">拉取失败</span>'
                + '<button class="f2b-model-close" data-role="close-list" title="收起">✕</button></div>'
                + '<div class="f2b-status-bad">' + escapeHtml(error && error.message ? error.message : String(error)) + '</div>';
            wireModelList(live, card, cfgId);
        }
        setStatus(cfgId, '拉取失败：' + (error && error.message ? error.message : error), 'bad');
    }
}

/** 一次最多铺开多少个可用模型 chip，避免接口返回上百个时把卡片塞爆。 */
const MAX_MODEL_CHIPS = 160;

/**
 * 渲染模型下拉框内容。
 * 可用模型常驻显示，已下线（如方舟的 Shutdown 模型）折叠起来，避免挑到死模型。
 * @param {HTMLElement} listEl 列表容器
 * @param {HTMLElement} card 卡片
 * @param {string} cfgId 配置 id
 * @param {{models: Array<{id: string, name: string, status: string, available: boolean, note: string}>, total: number, dead: number}} result 拉取结果
 * @param {object} saved 当前条目
 * @returns {void}
 */
function renderModelList(listEl, card, cfgId, result, saved) {
    const current = String(card.querySelector('.f2b-in-model')?.value ?? '').trim();
    const usable = result.models.filter(model => model.available);
    const dead = result.models.filter(model => !model.available);
    const shown = usable.slice(0, MAX_MODEL_CHIPS);
    const chip = (model, restore) => {
        const isCurrent = model.id === current;
        const isDead = !model.available;
        const title = isDead
            ? (model.note || '该模型在服务端已下线')
            : (model.note || (restore ? '改回上一次用的模型' : '点击填入模型'));
        return '<button class="f2b-model-item' + (isDead ? ' f2b-model-off' : '') + (isCurrent ? ' f2b-model-current' : '') + '"'
            + ' data-model="' + escapeHtml(model.id) + '"'
            + ' data-available="' + (model.available ? '1' : '0') + '"'
            + ' title="' + escapeHtml(title) + '">'
            + escapeHtml((restore ? '恢复：' : '') + model.id)
            + (isDead ? '<span class="f2b-model-tag">已下线</span>' : '')
            + '</button>';
    };
    const restoreChip = saved.prevModel && saved.prevModel !== current
        ? chip({ id: saved.prevModel, name: saved.prevModel, status: '', available: true, note: '改回上一次用的模型' }, true)
        : '';
    const usableHtml = shown.map(model => chip(model, false)).join('');
    const deadHtml = dead.map(model => chip(model, false)).join('');
    const parts = [
        '<div class="f2b-model-head"><span class="f2b-dim">共 ' + result.total + ' 个 · 可用 ' + usable.length
            + (dead.length > 0 ? ' · 已下线 ' + dead.length : '') + '</span>'
            + '<button class="f2b-model-close" data-role="close-list" title="收起">✕</button></div>',
        restoreChip,
        usableHtml || '<div class="f2b-dim f2b-model-hint">接口没有返回可用模型，直接手填即可</div>',
        usable.length > shown.length
            ? '<div class="f2b-dim f2b-model-hint">可用模型太多，只显示前 ' + MAX_MODEL_CHIPS + ' 个，其余请手填。</div>'
            : '',
        dead.length > 0
            ? '<button class="f2b-model-more" data-role="show-dead">显示已下线（' + dead.length + '）</button>'
                + '<div class="f2b-model-dead" hidden>' + deadHtml + '</div>'
            : '',
        '<div class="f2b-dim f2b-model-hint">列表来自 /models；套餐里没列出的模型（例如方舟 Coding 套餐的 deepseek-*）直接手填。</div>',
    ];
    listEl.innerHTML = parts.filter(Boolean).join('');
    wireModelList(listEl, card, cfgId);
}

/**
 * 绑定模型列表的点击行为：点选模型、展开已下线、收起列表。
 * @param {HTMLElement} listEl 列表容器
 * @param {HTMLElement} card 卡片
 * @param {string} cfgId 配置 id
 * @returns {void}
 */
function wireModelList(listEl, card, cfgId) {
    listEl.onclick = (event) => {
        const target = event.target instanceof HTMLElement ? event.target.closest('button') : null;
        if (!target) return;
        event.stopPropagation();
        const role = target.dataset.role;
        if (role === 'close-list') {
            listEl.hidden = true;
            return;
        }
        if (role === 'show-dead') {
            const box = listEl.querySelector('.f2b-model-dead');
            if (box) box.hidden = false;
            target.hidden = true;
            return;
        }
        const model = target.dataset.model;
        if (!model) return;
        const input = card.querySelector('.f2b-in-model');
        if (input) input.value = model;
        listEl.hidden = true;
        if (target.dataset.available === '0') {
            setStatus(cfgId, '已填入，但该模型在服务端已下线，请求大概率失败', 'bad');
        } else {
            setStatus(cfgId, '已填入模型，记得点保存', '');
        }
    };
}

/** 收起面板里已经展开的模型列表。 */
function closeModelLists() {
    for (const el of panelEl?.querySelectorAll('[data-role="model-list"]') ?? []) {
        el.hidden = true;
    }
}

/**
 * 打开一个“确认 / 取消”弹窗。
 * 酒馆的 #dialogue_popup 是固定 500px 宽、底部按钮一行排布，确认文字一长就会挤在一起，
 * 所以打开期间给它加上 f2b-popup 类，用我们自己的样式排底部按钮（关掉后立刻移除，
 * 不影响酒馆其它弹窗）。
 * @param {string} html 正文 HTML
 * @param {string} okButton 确认按钮文字
 * @returns {Promise<boolean>} 是否确认
 */
async function confirmDialog(html, okButton) {
    const popupEl = document.getElementById('dialogue_popup');
    popupEl?.classList.add('f2b-popup');
    try {
        return Boolean(await callPopup(html, POPUP_TYPE.CONFIRM, '', { okButton }));
    } finally {
        popupEl?.classList.remove('f2b-popup');
    }
}

/**
 * 删除确认对话框的内容。
 * 不用 `<br>` 拼字符串：酒馆弹窗的正文默认居中、宽度随内容变，长地址会把排版挤乱；
 * 这里改成「标题 + 两列信息 + 说明」的结构，样式由 .f2b-dialog 系列控制。
 * @param {object} entry 条目
 * @returns {string} HTML
 */
function deleteDialogHtml(entry) {
    const base = escapeHtml(entry.baseUrl || entry.matchBaseUrl || '-');
    const model = entry.model ? escapeHtml(entry.model) : '（跟随插件请求里的模型）';
    return `
    <div class="f2b-dialog">
        <div class="f2b-dialog-title">删除这条后端配置？</div>
        <div class="f2b-dialog-rows">
            <span class="f2b-dialog-key">来源</span>
            <span class="f2b-dialog-val">${escapeHtml(labelOf(entry))}</span>
            <span class="f2b-dialog-key">接口</span>
            <span class="f2b-dialog-val"><code>${base}</code></span>
            <span class="f2b-dialog-key">模型</span>
            <span class="f2b-dialog-val"><code>${model}</code></span>
        </div>
        <div class="f2b-dialog-note">
            删除后该来源立即<b>恢复前端直连</b>，服务端保存的密钥也会一起删掉；
            以后扫描不会再自动转换它 —— 想找回可在面板底部「已忽略」里点「重新转换」。
        </div>
    </div>`;
}

/**
 * 忽略一条“疑似前端调用”的配置：记成墓碑，之后不再提示、也不会自动转换。
 * 墓碑会连同来源标签一起存下来，面板底部才能显示“来自哪个插件/人物卡”。
 * @param {object|null} candidate 候选
 * @returns {Promise<void>} 完成
 */
async function dismissSuggestion(candidate) {
    const cfgId = candidate?.cfgId;
    if (!cfgId) return;
    const info = {
        label: labelOf(candidate),
        baseUrl: candidate.baseUrl || candidate.matchBaseUrl || '',
        type: candidate.source?.type || '',
    };
    detectedLabels[cfgId] = info;
    addTombstone(cfgId, info);
    lastSuggestions = lastSuggestions.filter(item => item.cfgId !== cfgId);
    render();
    notify(`已忽略「${info.label}」的疑似配置（面板底部「已忽略」里可恢复）`, 'info');
}

/**
 * 一键删除全部后端配置（回到前端直连，记录进“已忽略”里可逐条恢复）。
 * @returns {Promise<void>} 完成
 */
async function clearAllEntries() {
    const settings = getSettings();
    const count = settings.entries.length;
    if (count === 0) return;
    const ok = await confirmDialog(
        `<div class="f2b-dialog">
            <div class="f2b-dialog-title">删除全部 ${count} 条后端配置？</div>
            <div class="f2b-dialog-note">它们会全部回到插件原本的前端直连；每条都会记进下面的“已忽略 / 已恢复前端直连”，想留哪条可以逐条点“重新转换”拿回来。</div>
        </div>`,
        `全部删除`,
    );
    if (!ok) return;
    const result = await deleteAllEntries();
    render();
    notify(`已删除 ${result.count} 条后端配置，全部回到前端直连（可在“已忽略”里逐条恢复）`, 'warning');
}

/**
 * 一键忽略当前所有疑似配置（不转换，只记进“已忽略”）。
 * @returns {void}
 */
function clearAllSuggestions() {
    const settings = getSettings();
    const pending = lastSuggestions.filter(item => !findEntry(item.cfgId) && !settings.tombstones.includes(item.cfgId));
    if (pending.length === 0) return;
    for (const item of pending) {
        const label = labelOf(item);
        addTombstone(item.cfgId, { label, baseUrl: item.baseUrl || '', type: item.source?.type || '' });
        detectedLabels[item.cfgId] = { label, baseUrl: item.baseUrl || '', type: item.source?.type || '', at: Date.now() };
    }
    saveSettings();
    render();
    notify(`已忽略 ${pending.length} 条疑似配置（可在“已忽略”里恢复）`, 'info');
}

/**
 * 一键清空“已忽略 / 已恢复前端直连”的记录（不动任何配置）。
 * @returns {void}
 */
function clearAllTombstones() {
    const count = forgetAllTombstones();
    detectedLabels = {};
    render();
    notify(`已清除 ${count.count} 条记录；下次扫描会重新判定这些来源`, 'info');
}

/**
 * 删除同一来源下的全部配置（回到前端直连，逐条留墓碑）。
 * @param {string} groupKey 分组 key
 * @returns {Promise<void>} 完成
 */
async function clearGroup(groupKey) {
    if (!groupKey) return;
    const group = groupEntries(getSettings().entries).find(item => item.key === groupKey);
    if (!group || group.entries.length === 0) return;
    const ok = await confirmDialog(
        `<div class="f2b-dialog">
            <div class="f2b-dialog-title">删除「${escapeHtml(group.label)}」的全部 ${group.entries.length} 条配置？</div>
            <div class="f2b-dialog-note">这些配置会回到该来源原本的前端直连；每条都会记进“已忽略 / 已恢复前端直连”，想留哪条可以逐条点“重新转换”拿回来。</div>
        </div>`,
        `全部删除`,
    );
    if (!ok) return;
    let count = 0;
    for (const entry of group.entries) {
        try {
            await deleteEntry(entry.cfgId);
            count++;
        } catch (error) {
            console.warn(`[f2b] 删除 ${entry.cfgId} 失败：`, error?.message ?? error);
        }
    }
    render();
    notify(`已删除「${group.label}」的 ${count} 条配置，回到前端直连`, 'warning');
}

/**
 * 删除一条配置（回到前端直连）。
 * @param {HTMLElement} card 卡片元素
 * @returns {Promise<void>} 完成
 */
async function removeCard(card) {
    const cfgId = card.dataset.cfgId;
    const entry = findEntry(cfgId);
    if (!entry) return;
    const confirm = await confirmDialog(deleteDialogHtml(entry), '删除并回到前端');
    if (!confirm) return;
    setStatus(cfgId, '正在删除…', 'busy');
    await deleteEntry(cfgId);
    cardStatus.delete(cfgId);
    render();
    notify('已删除后端配置，恢复前端直连', 'warning');
}

/**
 * 面板上的按钮事件分发。
 * @param {MouseEvent} event 事件
 * @returns {Promise<void>} 完成
 */
async function onPanelClick(event) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target) return;
    // 点到模型列表和“拉取模型”以外的地方，就把已经铺开的列表收起来。
    if (!target.closest('[data-role="model-list"]') && !target.closest('[data-act="models"]')) closeModelLists();
    const actionEl = target.closest('[data-act]');
    const action = actionEl?.dataset.act;
    // 折叠区标题右侧的一键删除按钮在 <summary> 里，点它别顺带把这一块折叠起来。
    if (actionEl instanceof HTMLElement && actionEl.closest('summary')) event.preventDefault();
    if (action === 'close') {
        closePanel();
        return;
    }
    if (action === 'scan') {
        await doScan(true);
        return;
    }
    if (action === 'clear-entries') {
        await clearAllEntries();
        return;
    }
    if (action === 'clear-suggestions') {
        clearAllSuggestions();
        return;
    }
    if (action === 'clear-tombstones') {
        clearAllTombstones();
        return;
    }
    if (action === 'clear-group') {
        await clearGroup(actionEl?.closest('[data-group]')?.dataset?.group ?? '');
        return;
    }
    const card = target.closest('.f2b-card');
    if (card instanceof HTMLElement && action) {
        if (action === 'save') await saveCard(card);
        else if (action === 'test') await testCard(card);
        else if (action === 'models') await fetchModelList(card);
        else if (action === 'delete') await removeCard(card);
        return;
    }
    const suggestItem = target.closest('.f2b-suggest-item');
    if (suggestItem instanceof HTMLElement && action) {
        const cfgId = suggestItem.dataset.cfgId ?? '';
        if (action === 'convert') {
            const candidate = lastSuggestions.find(item => item.cfgId === cfgId);
            if (!candidate) return;
            await convertSuggestion(candidate);
            notify('已转为后端配置', 'success');
            render();
        } else if (action === 'dismiss') {
            await dismissSuggestion(lastSuggestions.find(item => item.cfgId === cfgId) ?? null);
        } else if (action === 'restore') {
            await restoreTombstone(cfgId);
            notify('已恢复自动转换', 'info');
            render();
        } else if (action === 'forget') {
            forgetTombstone(cfgId);
            delete detectedLabels[cfgId];
            render();
            notify('已删除这条记录；下次扫描会重新判定该来源', 'info');
        }
    }
}

/**
 * 卡片内的开关变化。
 * @param {Event} event change 事件
 * @returns {void}
 */
function onPanelChange(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.classList.contains('f2b-in-enabled')) return;
    const card = input.closest('.f2b-card');
    if (!(card instanceof HTMLElement)) return;
    const entry = findEntry(card.dataset.cfgId ?? '');
    if (!entry) return;
    entry.enabled = input.checked;
    entry.updatedAt = Date.now();
    upsertEntry(entry);
    card.classList.toggle('f2b-card-off', !entry.enabled);
    updateBadge();
}

/**
 * 运行时捕获事件的 UI 处理：提示并刷新面板。
 * @param {{kind: string, host: string, href: string, label?: string}} info 事件
 * @returns {void}
 */
export function onRuntimeCaptured(info) {
    if (!info || typeof info.host !== 'string') return;
    if (info.kind === 'rescued') {
        notify(`${info.host} 前端直连失败，已自动转走后端（悬浮球里可查看/修改）`, 'success');
    } else if (info.kind === 'captured') {
        notify(`${info.host} 前端调用失败，已登记为后端配置（悬浮球里可查看/修改）`, 'warning');
    } else if (info.kind === 'v1') {
        notify(`${info.host} 的请求多带了一层 /v1，已自动校正为上游真实路径`, 'info');
    }
    refresh();
}

/**
 * 扫描并渲染。
 * @param {boolean} [notifyUser] 是否提示
 * @returns {Promise<object|null>} 扫描结果
 */
export async function doScan(notifyUser = false) {
    if (panelEl) {
        const status = panelEl.querySelector('[data-role="backend"]');
        if (status) status.innerHTML = '<span class="f2b-dot f2b-dot-warn"></span>正在扫描…';
    }
    try {
        const result = await runScan();
        lastSuggestions = result.suggestions ?? [];
        detectedLabels = result.known ?? {};
        render();
        if (result.created > 0) {
            notify(`检测到 ${result.created} 个前端 API 配置，已转为后端（左上角悬浮球可查看/修改）`, 'success');
        }
        if (result.pruned > 0) {
            notify(`已清理 ${result.pruned} 项无效配置（插件已停用或指向本机地址）`, 'info');
        }
        if (result.failed > 0) {
            notify(`有 ${result.failed} 项未能同步到服务端，请检查 f2b-takeover 插件是否已安装并启用`, 'warning');
        }
        if (notifyUser) {
            notify(`扫描完成：新增 ${result.created} · 更新 ${result.updated} · 跳过 ${result.skipped}`, 'info');
        }
        return result;
    } catch (error) {
        console.error('[f2b] 扫描失败', error);
        if (panelEl) {
            const status = panelEl.querySelector('[data-role="backend"]');
            if (status) status.innerHTML = `<span class="f2b-dot f2b-dot-bad"></span>扫描失败：${escapeHtml(error?.message ?? String(error))}`;
        }
        return null;
    } finally {
        if (panelEl) {
            const status = panelEl.querySelector('[data-role="backend"]');
            if (status) status.innerHTML = backendStatusText();
        }
        void loadProbes();
    }
}

/**
 * 挂载悬浮球与面板。
 * @returns {void}
 */
export function mount() {
    if (mounted) return;
    mounted = true;
    const settings = getSettings();

    ballEl = document.createElement('button');
    ballEl.type = 'button';
    ballEl.id = 'f2b-ball';
    ballEl.className = 'f2b-ball';
    ballEl.style.zIndex = String(Z_BALL);
    ballEl.innerHTML = '<i class="fa-solid fa-bolt"></i><span class="f2b-badge" style="display:none">0</span>';
    ballEl.style.display = settings.ball.visible ? '' : 'none';
    document.body.appendChild(ballEl);

    panelEl = document.createElement('div');
    panelEl.id = 'f2b-panel';
    panelEl.className = 'f2b-panel';
    panelEl.style.zIndex = String(Z_PANEL);
    panelEl.innerHTML = `
        <div class="f2b-panel-head" data-role="drag">
            <div class="f2b-panel-title"><i class="fa-solid fa-bolt"></i> F2B 后端 API</div>
            <div class="f2b-panel-actions">
                <span class="f2b-backend" data-role="backend"></span>
                <button class="f2b-icon-btn" data-act="scan" title="重新扫描"><i class="fa-solid fa-rotate"></i></button>
                <button class="f2b-icon-btn" data-act="close" title="关闭"><i class="fa-solid fa-xmark"></i></button>
            </div>
        </div>
        <div class="f2b-panel-sub" data-role="summary"></div>
        <div class="f2b-panel-body" data-role="list"></div>
        <div class="f2b-panel-foot">
            <span class="f2b-dim">删除配置即回到插件原本的前端直连</span>
            <span class="f2b-dim f2b-foot-grip" data-role="resize" title="拖动调整面板大小（双击恢复默认）"></span>
        </div>`;
    document.body.appendChild(panelEl);

    if (Number.isFinite(settings.ball.x) && Number.isFinite(settings.ball.y)) {
        ballEl.style.left = `${settings.ball.x}px`;
        ballEl.style.top = `${settings.ball.y}px`;
    }

    const persistBall = (x, y) => {
        settings.ball.x = Math.round(x);
        settings.ball.y = Math.round(y);
        saveSettings();
    };
    const persistPanel = (x, y) => {
        settings.panel.x = Math.round(x);
        settings.panel.y = Math.round(y);
        saveSettings();
    };

    makeDraggable(ballEl, ballEl, { onEnd: persistBall, onClick: togglePanel });
    const dragHandle = panelEl.querySelector('[data-role="drag"]');
    if (dragHandle instanceof HTMLElement) {
        makeDraggable(panelEl, dragHandle, { onEnd: persistPanel });
    }

    const resizeHandle = panelEl.querySelector('[data-role="resize"]');
    if (resizeHandle instanceof HTMLElement) {
        makeResizable(panelEl, resizeHandle, {
            onEnd: (w, h) => {
                settings.panel.w = w;
                settings.panel.h = h;
                saveSettings();
            },
        });
        // 双击把手恢复样式表里的默认尺寸。
        resizeHandle.addEventListener('dblclick', () => {
            settings.panel.w = null;
            settings.panel.h = null;
            saveSettings();
            panelEl.style.width = '';
            panelEl.style.height = '';
            panelEl.style.maxHeight = '';
            clampPanel();
        });
    }

    panelEl.addEventListener('click', (event) => {
        onPanelClick(event).catch((error) => {
            console.error('[f2b] 面板操作失败', error);
            notify(`操作失败：${error?.message ?? error}`, 'error');
        });
    });
    panelEl.addEventListener('change', onPanelChange);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && panelOpen) closePanel();
    });
    window.addEventListener('resize', () => {
        if (panelOpen) clampPanel();
    });

    render();
}

/**
 * 把一小组开关挂进酒馆的“扩展设置”抽屉，便于找回悬浮球。
 * @returns {void}
 */
export function mountDrawerSettings() {
    const container = document.querySelector('#extensions_settings2');
    if (!container) return;
    if (container.querySelector('#f2b-drawer')) return;
    const settings = getSettings();
    // 用酒馆标准的 inline-drawer 结构：和别的插件一模一样的外观，
    // 折叠由 script.js 里 document 级 .inline-drawer-toggle 处理器负责（点标题展开/收起）。
    const block = document.createElement('div');
    block.id = 'f2b-drawer';
    block.className = 'inline-drawer f2b-drawer wide100p';
    block.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>F2B 前端 API 转后端</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="flex-container flexFlowColumn">
                <label class="checkbox_label"><input type="checkbox" id="f2b-drawer-ball" ${settings.ball.visible ? 'checked' : ''}> 显示左上角悬浮球</label>
                <label class="checkbox_label"><input type="checkbox" id="f2b-drawer-intercept" ${settings.intercept ? 'checked' : ''}> 启用请求转发</label>
                <label class="checkbox_label"><input type="checkbox" id="f2b-drawer-auto" ${settings.autoConvert ? 'checked' : ''}> 检测到前端 API 配置时自动转为后端</label>
                <label class="checkbox_label"><input type="checkbox" id="f2b-drawer-probe" ${settings.probeFrontend ? 'checked' : ''}> 探测插件是否真的从前端调用</label>
                <label class="checkbox_label"><input type="checkbox" id="f2b-drawer-rescue" ${settings.rescueOnFailure ? 'checked' : ''}> 前端直连失败时自动改走后端（推荐）</label>
                <div class="f2b-drawer-actions">
                    <button class="menu_button" id="f2b-drawer-open">配置面板</button>
                    <button class="menu_button" id="f2b-drawer-rescan">重新扫描</button>
                </div>
                <div class="f2b-drawer-hint">后端插件：<code>${PLUGIN_ID}</code>（需放在 &lt;SillyTavern&gt;/plugins 并开启 enableServerPlugins）</div>
            </div>
        </div>`;
    container.appendChild(block);

    block.querySelector('#f2b-drawer-ball')?.addEventListener('change', (event) => {
        setBallVisible(event.currentTarget.checked);
    });
    block.querySelector('#f2b-drawer-intercept')?.addEventListener('change', (event) => {
        getSettings().intercept = event.currentTarget.checked;
        invalidateRoutes();
        saveSettings();
        render();
    });
    block.querySelector('#f2b-drawer-auto')?.addEventListener('change', (event) => {
        getSettings().autoConvert = event.currentTarget.checked;
        saveSettings();
    });
    block.querySelector('#f2b-drawer-probe')?.addEventListener('change', (event) => {
        getSettings().probeFrontend = event.currentTarget.checked;
        saveSettings();
    });
    block.querySelector('#f2b-drawer-rescue')?.addEventListener('change', (event) => {
        getSettings().rescueOnFailure = event.currentTarget.checked;
        saveSettings();
    });
    block.querySelector('#f2b-drawer-open')?.addEventListener('click', () => openPanel());
    block.querySelector('#f2b-drawer-rescan')?.addEventListener('click', () => { void doScan(true); });
}

/**
 * 外部触发一次重绘（例如人物卡切换后）。
 * @returns {void}
 */
export function refresh() {
    render();
}

/**
 * 面板是否打开。
 * @returns {boolean} 打开为 true
 */
export function isPanelOpen() {
    return panelOpen;
}

/**
 * 对外暴露打开面板的能力（供斜杠命令或外部调用）。
 * @returns {void}
 */
export function openPanelFromOutside() {
    openPanel();
}

/**
 * 记住密钥指纹（供 UI 在保存后刷新提示）。
 * @param {object} entry 条目
 * @param {string} apiKey 明文密钥
 * @returns {void}
 */
export function rememberKeyHint(entry, apiKey) {
    const hint = keyHintOf(apiKey);
    if (!hint) return;
    entry.keyHint = hint;
    upsertEntry(entry);
}
