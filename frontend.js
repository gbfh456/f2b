/**
 * F2B —— 把“插件 / 人物卡里从前端直连的 API 配置”换成走后端的配置。
 *
 * 为什么需要它：像火山方舟（ark.cn-beijing.volces.com）这类接口不允许浏览器直连
 * （CORS / 防盗链 / 不允许明文密钥出现在前端），第三方插件却常常自己 fetch。
 *
 * 工作方式：
 *   1. 扫描 extension_settings（插件）与当前人物卡，找出“接口地址 + 密钥 + 模型”；
 *   2. 把这些配置转成“后端配置”：密钥与地址写进服务端插件 f2b-takeover，
 *      前端只保留来源、地址、模型与密钥指纹；
 *   3. 拦截命中该配置的 fetch / XHR，改由服务端转发，响应原样流回；
 *   4. 左上角悬浮球里可以查看 / 修改 / 测试 / 拉模型 / 删除（删除 = 回到前端直连）。
 */

import { eventSource, event_types } from '../../../../script.js';
import { checkBackend } from './src/backend.js';
import { adoptAllFrames, installFrameInterception, installInterception, onRuntimeEvent } from './src/intercept.js';
import { getSettings, normalizeAllEntries } from './src/store.js';
import { debounce } from './src/util.js';
import { doScan, mount, mountDrawerSettings, onRuntimeCaptured, refresh } from './src/ui.js';

/** 人物卡切换 / 编辑后的重扫（防抖，避免拖拽角色列表时反复扫描）。 */
const scheduleRescan = debounce(() => { void doScan(false); }, 900);

/** 订阅与“配置可能变化”相关的事件。 */
function wireEvents() {
    const watched = [
        event_types.CHAT_CHANGED,
        event_types.CHARACTER_EDITED,
        event_types.CHARACTER_RENAMED,
        event_types.CHARACTER_DELETED,
        event_types.CHARACTER_DUPLICATED,
        event_types.CHARACTER_PAGE_LOADED,
        event_types.SETTINGS_LOADED_AFTER,
        // 扩展全部加载完：这时才能从已加载资源里认出「子目录属于哪个插件」，
        // 所以再扫一次，把 txtToWorldbookSettings 这类键归到宿主插件名下。
        event_types.APP_READY,
    ].filter(Boolean);
    for (const eventName of watched) {
        eventSource.on(eventName, () => {
            scheduleRescan();
            refresh();
        });
    }
}

/** 完成一次启动初始化。 */
async function init() {
    getSettings();
    normalizeAllEntries();
    mount();
    mountDrawerSettings();
    wireEvents();
    // 运行中才暴露出来的前端调用（localStorage 里的配置、脚本自己拼的地址…）也要能接住。
    onRuntimeEvent(onRuntimeCaptured);
    // 卡片内的界面（小手机等）跑在同源 iframe 里，顶层补丁管不到，必须逐个窗口接管。
    try {
        installFrameInterception();
    } catch (error) {
        console.warn('[f2b] 接管 iframe 失败（卡片内界面仍会走浏览器直连）', error);
    }
    await checkBackend();
    await doScan(false);
    // 兜底：某些插件（loading_order 很大）加载得更晚，APP_READY 之后再过几秒补扫一次。
    setTimeout(scheduleRescan, 6000);
    setTimeout(scheduleRescan, 15000);
    console.debug('[f2b] 已就绪：悬浮球在页面左上角，点击可查看后端 API 配置');
}

// 转发层尽早安装，尽量覆盖第三方插件启动阶段发出的请求。
try {
    installInterception();
    // 已经存在的 iframe 也顺手接管（酒馆助手常在扩展加载前就建好界面帧）。
    installFrameInterception();
} catch (error) {
    console.error('[f2b] 安装请求转发层失败（将只提供服务端配置管理）', error);
}

// 帧是动态创建的：定期补扫一次，成本可以忽略（已接管的窗口会跳过）。
setInterval(() => {
    try {
        adoptAllFrames();
    } catch {
        // 忽略。
    }
}, 4000);

jQuery(async () => {
    try {
        await init();
    } catch (error) {
        console.error('[f2b] 初始化失败', error);
    }
});
