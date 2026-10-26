#!/usr/bin/env node
/**
 * f2b 卸载脚本。
 *
 * 位置：<SillyTavern>/public/scripts/extensions/third-party/f2b/uninstall.mjs
 * 用法（在任意目录执行都行，脚本自己会定位酒馆根目录）：
 *
 *   node public/scripts/extensions/third-party/f2b/uninstall.mjs            # 交互确认后删除
 *   node public/scripts/extensions/third-party/f2b/uninstall.mjs --dry-run  # 只看要删什么
 *   node public/scripts/extensions/third-party/f2b/uninstall.mjs --yes      # 不确认，直接删
 *   node public/scripts/extensions/third-party/f2b/uninstall.mjs --keep-keys # 保留已保存的密钥
 *
 * 清掉的东西：
 *   1. <ST>/plugins/<任意目录>         —— 按 index.mjs 里的 info.id 认，不写死目录名
 *   2. <ST>/public/scripts/extensions/third-party/f2b/  —— 前端扩展本体（含 .git、含本脚本）
 *   3. <ST>/data/<用户>/f2b-takeover/  —— 服务端的配置与明文密钥（--keep-keys 可保留）
 *   4. <ST>/data/<用户>/settings.json  —— extension_settings.f2b 与 disabledExtensions 里的 third-party/f2b（改前留 .bak 备份）
 *
 * 清不掉、也不该由脚本处理的：
 *   - 正在运行的酒馆进程里已经加载的插件路由 —— 必须重启进程（脚本发现端口在监听时会拒绝执行）
 *   - ST 的聊天/设置备份目录 —— 里面的历史 settings 快照可能还留着 f2b 的配置项（不含密钥文件）
 *   - 浏览器里的任何东西 —— f2b 只读 localStorage，不往里写，所以本来就没有残留
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';

/** 服务端插件 id，写在 plugins/<目录>/index.mjs 的 info.id 里。 */
const PLUGIN_ID = 'f2b-takeover';
/** extension_settings 里的命名空间。 */
const SETTINGS_KEY = 'f2b';

const argv = new Set(process.argv.slice(2));
const want = (...names) => names.some(name => argv.has(name));
const DRY_RUN = want('--dry-run', '-n');
const ASSUME_YES = want('--yes', '-y');
const KEEP_KEYS = want('--keep-keys');
const FORCE = want('--force');

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const cyan = text => paint('36', text);
const green = text => paint('32', text);
const yellow = text => paint('33', text);
const red = text => paint('31', text);
const dim = text => paint('2', text);

/**
 * 脚本所在目录（= 前端扩展目录）。
 * @type {string}
 */
const SCRIPT_DIR = import.meta.dirname;

/**
 * 是否是酒馆根目录。
 * @param {string} dir 目录
 * @returns {boolean} 是否
 */
function looksLikeSTRoot(dir) {
    try {
        if (!fs.existsSync(path.join(dir, 'public', 'scripts', 'extensions', 'third-party'))) return false;
        const pkgPath = path.join(dir, 'package.json');
        if (!fs.existsSync(pkgPath)) return false;
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return typeof pkg?.name === 'string' && /sillytavern/i.test(pkg.name);
    } catch {
        return false;
    }
}

/**
 * 定位酒馆根目录：先从脚本位置往上推，再退到当前工作目录。
 * @returns {string} 根目录（找不到返回空串）
 */
function findServerRoot() {
    let dir = SCRIPT_DIR;
    for (let i = 0; i < 8; i++) {
        dir = path.dirname(dir);
        if (looksLikeSTRoot(dir)) return dir;
    }
    let cwd = process.cwd();
    for (let i = 0; i < 8; i++) {
        if (looksLikeSTRoot(cwd)) return cwd;
        const parent = path.dirname(cwd);
        if (parent === cwd) break;
        cwd = parent;
    }
    return '';
}

/**
 * 相对根目录的短路径，便于阅读。
 * @param {string} root 根目录
 * @param {string} target 目标
 * @returns {string} 相对路径
 */
function rel(root, target) {
    const value = path.relative(root, target);
    return value === '' ? '.' : value.split(path.sep).join('/');
}

/**
 * 从 config.yaml 里读端口（读不到就用 8000）。
 * @param {string} root 根目录
 * @returns {number} 端口
 */
function readPort(root) {
    try {
        const text = fs.readFileSync(path.join(root, 'config.yaml'), 'utf8');
        const match = /^port:\s*(\d+)/m.exec(text);
        if (match) return Number(match[1]);
    } catch {
        // 忽略：没有配置文件就用默认端口。
    }
    return 8000;
}

/**
 * 端口上是否有人在监听（用来判断酒馆是不是还开着）。
 * @param {number} port 端口
 * @returns {Promise<boolean>} 是否在监听
 */
function isListening(port) {
    return new Promise(resolve => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const done = (result) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(800);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}

/**
 * 读一个插件目录的入口文件文本（package.json 的 main 优先，其次 index.mjs/.cjs/.js）。
 * @param {string} dir 目录
 * @returns {string} 入口源码（没有则为空串）
 */
function entrySourceOf(dir) {
    const candidates = [];
    try {
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (typeof pkg?.main === 'string') candidates.push(path.join(dir, pkg.main));
        }
    } catch {
        // 忽略损坏的 package.json。
    }
    candidates.push(path.join(dir, 'index.mjs'), path.join(dir, 'index.cjs'), path.join(dir, 'index.js'));
    for (const file of candidates) {
        try {
            if (fs.statSync(file).isFile()) return fs.readFileSync(file, 'utf8');
        } catch {
            // 继续试下一个。
        }
    }
    return '';
}

/**
 * 找出所有声明了 f2b-takeover 这个 id 的插件目录。
 * 目录名可以是 f2b、f2b-takeover 或者别的（id 才决定路由），所以按源码认。
 * @param {string} root 根目录
 * @returns {string[]} 插件目录绝对路径
 */
function findPluginDirs(root) {
    const pluginsRoot = path.join(root, 'plugins');
    /** @type {string[]} */
    const found = [];
    let entries = [];
    try {
        entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
    } catch {
        return found;
    }
    const idPattern = new RegExp(`id\\s*:\\s*['"]${PLUGIN_ID}['"]`);
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(pluginsRoot, entry.name);
        if (idPattern.test(entrySourceOf(dir))) found.push(dir);
    }
    return found;
}

/**
 * 找前端扩展目录：本脚本所在目录必然算一个；再顺手扫一遍 third-party 里 display_name 含 f2b 的。
 * @param {string} root 根目录
 * @returns {string[]} 扩展目录绝对路径
 */
function findExtensionDirs(root) {
    /** @type {Set<string>} */
    const found = new Set();
    if (fs.existsSync(SCRIPT_DIR)) found.add(SCRIPT_DIR);
    const thirdParty = path.join(root, 'public', 'scripts', 'extensions', 'third-party');
    try {
        for (const entry of fs.readdirSync(thirdParty, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const dir = path.join(thirdParty, entry.name);
            try {
                const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
                if (typeof manifest?.display_name === 'string' && /f2b/i.test(manifest.display_name)) found.add(dir);
            } catch {
                // 没有 manifest 的目录不管。
            }
        }
    } catch {
        // third-party 不存在就算了。
    }
    return [...found];
}

/**
 * 从 settings.json 里清掉 f2b 的痕迹：`extension_settings.f2b` 与 `disabledExtensions` 里的 `third-party/f2b`。
 * @param {object} namespace extension_settings 对象
 * @returns {boolean} 是否改动了
 */
function cleanNamespace(namespace) {
    if (!namespace || typeof namespace !== 'object') return false;
    let changed = false;
    if (Object.hasOwn(namespace, SETTINGS_KEY)) {
        delete namespace[SETTINGS_KEY];
        changed = true;
    }
    // 用户停用过这个扩展的话，`disabledExtensions` 里还留着 "third-party/f2b"，一并摘掉。
    if (Array.isArray(namespace.disabledExtensions)) {
        const kept = namespace.disabledExtensions.filter(name => path.basename(String(name)) !== SETTINGS_KEY);
        if (kept.length !== namespace.disabledExtensions.length) {
            namespace.disabledExtensions = kept;
            changed = true;
        }
    }
    return changed;
}

/**
 * settings.json 里是否还有 f2b 的痕迹（设置命名空间或停用列表）。
 * @param {string} file settings.json
 * @returns {'has'|'clean'|'broken'} 结果（broken = 不是合法 JSON）
 */
function settingsNamespaceState(file) {
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const namespace = data?.extension_settings;
        if (!namespace || typeof namespace !== 'object') return 'clean';
        if (Object.hasOwn(namespace, SETTINGS_KEY)) return 'has';
        if (Array.isArray(namespace.disabledExtensions)
            && namespace.disabledExtensions.some(name => path.basename(String(name)) === SETTINGS_KEY)) return 'has';
        return 'clean';
    } catch {
        return 'broken';
    }
}

/**
 * 找每个用户目录下的 f2b-takeover 存储目录，以及确实含 f2b 设置的 settings.json。
 * @param {string} root 根目录
 * @returns {{settings: Array<{file: string, state: 'has'|'broken'}>, keyDirs: string[]}} 结果
 */
function findUserArtifacts(root) {
    /** @type {Array<{file: string, state: 'has'|'broken'}>} */
    const settings = [];
    /** @type {string[]} */
    const keyDirs = [];
    const dataRoot = path.join(root, 'data');
    let entries = [];
    try {
        entries = fs.readdirSync(dataRoot, { withFileTypes: true });
    } catch {
        return { settings, keyDirs };
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
        const userDir = path.join(dataRoot, entry.name);
        const settingsFile = path.join(userDir, 'settings.json');
        if (fs.existsSync(settingsFile)) {
            const state = settingsNamespaceState(settingsFile);
            if (state !== 'clean') settings.push({ file: settingsFile, state });
        }
        const keyDir = path.join(userDir, PLUGIN_ID);
        if (fs.existsSync(keyDir) && fs.statSync(keyDir).isDirectory()) keyDirs.push(keyDir);
    }
    return { settings, keyDirs };
}

/**
 * 从 settings.json 里清掉 f2b 的痕迹（改前留一份 .bak）。
 * @param {string} file settings.json
 * @returns {Promise<'changed'|'clean'|'broken'>} 结果
 */
async function stripSettingsNamespace(file) {
    const raw = await fsp.readFile(file, 'utf8');
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        return 'broken';
    }
    if (!cleanNamespace(data?.extension_settings)) return 'clean';
    if (DRY_RUN) return 'changed';
    // 尽量沿用原文件的缩进与结尾换行，避免把 settings.json 整体重排。
    const indentMatch = /\n([ \t]+)"/.exec(raw);
    const indent = indentMatch ? indentMatch[1] : 4;
    const trailing = raw.endsWith('\n') ? '\n' : '';
    await fsp.copyFile(file, `${file}.bak-f2b-uninstall`);
    await fsp.writeFile(file, JSON.stringify(data, null, indent) + trailing, 'utf8');
    return 'changed';
}

/**
 * 删除一个目录；本脚本自己所在的目录先在别处 chdir 再删（Windows 上更稳）。
 * @param {string} target 目录
 * @returns {Promise<boolean>} 是否删成功
 */
async function removeDir(target) {
    try {
        const self = path.resolve(target) === path.resolve(SCRIPT_DIR);
        if (self) process.chdir(os.tmpdir());
        await fsp.rm(target, { recursive: true, force: true });
        return true;
    } catch (error) {
        console.error(red(`删除失败：${target}`), dim(error?.message ?? String(error)));
        return false;
    }
}

/**
 * 询问 y/N。
 * @param {string} question 问题
 * @returns {Promise<boolean>} 是否确认
 */
async function confirm(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = (await rl.question(question)).trim().toLowerCase();
        return answer === 'y' || answer === 'yes';
    } finally {
        rl.close();
    }
}

/**
 * 主流程。
 * @returns {Promise<void>} 完成
 */
async function main() {
    if (want('--help', '-h')) {
        const doc = fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]
            .replace(/^#!.*\n/, '')
            .replace(/^\s*\/\*\*\s*/, '')
            .replace(/^\s*\*\s?/gm, '')
            .trim();
        console.log(doc);
        return;
    }

    const root = findServerRoot();
    if (!root) {
        console.error(red('找不到 SillyTavern 根目录。'));
        console.error(dim('请在酒馆根目录执行，或确认脚本位于 public/scripts/extensions/third-party/f2b/ 下。'));
        process.exitCode = 1;
        return;
    }

    const port = readPort(root);
    const running = await isListening(port);
    const pluginDirs = findPluginDirs(root);
    const extensionDirs = findExtensionDirs(root);
    const { settings, keyDirs } = findUserArtifacts(root);

    console.log();
    console.log(cyan('f2b 卸载') + dim(`  ·  酒馆根目录 ${root}`));
    console.log();

    if (pluginDirs.length === 0 && extensionDirs.length === 0 && keyDirs.length === 0 && settings.length === 0) {
        console.log(green('没有发现 f2b 残留，可能已经卸载过了。'));
        console.log();
        return;
    }

    /** @type {string[]} */
    const lines = [];
    for (const dir of pluginDirs) lines.push(`  ${yellow('删除')}  服务端插件  ${rel(root, dir)}/`);
    for (const dir of extensionDirs) lines.push(`  ${yellow('删除')}  前端扩展    ${rel(root, dir)}/`);
    if (KEEP_KEYS) {
        for (const dir of keyDirs) lines.push(`  ${dim('保留')}  服务端密钥  ${rel(root, dir)}/${dim('  (--keep-keys)')}`);
    } else {
        for (const dir of keyDirs) lines.push(`  ${yellow('删除')}  配置与密钥  ${rel(root, dir)}/${dim('  (含明文 key)')}`);
    }
    for (const item of settings) {
        lines.push(item.state === 'broken'
            ? `  ${dim('跳过')}  ${rel(root, item.file)} ${dim('（不是合法 JSON，需要手动删 f2b 项）')}`
            : `  ${yellow('清理')}  ${rel(root, item.file)} ${dim('里的 extension_settings.f2b 与停用列表')}`);
    }

    console.log('将要处理：');
    console.log(lines.join('\n'));
    console.log();

    if (DRY_RUN) {
        console.log(dim('--dry-run：只显示计划，没有改动任何文件。'));
        console.log();
        return;
    }

    if (running && !FORCE) {
        console.log(red(`检测到 127.0.0.1:${port} 上有酒馆在运行。`));
        console.log(dim('先停掉酒馆再卸载：正在运行的进程会把插件路由留在内存里，而且它稍后保存 settings.json 时'));
        console.log(dim('会覆盖掉本脚本对 extension_settings.f2b 的清理。确实要现在删就加 --force。'));
        console.log();
        process.exitCode = 1;
        return;
    }

    console.log(dim('注意：扩展目录里的 .git 与未推送的本地改动会一并删除；本脚本自己也会被删掉。'));
    if (!ASSUME_YES) {
        if (!process.stdin.isTTY) {
            console.log(yellow('当前不是交互终端，加 --yes 才会执行。'));
            console.log();
            process.exitCode = 1;
            return;
        }
        const ok = await confirm(`确认删除以上内容？${dim('[y/N]')} `);
        if (!ok) {
            console.log('已取消，什么都没删。');
            console.log();
            return;
        }
    }

    /** @type {string[]} */
    const failed = [];

    for (const dir of keyDirs) {
        if (KEEP_KEYS) continue;
        if (!(await removeDir(dir))) failed.push(dir);
    }
    for (const dir of pluginDirs) {
        if (!(await removeDir(dir))) failed.push(dir);
    }

    /** @type {string[]} */
    const brokenSettings = [];
    for (const item of settings) {
        if (item.state === 'broken') {
            brokenSettings.push(item.file);
            continue;
        }
        try {
            const result = await stripSettingsNamespace(item.file);
            if (result === 'broken') brokenSettings.push(item.file);
        } catch (error) {
            failed.push(item.file);
            console.error(red(`清理设置失败：${item.file}`), dim(error?.message ?? String(error)));
        }
    }

    // 扩展目录最后删：脚本自己也住在里面。
    for (const dir of extensionDirs) {
        if (!(await removeDir(dir))) failed.push(dir);
    }

    console.log();
    if (failed.length === 0) {
        console.log(green('已清理完成。'));
    } else {
        console.log(yellow(`部分未清理成功（${failed.length} 项）：`));
        for (const item of failed) console.log(`  ${rel(root, item)}`);
        console.log(dim('Windows 上通常是文件被占用：关掉酒馆/编辑器后手动删除即可。'));
    }

    for (const file of brokenSettings) {
        console.log(yellow(`settings.json 不是合法 JSON，没敢改：${rel(root, file)}`));
        console.log(dim('手动删掉里面的 "f2b": {...} 即可。'));
    }

    if (running) {
        console.log(yellow('酒馆还在运行：重启进程，插件路由才会真正消失。'));
    } else {
        console.log(dim('重启酒馆后，/api/plugins/f2b-takeover 与面板都不会再出现。'));
    }
    console.log(dim('没动备份目录 data/<用户>/backups/：里面的历史 settings 快照可能仍含 f2b 的配置项（不含密钥）。'));
    console.log();
}

await main();
