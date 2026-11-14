# ZCode 反向代理

**把 ZCode 的完整 agent 能力，变成一个 OpenAI 兼容的本地 API 服务。**

其他任何支持"自定义 OpenAI 接口"的软件（Cherry Studio、Dify、Cline、Roo Code、LangChain、OpenAI SDK……）填入本服务地址后，就能像调用普通大模型一样调用 ZCode——但背后执行的是**完整的 ZCode agent**：能读写文件、执行命令、使用技能，就像在 ZCode 输入框里说话一样。

一个 Apple 风格的桌面应用负责一切：代理开关、账号管理、会话隔离，系统托盘常驻。

---

## 功能特性

- **OpenAI 兼容 API**：`POST /v1/chat/completions`（流式 / 非流式）+ `GET /v1/models`，第三方零改造接入
- **Agent 即模型**：不透传 function calling——ZCode 自己决定何时使用工具，暴露的是"能干活的 agent"而非裸模型
- **真流式输出**：引擎的 `text_delta` 增量直接映射为 OpenAI SSE chunk
- **自动会话亲和**：同一任务的连续对话自动续接同一个 ZCode 原生会话（含工具执行过程记忆）；并发任务之间完全隔离，绝不串答
- **账号管理**：国际 Z.AI / 国内 BigModel 双体系槽位，显示账号名与运行状态，支持添加 / 删除 / 一键检测 / 失败原因展示与重新登录引导
- **桌面体验**：系统托盘（运行状态双色图标）、关闭到托盘或直接退出、开机自启、主界面大开关
- **免配置**：自动探测 ZCode 安装路径与数据目录，自动连接桌面版已有登录凭据

## 架构

```
第三方软件（Cherry Studio / Dify / Cline / OpenAI SDK）
        │  OpenAI 协议  POST /v1/chat/completions
        ▼
ZCode 反向代理（Electron 桌面应用，127.0.0.1:8787）
        │  ZCode Protocol（NDJSON over stdio，与桌面版同款驱动方式）
        ▼
常驻 ZCode 引擎（zcode app-server --stdio）
        │  启动时推送账号快照（把订阅计划标记为可用）
        │  模型请求鉴权由代理注入（读取与桌面版共享的凭据库）
        ▼
Z.AI / BigModel Coding Plan 端点
```

工作原理要点：

1. 代理启动时拉起**一个常驻 ZCode 引擎进程**（`zcode app-server --stdio`），协议与 ZCode 桌面版完全一致
2. 通过 `provider/updateAccountConfig` 推送账号快照，让无头模式下也能使用你已订阅的 Start Plan / Coding Plan 模型
3. 引擎发起模型请求前会反向询问客户端运行时头，代理注入 `X-Zcode-Authorization: Bearer <JWT>`——JWT 直接读取与桌面版**共享的凭据库**（`<数据根>/.zcode/v2/credentials.json`，支持新的 enc:v2 系统密钥环加密），**无需单独登录**
4. 每个请求创建（或续接）一个 ZCode 会话，会话事件流（`text_delta`）实时转成 OpenAI 格式返回
5. 会话与桌面版共享 SQLite 存储，在 ZCode 桌面应用里可以看到

## 快速开始

### 方式一：安装包（推荐）

1. 双击 `ZCodeProxy-Setup.exe` 安装（无管理员弹窗，装到 `%LocalAppData%\ZCodeProxy`），可勾选桌面快捷方式与开机自启
2. 启动后打开面板：账号卡显示「已连接」即可直接使用；「未登录」时在 ZCode 桌面版登录一次（凭据库共享）
3. 在第三方软件里填：Base URL `http://127.0.0.1:8787/v1`，模型 `zcode`

### 方式二：源码运行

```cmd
cd /d D:\zcode_daat\fandai
node server.js        :: 纯后台模式（管理台在 http://127.0.0.1:8787/ 网页里）
:: 或双击 启动反代.bat
```

前提：本机已安装 Node.js（≥20）与 ZCode 桌面版。

### 构建安装包

```cmd
node build-installer.mjs
```

自动完成：布置 Electron 运行时与 NSIS 编译器（均缺则自动下载，Electron 走 npmmirror、NSIS 走 SourceForge 并有 winget 兜底）、生成 `resources/app`、编译出 `ZCodeProxy-Setup.exe`。仅需本机装有 Node.js。

## 客户端接入

| 设置项 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:8787/v1` |
| API Key | `config.json` 的 `apiKey`（留空 = 不鉴权，客户端随意填） |
| 模型 | `zcode`（国际 Z.AI）/ `zcode-bigmodel`（国内 BigModel），以 `models[].id` 为准 |

Python 示例：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="anything")

r = client.chat.completions.create(
    model="zcode",
    messages=[{"role": "user", "content": "帮我在 D:/test 写一个天气爬虫"}],
    stream=True,
)
for chunk in r:
    print(chunk.choices[0].delta.content or "", end="")
```

## 多轮记忆

**自动会话亲和（默认开启，零配置）**：客户端每轮发完整 `messages` 时，代理识别"这轮是上一轮的延续"，自动续接同一个 ZCode 原生会话、只发新消息。效果：

- 同一任务的连续对话在 ZCode 中保持为**一个连续会话**（不再碎片化）
- 历史不匹配的新任务自动开新会话；**并发任务完全隔离**（严格按 sessionId 过滤事件流 + 同会话请求自动排队）
- 匹配记录 LRU 保留 300 条

**显式控制**：响应头 `X-Zcode-Session-Id` / 响应体 `zcode_session_id` 返回会话 ID，下次请求带 `X-Zcode-Session-Id: sess_xxx` 强制指定续接对象。

## 配置参考（config.json）

首次运行自动生成；`zcodeExe`/`zcodeCjs` 留空 = 自动探测 ZCode 安装路径。

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` / `host` | 8787 / 127.0.0.1 | 监听地址 |
| `apiKey` | 空 | 非空时要求 `Authorization: Bearer <key>` |
| `zcodeExe` / `zcodeCjs` | 空 | ZCode 桌面版路径，留空自动探测 |
| `maxConcurrent` | 4 | 同时进行的回合上限，超出排队 |
| `timeoutMs` | 1800000 | 单请求超时（30 分钟，agent 任务可能很久） |
| `includeReasoning` | false | 流式时输出 `reasoning_content`（思考过程） |
| `cors` | true | 允许浏览器跨域 |
| `models[].id` | — | 对外模型名（客户端可见） |
| `models[].providerId` / `modelId` | — | 账号体系与真实模型（如 `account:zai-start-plan` / `GLM-5.3-Flash`） |
| `models[].reasoningLevel` | max | 思考档位（ZCode 模型必填） |
| `models[].cwd` | 空 | agent 工作目录（空 = 代理所在目录） |
| `models[].mode` | yolo | 权限模式（API 场景建议 yolo，其余模式会因无人确认而卡住） |
| `models[].disallowedTools` | [] | 禁用的工具列表 |

## 项目结构

```
├── desktop/            Electron 壳（main.js 主进程 / preload.js / renderer Apple 风格 UI）
├── server.js           OpenAI 兼容 API 服务 + 会话回合编排（createProxyServer 工厂，可 CLI 独立运行）
├── engine.js           ZCode 引擎封装（app-server 协议、账号快照推送、JWT 注入、凭据解密）
├── account-manager.js  双体系账号槽位（状态判定 / 删除清理 / 连通检测）
├── login-manager.js    CLI 登录向导（授权 URL 捕获 / 浏览器拉起 / 成功轮询）
├── adapter.js          OpenAI 协议 ↔ ZCode prompt/结果 转换
├── admin-ui.js         网页管理台（CLI 模式回退用）
├── installer/          NSIS 打包脚本
├── build-installer.mjs 一键编译安装包
├── vendor/             构建时下载的运行时（node.exe / Electron，不提交 git）
├── tools/              NSIS 便携版（不提交 git）
└── runtime/            运行数据与引擎日志（不提交 git）
```

## 安全须知

- 默认 `mode: yolo`：ZCode 会**自动执行工具**（写文件、跑命令）。请设置 `apiKey`、保持只监听本机（默认），必要时用 `disallowedTools` 收紧
- agent 任务耗时较长：客户端超时建议 ≥ 5 分钟（代理侧默认 30 分钟）
- 不上传/提交：`runtime/`（含凭据副本与日志）、`config.json`（含 apiKey）、`vendor/`、`tools/`、`*.exe`——详见 `.gitignore`

## 故障排查

| 现象 | 处理 |
|---|---|
| 账号卡显示「未登录」 | 在 ZCode 桌面版登录（凭据库共享，代理自动跟上） |
| 调用报 401 | 凭据过期：桌面版重新登录一次，或点账号卡「重新登录」 |
| `Provider Registry 中不存在 Model` | `providerId`/`modelId` 拼写不对（以 ZCode 模型选择器为准）；新版代理会自动重推快照恢复 |
| 报「余额/资源包不足」 | 该账号体系无对应订阅，换另一个模型名（额度互相独立） |
| `未知模型 "xxx"` | `model` 需与 `config.models[].id` 一致，见 `/v1/models` |
| 端口被占用 | 代理可能已在运行：打开 `http://127.0.0.1:8787/` 确认，或改 `port` |
| `无法读取 ZCode JWT` | 共享凭据库为空或不可解密：在 ZCode 桌面版重新登录 |

## 已知边界

- 每个请求新建引擎会话，首 token 延迟约 2–5 秒（引擎常驻，无进程冷启动）
- OpenAI 的 tools / function calling 参数不透传——ZCode 自主决定工具使用
- 图片等多模态消息只取文本部分
- 与桌面版共享登录凭据与会话库，两者可同时使用互不冲突
- 账号体系切换需在桌面版或面板重新登录（凭据按体系独立）

## 文档

- [使用说明.md](使用说明.md) —— 面向使用者的快速上手手册
