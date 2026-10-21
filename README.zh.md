# @oh-agent/dsh-mcp-manager

一个设置页，管理散落在本机各个 AI 开发工具里的 MCP 服务器 —— 每个配置文件一张卡片，显示它声明了什么；每个服务器一个开关，把它挂载进 DeepSeek Harness；再加一次真连探活，看它到底能不能起来。

入口：DeepSeek Harness → **设置 → MCP**（位于「技能管理」和「插件市场」之间）。

## 安装

**方式一：插件管理页**（推荐）

设置 → 插件管理 → 安装，搜索 `@oh-agent/dsh-mcp-manager`。

**方式二：让 agent 安装**

直接说「安装 @oh-agent/dsh-mcp-manager」，等价于：

```
plugin_manager  action: install_bundle  target: "@oh-agent/dsh-mcp-manager@0.1.0"
```

`target` 也可以填一个绝对目录 —— 本地源码目录，或者
[v0.1.0 release](https://github.com/wangbobo-coder/dsh-mcp-manager/releases) 里附的
`dsh-mcp-manager.tgz` 解出来的目录。

**不要**手动 `pnpm add` 进 profile，也不要手改 profile 的 `package.json` 或
`cordis.patch.yml`：装了包不等于选中了它的 bundle，手动装的后果是那一行存在但永远不会被挂载。

安装后增加一个设置页和一个 agent 工具（`mcp_manage`）。它没有任何运行时依赖，不需要构建，也没有 `allowBuilds` 授权步骤。要求 Node `^22.19.0 || >=24.0.0`（DeepSeek Harness 自带 Node 24，无需另装）。

页面会读取其他工具的配置文件，但**开关不需要对它们有写权限**。所有数据都不离开本机 —— 唯一的对外流量是你主动点的那次探活，且只发往你点的那一个服务器。

## 它解决什么问题

同一个 MCP 服务器，在每个工具里声明在不同的文件、不同的键、不同的方言下：

| 工具 | 文件（Windows） | 顶层键 |
| --- | --- | --- |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` | `mcpServers` |
| Claude Code | `~/.claude.json`、`<proj>/.mcp.json` | `mcpServers` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| VS Code | `<ws>/.vscode/mcp.json` | `servers` |
| Roo Code | `…\rooveterinaryinc.roo-cline\settings\cline_mcp_settings.json` | `mcpServers` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` |
| Qwen Code | `~/.qwen/settings.json` | `mcpServers` |
| Qoder IDE | `%APPDATA%\Qoder\SharedClientCache\mcp.json` | `mcpServers` |
| OpenCode | `~/.config/opencode/opencode.json` | `mcp` |
| Trae | `%APPDATA%\Trae\User\mcp.json` | `mcpServers` |
| Trae CN | `%APPDATA%\Trae CN\User\mcp.json` | `mcpServers` |
| Copilot CLI | `~/.copilot/mcp-config.json` | `mcpServers` |
| Kiro | `~/.kiro/settings/mcp.json` | `mcpServers` |
| Zed | `settings.json` | `context_servers` |
| Continue | `~/.continue/config.yaml` | `mcpServers`（YAML 数组） |
| CodeBuddy | `%APPDATA%\CodeBuddy\...` | `mcpServers` |
| **DeepSeek Harness** | profile 组合文件 | `@deepseek-ai/dsh-mcp-client` 行 |

这些差异不是美观问题，而是手改最容易翻车的地方：

- **远程传输的拼写不同。** Windsurf 只认 `serverUrl`，写成 `url` 会被静默忽略。Gemini 和 Qwen 区分 `url`（SSE）与 `httpUrl`（streamable HTTP），而 Roo 把 streamable HTTP 拼成 `streamable-http`。
- **超时单位不同。** Gemini / Qwen / DSH 是毫秒，Roo 是秒。
- **命令的形态不同。** OpenCode 的 `command` 是数组，`env` 叫 `environment`；其他工具是字符串 `command` 加独立的 `args`。
- **有些文件混着无关状态。** `~/.claude.json` 里还有历史记录和 OAuth token；`opencode.json` 里有 provider 和 plugin。整文件重写会把这些一起毁掉。

本插件把这一切读入同一个模型，写回时只改它想改的那一条。

### Windows 与 macOS

没有任何路径写死在单一平台上。每个适配器通过读取操作系统的解析器声明自己的文件：

| 根 | Windows | macOS |
| --- | --- | --- |
| `appData()` | `%APPDATA%` | `~/Library/Application Support` |
| `xdgConfig()` | `~/.config` | `~/.config` |
| `vscodeUserDir()` | `%APPDATA%\Code\User` | `~/Library/Application Support/Code/User` |
| `zedConfig()` | `%APPDATA%\Zed` | `~/.config/zed` |
| `HOME` 相对 | `~/.codex`、`~/.cursor` … | 相同 |

Zed 是值得点名的例外：macOS 上它读 `~/.config/zed`，**不是** Application Support，所以它有独立解析器。`APPDATA`、`XDG_CONFIG_HOME`、`COPILOT_HOME` 被设置时会生效。

项目级路径始终拼在工作区根目录上，天然可移植。`scripts/test-paths.mjs` 在模拟的 `win32`、`darwin`、`linux` 下加载真实的适配器源码，逐个客户端断言解析出的目录。

## 架构

```
client.js  (设置页)                 index.js  (宿主入口)
        │                                  │
        └──────── /api/dsh-mcp-manager ────┘
                    │         │
              scan.js     ops.js      probe.js
                 │          │            │
           adapters.js  store.js    surgical.js
                 │          │            │
           canonical.js  ledger+    保字节编辑
          (统一模型)      备份       JSON/TOML/YAML
                             │
                    dsh.js + dsh-patch.js + toggle.js
```

- **`canonical.js` —— 唯一的语义模型。** 每个客户端条目都解码为 `{name, transport, command, args, env, url, headers, timeoutMs, enabled, autoApprove, extra, secrets}`。能力**不**向最小公约数对齐：某个客户端表达不了的字段，写入时丢弃并作为 `droppedFields` 上报，绝不悄悄编造。
- **`adapters.js` —— 唯一懂格式的层。** 十八个客户端即数据：容器键、方言（哪个键表示 url、哪种 type 字符串映射到哪种传输、超时单位）、能力、文件位置。
- **`surgical.js` —— 保字节编辑器。** 携带偏移量的解析树 + 自底向上的编辑，替换一条不会重排整个文件。注释、尾逗号、CRLF、无关的键都活下来；解析不了就拒绝，而不是重写。
- **`store.js` —— 安全网。** 写入前字节备份、比较并交换的哈希校验、归属台账。
- **`probe.js` —— 它到底能不能用。** 手写的 JSON-RPC 客户端（不依赖 `@modelcontextprotocol/sdk`）：spawn stdio → `initialize` → `notifications/initialized` → `tools/list`；远程则 POST，带 `Accept: application/json, text/event-stream` 并跟随 SSE 响应。只读 —— 从不调用任何工具。
- **`dsh.js` / `dsh-patch.js` / `toggle.js` —— 把 Harness 自己也当成一等目标。** 已存在的行通过 `configEditor.edit()` 改写（校验 + 热重载）。全新的服务器没有行可寻址，于是写进组合文件的 `- insert:` 补丁层，Loader 会自己把它拾起来 —— 操作会等这一行出现并上报 `live: true`。

  如果预算内没等到，它上报 `activating: true`，**绝不**说「需要重启」：补丁行只会写在 Loader 看得见的地方，所以它迟早会生效。给一个正在生效中的服务器提示重启是实测出来的错误 —— 连续挂载多个服务器会把重排推过任何固定预算，随后它们全部以 live 出现。

  发现逻辑读的是 `entry.options.name`，不是 `entry.name`：运行中的 Loader 条目自身没有 `name` 属性（已在运行中的 Host 上验证过），读错字段会静默匹配到零行 —— 结果每个已挂载的服务器都看起来没生效，并索要一次根本不需要的重启。

## 安全模型

写入路径围绕一条规则构建：**只重写我们能证明是自己写的东西。**

1. **归属台账。** 每次写入记录 `{path, serverName, fingerprint}`。之后同名写入只有在磁盘上的定义仍与该指纹一致（用户没改过）时才生效。
2. **绝不覆盖别人的服务器。** 名字已被非我们写入的条目占用时，视为用户的：新来的服务器改用带后缀的名字。
3. **乐观并发。** 调用方传入它扫描到的哈希；文件变了就返回 `409` 和当前哈希，界面提示重新扫描。不存在静默的后写覆盖。
4. **每次修改前备份**，按 `backupsToKeep` 保留，可在页面还原。
5. **原子替换。** 写临时文件、`rename` 覆盖目标、再读回并重新解析，证明结果是合法的。
6. **凭据在离开宿主前就被掩码。** 掩码是按键驱动的，不是按值形状 —— 短 token（`TOKEN=abc`）照样掩码，而间接引用（`${FIGMA_API_KEY}`）原样显示，因为它指向密钥名而不是携带密钥。覆盖字面值所有可能藏身的地方：`env`、`headers`、未建模的 `extra`、原始条目副本，以及命令行参数（`--figma-api-key=figd_…`，这是好几个服务器的官方调用方式，根本不在 `env` 里）。`reveal` 是需要显式确认的动作。
7. **项目作用域拒绝字面凭据。** 往要进仓库的文件里写明文密钥会失败，并提示改用环境变量引用。
8. **被掩码的定义永远写不回去。** 浏览器手里只有脱敏副本，所以每次写入都从宿主侧的扫描结果解析定义；万一 `figd••••0000` 还是流到了写入路径，会以 `error.server.masked` 拒绝，而不是把真实凭据换成圆点。
9. **变更请求需要自定义头**（`x-dsh-mcp-manager: 1`），叠加在 JSON content-type 和 loopback 来源校验之上 —— 跨站表单设不了这个头。

## 开关只把服务器挂进 DeepSeek Harness，别的什么都不动

每行上的唯一控件是一个开关，含义只有一条：**这个服务器有没有挂进 DeepSeek Harness？**

打开就在 Harness 里挂载，关闭就卸载。定义来自哪个文件，开关**从不**以写入方式打开 —— 通过在本机对一次挂载/卸载循环前后哈希每个客户端配置来验证，全部未变。

这个限制不是洁癖，是格式逼出来的：大多数客户端根本没有 enable 字段。Qoder 和 Trae 的 `mcp.json` 里没有任何 enable 之类的键。写一个进去，就是一个会撒谎的开关。

按情形说明挂载怎么实现：

| 服务器是 | 开关做的事 | 生效时机 |
| --- | --- | --- |
| 我们自己写的 `- insert:` 项 | 关：删掉该项；开：重写它 | 重排后生效；文件回到精确的原始字节 |
| 已经是运行中的 `dsh-mcp-client` 行 | `pluginManager.setPluginEnabled(rowId, …)` | 立即 —— 行卸载，其工具从工具列表消失 |
| 用户自己写的 `- insert:` 项 | 追加/移除插件管理器自己也会写的那种 `- id: …` / `disabled: true` 覆盖项 | 重排后生效 |
| 只声明在别的工具里，且被打开 | 写一条新的 `- insert:` 行 | Loader 重排后即生效（通常 1–4 秒）；操作最多等 8 秒并上报 `live: true`，否则 `activating: true` |
| 哪里都没挂载，且被关闭 | 什么都不做 —— 本就是事实，不留悬空覆盖项 | — |

我们自己写的行会在尝试 Loader 路径之前被移除：插件管理器确实能热卸载一行，但它的做法是在定义旁边追加一条 `disabled: true` 覆盖项，那会让我们的行和这条覆盖项一起永久留在用户的组合文件里。删除 insert 项既是卸载也是清理。

因为覆盖项是独立的一项而不是重写，且我们自己写的行是删除而不是禁用，一次完整的挂载 → 卸载循环会把 `cordis.patch.yml` 还原到精确的原始字节。

### 挂载名不总是显示名

`@deepseek-ai/dsh-mcp-client` 要求 `serverName` 匹配 `/^[A-Za-z0-9_-]{1,32}$/`。现实中很多服务器不满足 —— 这台机器上有十几个叫 `表单管理系统 - API 文档` 之类，`Figma AI Bridge` 带空格。只用 `sanitizeName` 压一遍，所有中文名都会变成 `API`，第二个挂载就会和第一个撞名，开关就会翻错服务器。

因此 `canonical.js` 导出 `dshMountName(name)`：先 sanitize，如果结果丢了信息（中日韩字符、空格、超长），就追加原名的短哈希 —— `表单管理系统 - API 文档` → `API-c2f500c4`，`Figma AI Bridge` → `Figma-AI-Bridge`。它是纯函数且全域的，所以写入路径、扫描、开关、移除都从同一输入算出同一字符串，不需要在任何地方存映射表。

扫描和页面处理的后果：

- 节点保留显示名；`mountedAs` 携带行名，`entryId` 携带 Loader id，开关按映射后的名字找到自己的行；
- 服务器出现在 DSH 那张文件卡片里时用显示名，其他工具的卡片不变；
- 两个 sanitize 后同名基的服务器仍得到不同的行名（哈希不同），不会有服务器悄悄替换另一个。

`scripts/test-mount-name.mjs` 钉住了这个映射，包括撞名情形和经由 scan 的往返。

## 怎么用

页面布局和它旁边的技能页一致：标题行加操作按钮，四格汇总条（服务器 · 文件 · 已挂载进 DSH · 字面凭据），筛选行，然后每个配置文件一张带边框的卡片。

每张卡片列出该文件声明的服务器 —— 头部是工具名、服务器数量和路径（缩短成 `%APPDATA%\…` 风格，完整路径在 tooltip 里）。卡片可折叠；筛选生效时所有卡片都会展开，因为藏在折叠卡片里的命中会被读成「没有结果」。每行显示传输方式、命令或 URL、有多少工具共用这份定义、探活结果，以及挂载开关。

筛选是一个自由文本搜索（名字、命令、路径）加两个下拉：按工具、按挂载状态（已挂载 / 未挂载）。

点击一行打开对话框，而不是在原地展开 —— 原地展开会把它下面每一行都重排，让一张卡片看起来像两张叠在一起。对话框列出声明该服务器的每个文件、统一后的定义、一条可直接粘贴进 cordis 组合的 YAML 行，以及「复制到…」用于把定义推到别的工具。

同一批操作也以 `mcp_manage` 工具暴露给 agent，所以页面和 agent 共用一份实现，不可能走岔：

```
action: scan | probe | toggle | apply | remove | sync | snippet | reveal | history
```

## 配置

`cordis.patch.yml` 行配置：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `includeProjectScope` | `true` | 同时扫描工作区级文件 |
| `probeTimeoutMs` | `20000` | 单个服务器探活预算 |
| `probeConcurrency` | `4` | 并行探活数 |
| `backupsToKeep` | `20` | 每个文件保留的备份数 |

状态（台账 + 备份）位于 `<DSH_HOME>/mcp-manager/`。

## 在本机验证过

十八个客户端中装好了八个，跨 Qoder IDE、OpenCode、Trae、Trae CN 和 DSH 发现 27 个服务器。Context7 探活成功带 2 个工具，`playwright_mcp` 带 25 个。经页面挂载再卸载一个 DSH 服务器后，`cordis.patch.yml` 与写入前哈希**逐字节相同**，用户自己的 provider、permission、agency 条目原封不动 —— 同一循环中其他每个客户端配置文件也都保持哈希不变。

磁盘上发现 21 处明文凭据 —— 多数在 `env` 映射里，一处在命令行参数里（Qoder `mcp.json` 的 `--figma-api-key`）。它们的字面值没有出现在 state 载荷的任何位置；页面只显示键名，写入路径拒绝被掩码的值。

`scripts/` 下十二个测试套件覆盖编辑器、路径层、写入路径、DSH 适配器、补丁层、挂载开关、非 ASCII 服务器名的挂载名映射、脱敏与掩码写入防护，外加一次端到端断言：没有任何凭据字面值进入客户端载荷。

```
node scripts/test-surgical.mjs      17 passing
node scripts/test-write.mjs         12 passing
node scripts/test-dsh.mjs           16 passing
node scripts/test-dsh-patch.mjs     15 passing
node scripts/test-dsh-e2e.mjs        8 passing
node scripts/test-toggle.mjs        16 passing
node scripts/test-redact.mjs        14 passing
node scripts/test-masked-write.mjs   5 passing
node scripts/test-client-load.mjs   28 passing
node scripts/test-paths.mjs         16 passing
node scripts/test-mount-name.mjs    12 passing
node scripts/test-locale.mjs         en/zh key parity
```

## 已知限制

- **安装检测靠文件存在性。** 装了但还没有 MCP 配置的工具，在目录出现之前与「没装」无法区分。
- **新挂载的 DSH 服务器依赖 Loader 重排。** 操作最多等 8 秒并上报 `live: true`；窗口过期则上报 `activating: true`，页面稍后重新读取状态。对 Loader 看得见的行，永不索要重启。
- **不是我们写的行只被关闭，不会被删除。** 删掉用户粘进去的定义等于毁掉他的工作，所以这样的行会得到与插件管理器相同的那种 `disabled: true` 覆盖项，并留在文件里。
- **只有 DSH 可切换。** 其他工具的文件只被显式读写，从不切换 —— 见上文。
- **Continue 只读**（YAML 数组形态）；编辑在计划中。
- **凭据不会被迁移进保险库。** 插件只做掩码和告警；把凭据换成 `${env:...}` 引用仍是用户自己的决定。
- **不查询 MCP 注册表。** `registry.modelcontextprotocol.io` 明确是预览态且不面向宿主直接消费，所以服务器发现只靠扫描本地文件。

## 许可证

MIT
