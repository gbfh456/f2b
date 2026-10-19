/**
 * 保留浏览器原生 fetch 的引用。
 *
 * 转发层会替换 window.fetch，而后端通信本身绝不能被自己拦截（否则递归），
 * 因此所有插件接口调用都使用这里的原始实现。
 * 模块在转发层安装之前完成求值，所以拿到的永远是原生函数。
 */
export const nativeFetch = window.fetch.bind(window);
