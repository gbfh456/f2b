# f2b-takeover（SillyTavern 服务端插件）

给第三方前端（如 JS-Slash-Runner）用的**管理员专用透明流式反向代理**：把请求交给本插件转发，
密钥只存在服务端，前端永远拿不到明文 Key。同时提供连通性测试、配置存储和仅含元数据的请求日志。

本文件是**后端**（服务端插件）的说明。仓库根目录的 `README.md` 是前端面板的完整说明。

## 安装

前端扩展与服务端插件共用这一个仓库，安装两次、指向同一个地址即可（细节见根目录 `README.md` 第二节）：

```bash
# 前端扩展（等价于在酒馆界面「安装扩展」里填仓库地址）
git clone https://github.com/gbfh456/f2b.git public/scripts/extensions/third-party/f2b

# 服务端插件（在酒馆根目录执行；等价于 node plugins.js install <仓库地址>）
git clone https://github.com/gbfh456/f2b.git plugins/f2b
```

`config.yaml` 里确认：

```yaml
enableServerPlugins: true
enableServerPluginsAutoUpdate: true   # plugins/f2b 是 git 克隆，启动时自动 pull
```

然后**重启酒馆进程**。日志出现 `Initializing plugin from .../plugins/f2b/index.mjs` 即成功。

目录名不影响路由：插件 id 来自本目录 `index.mjs` 里的 `info.id`，路由恒为 `/api/plugins/f2b-takeover`。
但**不要同时存在两个声明同一 id 的目录**（例如旧的 `plugins/f2b-takeover`），
后加载的那个会报 `plugin ID is already in use`。

> 为什么不能在网页里一键装好服务端插件：酒馆只为前端扩展开放了远程安装接口
> （`POST /api/extensions/install`，落点固定是 `public/scripts/extensions/third-party`），
> `plugins/` 没有任何 HTTP 写入路径，而插件也无法在尚未加载时安装自己。这一步只能在宿主机执行。

要求：SillyTavern 1.19.0+ / Node 18+。无需 `npm install`（只用 ST 自带的 `express` 与 `node-fetch`）。

## 接口

基地址：`/api/plugins/f2b-takeover`。除 `/health` 外都需要**管理员账号**（非管理员一律 403），
并且浏览器必须带上 CSRF 头 `X-CSRF-Token`。响应除流式代理外均为 JSON；
错误统一为 `{"ok":false,"error":"...","code":"..."}`（400 参数错误 / 403 无权限 / 502 上游网络失败 / 504 超时）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活探测，返回 `{ok,id,version,node,features}` |
| POST | `/proxy` | 核心透明代理，**原样流式回传**上游响应（含非 2xx、含 SSE） |
| POST | `/test` | 服务端连通性测试，始终返回 HTTP 200 |
| GET | `/config` | 读取配置条目（密钥只返回 `hasKey` / `keyPreview`） |
| POST | `/config` | 写入/更新/删除配置条目与密钥 |
| GET | `/log?limit=50` | 请求日志，**最新在前**，每个用户最多 200 条 |
| POST | `/log/clear` | 清空日志 |

### POST /proxy

```json
{
  "url": "https://api.example.com/v1/chat/completions",
  "method": "POST",
  "headers": { "authorization": "Bearer sk-...", "content-type": "application/json" },
  "bodyEncoding": "none",
  "body": "",
  "timeoutMs": 600000,
  "cfgId": "cfg_ab12",
  "label": "JS-Slash-Runner"
}
```

- `url` 仅允许 `http`/`https`；指向本机同一端口会被判定为回环并返回 `400 / CIRCULAR`。
- `bodyEncoding`：`none`（默认）| `text`（原文）| `base64`。
- `timeoutMs` 默认 600000，上限 900000，超时返回 `504 / TIMEOUT`。
- `host`、`cookie`、`origin`、`referer`、`x-csrf-token`、`sec-*`、`x-forwarded-*` 等请求头会被剥离，
  `accept-encoding` 固定为 `gzip, deflate, br`；响应**不解压、不缓冲**，`content-encoding`（gzip/br）原样保留，
  由浏览器自行解码；响应头 `Cache-Control: no-transform` 用于关闭 ST 的全局压缩，保证 SSE 实时到达。
- 上游返回 401/404 等非 2xx 属于**转发成功**，按原状态码返回。

### 服务端覆盖（`cfgId`）

带上 `cfgId` 时按以下顺序应用服务端存储的配置：

1. `target.baseUrl` 非空 → 以它为前缀重建目标地址；`pathRewrite` 默认空串，表示把原始 path+search
   原样拼到 `baseUrl` 后面（自动处理结尾斜杠）；非空时用它替换原始 path（search 保留）。
2. `target.model` 非空且请求体是 JSON → 覆盖顶层 `model` 字段。
3. `extraHeaders` 合并进出站请求头（**服务端值优先**）。
4. 该 `cfgId` 存有密钥时：
   - `authStyle: "header"`（默认）→ 设置 `authHeader`（默认 `authorization`）为
     `authPrefix`（默认 `Bearer `）+ 密钥，**覆盖前端传来的值**；
   - `authStyle: "query"` → 把 `authQueryName`（默认 `api_key`）写进查询参数，并删除前端的认证头。

### POST /test

```json
{ "url": "https://api.example.com/v1/models", "method": "GET", "headers": {}, "timeoutMs": 20000 }
```

始终 HTTP 200。可达：`{ok:true,status,statusText,ms,headers,preview,truncated,authError}`，
其中 `preview` 为响应正文前 2000 字符（最多读取 64 KB），`authError` 在 401/403 时为 `true`；
网络失败：`{ok:false,error,code,ms}`（如 `ENOTFOUND`、`ECONNREFUSED`）。

### POST /config

```json
{
  "cfgId": "cfg_ab12",
  "target": {
    "baseUrl": "", "model": "", "pathRewrite": "",
    "authStyle": "header", "authHeader": "authorization",
    "authPrefix": "Bearer ", "authQueryName": "api_key", "timeoutMs": 600000
  },
  "extraHeaders": {},
  "apiKey": "sk-..."
}
```

- 省略 `apiKey` → 保留原密钥；`apiKey: ""` 或 `"delete": true` → 删除该条目（配置 + 密钥）。
- 返回 `{ok:true,hasKey,keyPreview}`，`keyPreview` 形如 `sk-…cdef`，**任何接口都不会返回完整密钥**。

## 存储与安全

- 配置：`<数据目录>/<用户名>/f2b-takeover/config.json`；密钥：同目录 `secrets.json`，
  原子写入（临时文件 + rename），并尽力设置 `0600`（Windows 上会被忽略）。
  存储位置只取决于用户名，与插件目录名无关 —— 把 `plugins/f2b-takeover` 换成 `plugins/f2b` 不会丢配置。
- 文件缺失或损坏只会告警并按空配置处理，不会崩溃。
- 请求体上限 64 MB，超出返回 413。
- 出站请求走 `node-fetch`（继承 ST 的 SSRF 全局 agent），**不使用**全局 `fetch`。
- 日志只记录：时间、`cfgId`、`label`、URL（截断 300 字符，且 `key|token|secret|password|sig`
  这类查询参数的值替换为 `***`）、方法、状态码、耗时、字节数、错误摘要——**不含请求/响应正文、请求头或密钥**。
- 本插件在 `<ST>/plugins/` 之外不写任何文件。
