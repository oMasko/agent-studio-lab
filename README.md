# Agent Studio

这是一个主要在自己电脑上运行的 Agent 学习项目，使用 **React、Next.js 和 OpenAI Agents SDK for TypeScript** 构建。

它不只是一个聊天页面。Agent 可以读取文件、执行工具、把任务交给专家，并在敏感操作前停下来等待确认。

项目没有绑定某个具体业务。模型、系统提示词、Tools、Skills、MCP 和专家角色都可以在界面中配置。整套应用使用 JavaScript / TypeScript，运行时不需要 Python。

> 目前更适合学习、个人使用和原型验证。项目还没有生产系统常见的多用户登录和强沙箱隔离。文件修改、命令执行和 MCP 调用都可能真的改变本机或外部服务，使用前请先看[安全边界](#安全边界)。

快速导航：[快速开始](#快速开始) · [界面入口](#界面入口) · [任务流程](#一次任务是怎样执行的) · [模型配置](#模型与运行时配置) · [安全边界](#安全边界) · [代码入口](#代码阅读入口) · [验证与排查](#验证与排查)

## 现在能做什么

| 模块 | 说明 |
| --- | --- |
| 对话 | 多轮聊天、多会话切换、流式回复和 Markdown 展示；工具调用和 Agent 交接过程也会显示在聊天中 |
| 模型 | 可接 OpenAI、DeepSeek、GLM，以及其他兼容 OpenAI 接口的服务 |
| 专家 Agent | 可以配置多个专家，让主 Agent 把子任务交给专家，或者直接把后续对话交给专家处理 |
| 工具 | 包含时间、计算、网页读取、联网搜索、工作区文件操作和本地命令；是否可用由配置与权限决定 |
| Skills 与 MCP | 可以管理完整 Skill 工程，也可以连接外部 MCP 服务并选择具体工具 |
| 安全与审批 | 可以按工具来源和能力设置允许、审批或拒绝，也支持输入、输出和工具参数检查 |
| 任务管理 | 保存每次 Run 的状态与结果，支持取消、重试，以及恢复等待审批的任务 |
| 上下文 | 显示上下文窗口用量，接近上限时可自动压缩旧历史；另外支持全局和会话记忆 |
| 运行记录 | Trace 页面会记录模型、工具、专家、审批和错误事件，并统计 Token 与响应速度 |
| 实验功能 | Agent 讨论室仍可试用并保留历史，但暂时不继续扩展 |

## 快速开始

### 准备环境

请使用 **Node.js 22.15 或更高版本**。项目用到了 `node:sqlite`，测试脚本还会用到 `node:module.registerHooks`，所以不能只按 Next.js 的最低版本准备 Node。

还需要一个可用的模型服务 API Key。如果想让 Agent 调用工具，所选模型和接口需要支持 Function Calling。

第一次运行时，在项目根目录复制环境变量示例。下面的命令不会覆盖已有的 `.env`：

```bash
cd openai_agents_demo
test -f .env || cp .env.example .env
```

编辑 `.env`，填写实际可用的模型和 Key，例如：

```dotenv
MODEL_PROVIDER=openai
OPENAI_API_KEY=你的_API_Key
OPENAI_MODEL=你的模型名称
```

不要提交 `.env` 或把 Key 写进前端源码。

### 安装与运行

```bash
cd web
npm install
npm run dev
```

打开终端里显示的 Local 地址，通常是 <http://localhost:3000>。如果 3000 端口已被占用，Next.js 会换用其他端口。

安装、构建和启动命令都应在 `web/` 目录执行。项目也会据此找到根目录下的配置、数据和工作区。

`npm run dev` 启动前会检查本项目是否已有 Next.js 开发服务。如果旧进程还占着开发锁，脚本会先尝试停止它；其他项目或只是碰巧占用同一端口的程序不会被处理。

这个检查目前依赖 macOS 的 `/usr/sbin/lsof`。在其他系统上，可能需要手动停止旧服务。可以先运行 `npm run dev:check`，看看脚本会命中哪个进程。

停止服务请用 **Ctrl+C**；Ctrl+Z 是挂起，不是退出，端口和锁可能仍被占用。

生产构建与启动：

```bash
npm run typecheck
npm run build
npm start
```

### 建议先这样试

1. 先发一条普通消息，确认模型可以正常回复。
2. 到「Agent 设置 → 模型与运行时」选择主模型、专家模型，并决定是否开启联网。
3. 打开「安全与审批」，确认工作区权限，再尝试读取文件、修改测试文件或执行一条简单命令。
4. 到「Agent 编排」创建一个职责明确的专家，并只给它完成任务所需的工具。
5. 最后去「运行中心」和「Trace」看看一次任务是怎样执行的。

## 界面入口

| 入口 | 路径 / 位置 | 用途 |
| --- | --- | --- |
| 模型与运行时 | 聊天页设置弹窗 | 模型服务商、模型、API、联网和循环限制 |
| 运行中心 | `/runs` | 查看 Run、取消、重试和返回相关会话 |
| 上下文与记忆 | `/memory` | 压缩设置、人工补充上下文和长期记忆 |
| Agent 编排 | `/agents` | 专家职责、指令、协作方式和权限 |
| 系统提示词 | `/prompts` | 管理并启用 Main / Subagent 提示词方案 |
| MCP | `/mcp` | 配置连接、测试和发现工具 |
| Skills | `/skills` | 安装、扫描、启停、备份和删除技能包 |
| 安全与审批 | `/safety` | 工作区开关、工具策略和围栏 |
| Trace | `/traces` | 执行链路与生命周期日志 |
| 实验功能 | `/experiments` | 独立实验入口，目前包含 Agent 讨论室 |

Agent 讨论室不再直接列在设置主列表中。入口为 **Agent 设置底部 → 实验功能 → Agent 讨论室**，原 `/discussions` 地址仍可访问。

## 一次任务是怎样执行的

浏览器只负责界面和交互。真正的模型调用、工具执行、审批和数据保存都发生在 Next.js 服务端，API Key 不会直接交给浏览器里的模型 SDK。

1. 前端把消息发到 `/api/chat/stream`。服务端为这次任务创建一条 Run 记录，并关联当前会话。
2. `createRuntime()` 读取当前模型、提示词、专家、Skills、MCP 和安全配置，组装本次运行真正可用的 Agent 和工具。
3. SDK Runner 开始模型与工具之间的循环。历史记录来自 SQLite；每次请求模型前，系统还会检查上下文是否需要压缩。
4. 主 Agent 可以直接回答，也可以调用工具、把子任务交给专家，或者把后续处理权交给专家。
5. 如果某个工具需要批准，任务会停在这里并保存状态。用户批准或拒绝后，再从同一个状态继续。
6. 回复文字和执行动态通过 SSE 持续传给页面。任务状态、最终结果和 Trace 会保存在服务端，页面断线后仍可查询。

### 主 Agent 怎么选择专家

主 Agent 会拿到一份已启用专家的清单，其中包含名称、职责和协作方式。模型根据当前任务判断是否需要专家，以及该找谁。

这里没有写死“出现某个关键词就调用某个专家”。配置了多个专家，也不代表每次都要全部调用。

| 配置 | 用途 |
| --- | --- |
| 职责描述 | 写给主 Agent 看，帮助它判断什么时候该调用这个专家。最好说明适合做什么、不适合做什么、应返回什么 |
| 专家系统提示词 | 写给专家本人看，说明接到任务后怎样工作。它会接在通用 Subagent 指令后面 |
| Tool 委派 | 专家作为一个工具完成子任务，结果交回主 Agent，由主 Agent 整理最终回复 |
| Native Handoff | 当前对话直接交给专家继续处理，主 Agent 不再负责这一段的最终回复 |
| 权限清单 | 决定专家能看到哪些 Tools、Skills 和 MCP Tools。被列入清单的工具仍可能需要审批 |

目前，专家只能在同一个模型服务商、Base URL 和凭据下覆盖模型名称，还不能为每个专家单独选择服务商。

专家也没有天然独立的长期记忆。Tool 委派和 Handoff 都属于当前会话的执行过程，启用的全局或会话记忆仍可能提供给相关 Agent。换句话说，这里的专家用于任务分工，并不是彼此完全隔离的独立账号。

## 模型与运行时配置

服务端读取根目录 `.env`；`web/.env.local` 可覆盖同名环境变量。界面保存的配置从后续请求生效，不必重启；修改环境文件后建议重启。浏览器中已保存的设置可能覆盖新默认值，可在设置面板重置。

| 模型服务商 | Key 环境变量 | 模型环境变量 | 地址环境变量 |
| --- | --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | `OPENAI_MODEL` | `OPENAI_BASE_URL` |
| `deepseek` | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL` | `DEEPSEEK_BASE_URL` |
| `glm` | `ZAI_API_KEY` | `GLM_MODEL` | `GLM_BASE_URL` |
| `custom` | `MODEL_API_KEY` | `MODEL_NAME` | `MODEL_BASE_URL`（必填） |

自定义兼容服务示例：

```dotenv
MODEL_PROVIDER=custom
MODEL_API_KEY=你的服务商_Key
MODEL_NAME=your-model-id
MODEL_BASE_URL=https://your-provider.example/v1
MODEL_API_MODE=chat_completions
SUBAGENT_MODEL=your-worker-model
```

API 模式可以选 `responses` 或 `chat_completions`。默认情况下，OpenAI 和 DeepSeek 使用 Responses，GLM 和 custom 使用 Chat Completions，也可以在界面中修改。最终能否正常工作仍取决于具体服务端和模型，这些默认值只是一套起始配置。

- `SUBAGENT_MODEL` 留空时继承主模型，专家自身的模型覆盖优先于通用 Subagent 模型。
- 主 Agent 与 Subagent 的循环上限可以设为 1–500，也可以不设上限。它控制的是一次任务内部最多跑多少步，不限制整段聊天能聊多少轮。即使不设上限，模型的上下文长度和调用费用仍然存在。
- 界面中的 API Key 留空时，后端会读取 `.env` 里的 Key。临时填写的 Key 只保存在当前页面内存中，会随请求发到本项目后端；刷新页面后就会清除，也不会写入 Run 记录。
- 审批状态需要在服务重启后恢复，或者从运行中心重试任务时，系统只能使用服务端配置的 Key。

## 工具、Skills 与 MCP

### 内置工具

| 工具 | 能力 |
| --- | --- |
| `get_current_time` | 获取当前时间 |
| `calculate` | 受限数学表达式计算，不执行任意代码 |
| `web_fetch` | 读取公开网页内容，但不能像浏览器一样点击、登录或运行页面脚本 |
| `web_search` | 搜索公开信息和来源。是否可用取决于联网开关、模型模式和搜索凭据 |
| `workspace_list_files` / `workspace_read_file` / `workspace_search` | 受限工作区文件访问 |
| `workspace_apply_patch` | 创建、替换、追加或可恢复删除文本文件 |
| `workspace_run_command` | 真实执行非交互本地命令 |
| `load_skill` / `read_skill_file` | 按需读取技能说明和配套文本资源 |

`WEB_SEARCH_ENABLED` 决定联网搜索是否默认开启。OpenAI Responses 可以直接使用托管搜索；其他模式会通过 OpenAI 做一次搜索桥接。

主模型使用 OpenAI 时，搜索沿用当前 Key。主模型使用 DeepSeek、GLM 等服务时，还要另外配置服务端 `OPENAI_API_KEY`。可以用 `WEB_SEARCH_MODEL` 指定搜索模型，这部分调用会产生 OpenAI 费用。`web_fetch` 只读取已知网页，不需要这份搜索 Key。

搜索接口超时和某个网页打不开是两件事，排查时要分开看。为了避免访问内部网络，`web_fetch` 不允许读取本机或内网地址；本地服务可以通过明确配置的 MCP 接入。

### 完整 Skill 项目

支持 ZIP 安装、浏览器目录导入和项目目录扫描，保留 `SKILL.md`、`scripts/`、`references/`、`assets/` 等文件。安装到 `.agents/skills/<skill-name>/`，新导入 Skill 默认禁用，审查后再启用。

运行开始时，模型只会看到已启用 Skill 的名称和简介。判断某个 Skill 与任务有关后，才用 `load_skill` 读取完整说明，再按需要打开 references、文本资源或脚本源码。这样可以避免每次请求都带上所有 Skill 文件。

**读取 Skill 说明不会自动执行脚本，也不会增加权限。** Skill 在 `requires` 中声明能力，只是在说明它需要什么。真正运行脚本仍要调用命令工具，并经过权限和审批检查。

专家想使用某个 Skill，还需要在专家配置中选中它。该 Skill 本身也要处于启用状态，并允许 Subagent 使用。

### MCP 服务

MCP 支持 Streamable HTTP、SSE 和 stdio。可以用预设快速填写，也可以直接编辑完整 JSON；保存前可以测试连接和读取工具列表，还能决定该服务供主 Agent、专家或两者使用。

专家需要从已经发现的 MCP 工具中逐项选择。“选择当前全部”只会保存此刻的工具名单；服务以后新增的工具不会自动授权。

stdio 类型会在本机启动进程。使用前需要在界面中把配置标记为可信，并在服务端设置 `ALLOW_STDIO_MCP=true` 后重启。HTTP 类 MCP 要填写真正的协议地址，不要误填服务自带的配置网页。连接由 Next.js 服务端发起，因此 `127.0.0.1` 指的是运行 Next.js 的那台机器。

## 安全边界

项目用三层机制控制风险：

1. **能力授权**决定 Agent 到底能看到哪些工具、Skills 和 MCP 能力。
2. **工具策略与人工审批**决定一次具体调用是直接允许、等待确认，还是拒绝。没有匹配到规则的工具默认需要审批，明确拒绝的规则不能被会话授权绕过。
3. **Guardrails（安全围栏）**检查用户输入、模型输出和工具参数。默认实现主要做字符串匹配，无法识别所有危险意图。

普通函数工具、Skill 读取工具和 MCP 工具会走统一的策略检查。OpenAI SDK 托管的搜索工具走的是另一条执行路径，不能照搬本地函数工具的规则来理解。

输出围栏只能拦住最终回复，无法撤销工具已经产生的副作用。流式文字也可能在最终输出检查之前出现在页面上。

### 审批与会话授权

- 审批时可以只批准这一次，也可以按卡片上显示的范围授权当前会话。
- 修改文件时，授权范围包含路径和操作类型；执行命令时会匹配 command、args 和 cwd；其他工具通常要求参数完全一致。
- MCP 的会话授权按整个服务生效，范围比单个工具更大，确认前应先检查服务来源。已有的拒绝规则和工具权限仍然有效。
- 会话授权只保存在当前服务进程的内存中，不会带到其他会话，重启服务后也会清除。
- 待审批任务没有固定的 15 分钟过期时间。主聊天会保存待审批的 RunState，服务重启后可以尝试恢复。如果工具配置已经改变，或者服务端缺少凭据，恢复仍可能失败。
- 内存中最多只保留有限数量的待审批运行时，不适合拿来长期托管无人处理的任务。

`simulate_sensitive_action` 和 `simulate_undeclared_sensitive_action` 是专门用来测试审批流程的模拟工具，默认关闭，也不会修改外部系统。Workspace Tools 和 MCP 工具则可能真的执行操作。

### 工作区不是操作系统沙箱

文件工具把 `openai_agents_demo/` 作为工作区根目录，并限制路径穿越、符号链接、凭据文件和内部状态目录。删除文本文件时，文件会先移到 `.agent-studio/trash/`，方便恢复。

命令工具接收明确的 command 和 args，默认不会自动套一层 Shell。它还会限制工作目录、运行时间和输出大小，并清理环境变量。

不过，命令最终仍运行在你的电脑上。只要允许 `bash` 或其他通用执行程序，它就可能访问工作区外的文件或网络。生产环境应把这类执行放进容器或其他隔离环境。

主应用的大部分管理和聊天接口还没有完整的用户登录保护，不要直接暴露到公网。提示词里写着“不要执行危险操作”，也不能替代真正的权限控制。

## 会话、Run 与恢复

| 对象 / 操作 | 当前行为与边界 |
| --- | --- |
| Session | SQLite 按会话保存 SDK 历史，包括工具调用；浏览器另外保存页面上看到的消息和会话列表 |
| Run | 保存一次任务的请求、状态、结果、Trace 关联，以及特定阶段的 RunState；临时 Key 不会写入 |
| 流式断线 | 只要服务进程还在，页面断线不会自动取消任务。前端可以查询最终状态和结果，但不能重放所有 SSE 增量 |
| 取消 | 停止当前任务并显示“任务已取消”；已经执行的外部操作不会自动回滚 |
| 重试 | 用原输入新建一次 Run，从头再执行。重试前应先确认上一次是否已经产生副作用 |
| 服务重启 | 历史、结果和审批检查点会保留，正在普通运行中的任务不会自动接着跑 |

当前实现适合在本机持续运行 Node 服务。它还不是带持久化队列和自动接管能力的后台任务系统。

## 上下文、压缩与长期记忆

### 上下文用量圆环

输入框旁边的圆环显示最近一次模型请求用了多少上下文。点击圆环可以看详细数据、切换要查看的专家，也可以手动设置模型的窗口上限。

- 圆环显示的是一次请求占用了多少窗口，不是整段会话累计花了多少 Token。缓存命中也不会让上下文变短。
- 发送前先在本地估算，模型返回 usage 后再校准。拿不到 usage 时，界面会标明“估算”或“未知”。
- 主 Agent 和各专家分开统计。窗口上限来自项目内置资料或手动设置，很多服务商并没有统一接口可供自动查询。
- 未发送的草稿和接下来的工具结果都会影响下一次请求，因此圆环不能精确预测下一次用量。

### 滚动语义压缩

每次请求模型前，系统都会估算即将发送的内容。普通聊天、工具循环和审批恢复都会经过这一步。默认在接近窗口的 75% 时触发压缩，希望压回到 50% 左右；实际判断还会考虑给输出预留的空间、安全余量和服务商返回的 usage，所以触发点不一定刚好落在 75%。

压缩时，当前 Agent 使用自己的模型，把较早的历史和上一次摘要合并成新摘要。系统指令、用户当前要求，以及最近的完整工具调用和结果会尽量原样保留。SQLite 中的原始历史和 RunState 不会被摘要覆盖。

摘要检查点会按会话、Agent、Provider、模型、Base URL 和 API 模式分别保存。复用前还会核对历史前缀，避免把别的任务或旧版本历史的摘要拿过来。

如果不知道模型的真实窗口大小，系统暂时按 32,000 Token 计算压缩预算。这个数只是兜底值，不代表模型真的支持 32,000 Token，最好在详情里填写准确上限。

生成摘要本身也会消耗 Token，相关用量会单独显示在上下文详情和 Trace 中。只有摘要成功生成并且确实把内容缩小到目标范围，新的检查点才会保存。失败时继续保留旧上下文；如果最新用户输入本身就太大，系统会直接报错，而不是偷偷截断内容。

目前使用的是项目自己实现的语义摘要，没有调用 OpenAI 原生的 `/responses/compact`。如果请求依赖本地看不到的服务端历史或 Prompt 模板，项目暂时不会尝试压缩，以免错误判断上下文。

这些选项在「上下文与记忆」页面中配置，包括开关、触发比例、希望保留的最近记录数量、摘要长度和未知窗口时的预算。旧版本中的摘要字段现在作为人工补充上下文使用。

手动测试可在独立会话将窗口设为 16,000、输出预留 2,000，累积若干中等文本后观察压缩次数与摘要，再提问早先约束。不要用单条超过窗口的最新输入测试；完成后恢复真实窗口设置。

### 长期记忆

可以保存全局记忆，也可以只保存给当前会话。启用的记忆会在后续请求中提供给 Agent。长期记忆用于保留明确的信息，历史摘要主要用于节省上下文，两者用途不同。

## Trace 与运行指标

运行时 Hook 会记录 Agent、模型、工具、委派、Handoff、审批、错误和压缩事件。任务卡住或结果异常时，可以在 Trace 页面确认停在哪一步、哪个专家调用过什么工具。

聊天状态栏会显示模型轮次、执行步骤、累计 Token、平均输出速度和缓存命中率。这些数据依赖服务商返回的 usage。平均速度只是本次运行的统计值，不等于模型底层的固定解码速度。简单来说：圆环看上下文还剩多少，状态栏看这次任务用了多少。

## 实验功能：Agent 讨论室

入口在 **Agent 设置底部 → 实验功能 → Agent 讨论室**。这个功能目前只保留试用和历史查看，暂时不继续扩展，也不会影响正常聊天和专家编排。

讨论室本身不启动 Codex，也不读取 Codex 的登录信息或替参与者调用模型。参加会议的 Agent 通过 HTTP 主动连接，继续使用自己的模型、上下文和额度；房间里只能看到它主动提交的公开发言。

### 当前参会流程

1. 在 `.env` 中设置 `DISCUSSION_ADMIN_TOKEN`，重启服务后用它进入讨论室管理页。可以运行 `openssl rand -hex 32` 生成口令，不要把它发给参与者。
2. 填写议题和规则，创建 2–6 个席位，再选择由谁做最后总结，以及进行几轮交叉讨论。
3. 分别为每个席位生成邀请。填写参与者能够访问的服务地址，把参会说明和该席位的令牌私下发给对应 Agent。
4. 参与者先完整阅读接入 Skill，再通过 `DISCUSSION_TOKEN` 环境变量使用令牌加入。重连时要继续使用原来的客户端身份。
5. 所有人就位后，由房主开始讨论。流程依次是独立初评、交叉讨论和主持总结；中途可以暂停、恢复、补充约束、重新邀请、撤销席位或结束会议。

独立初评期间，每个参与者都看不到其他人的初评。邀请令牌在数据库中只保存哈希，并且只对应一个房间和席位。服务端还会检查当前轮次、任务归属、租约和重复提交。

一次长轮询最多等待 20 秒，发言任务默认保留 10 分钟，可以通过心跳续期。参与者离线或租约失效不会让整场会议自动结束。Skill 哈希只用来确认双方使用同一版接入规则，无法证明模型真的理解了规则。

每次公开发言最多 16,000 个字符；房主最多补充 30 条说明，每条不超过 2,000 个字符。房间会使用现有的输入、输出关键词围栏检查公开文本，但无法管理远程 Agent 自己电脑上的工具权限。

参与者客户端需要保持运行，下载 Skill 本身不会启动后台服务。旧版讨论记录仍可查看，但不能继续运行。

**会议号自动入会、免手动传令牌和新的会议流程图还没有实现，相关开发暂时搁置。** 目前只能填写一个参与者可访问的地址来生成邀请；系统不会自动开通公网访问，也不会替你配置端口转发、DNS 或防火墙。

参与者与服务在同一台电脑上时可以用 localhost；跨电脑时必须填写对方真正能访问的地址。远程连接默认要求 HTTPS。如果只在可信局域网内测试 HTTP，需要显式设置 `DISCUSSION_ALLOW_HTTP=1`。

如果要把参会接口开放出去，建议只代理 `/api/discussion-connect` 及其 Skill 路径，配置限流，并确保访问日志不会记录 Authorization。不要直接把整个应用暴露到公网。

协议和客户端详情见 [参会 Skill](web/resources/discussion-room-participant/SKILL.md)：

- 房主管理：`GET/POST /api/discussions`、`GET/PATCH /api/discussions/:id`，需要管理口令。
- 外部参与：`POST /api/discussion-connect`，需要席位令牌，支持 join / poll / heartbeat / submit / leave。
- 公共 Skill：`GET /api/discussion-connect/skill`；`?format=json` 获取正文和哈希，`?format=zip` 下载完整包。
- 客户端状态默认 `.discussion-client.json`，保存稳定身份、任务和幂等 ID，不含令牌，每个参与者使用独立状态文件。

## 数据存储与备份

| 位置 | 内容 |
| --- | --- |
| `.env` / `web/.env.local` | 服务端凭据和环境配置 |
| `.agent-studio/agent-studio.sqlite` | Session、Runs、专家、记忆、上下文检查点、讨论室等 |
| `.agent-studio/prompts.json` | 提示词方案 |
| `.agent-studio/mcp-servers.json` | MCP 配置，可能含敏感参数 |
| `.agent-studio/safety.json` | 安全策略与工作区开关 |
| `.agent-studio/skills-state.json` | Skill 启停和作用范围 |
| `.agent-studio/traces/` | 本地 Trace |
| `.agent-studio/trash/` | 文件工具可恢复删除的文本文件 |
| `.agents/skills/` | 安装的 Skill 工程目录 |
| 浏览器 localStorage | 可见聊天、会话列表、不含临时 Key 的运行时设置 |

备份前最好先停止服务，然后整体复制 `.agent-studio/` 和 `.agents/skills/`。SQLite 开启了 WAL，服务运行时只复制主数据库文件可能拿不到完整数据。浏览器里的会话列表等状态不在服务端备份中。

配置文件、聊天内容、工具参数和 Trace 都可能包含隐私或凭据，不要提交到公共仓库。

## 代码阅读入口

| 文件 | 关注点 |
| --- | --- |
| [web/app/page.tsx](web/app/page.tsx) | 聊天、流式展示、会话和审批交互 |
| [web/app/api/chat/stream/route.ts](web/app/api/chat/stream/route.ts) | 主聊天 SSE、SDK Run 与持久化 |
| [web/lib/agent.ts](web/lib/agent.ts) | Provider、运行时、专家目录、工具包装、Handoff |
| [web/lib/agent-definition-store.ts](web/lib/agent-definition-store.ts) | 专家定义与模板 |
| [web/lib/agent-permissions.ts](web/lib/agent-permissions.ts) | 能力清单与筛选 |
| [web/lib/core-capabilities.ts](web/lib/core-capabilities.ts) | 时间、计算、网页读取 |
| [web/lib/workspace-tools.ts](web/lib/workspace-tools.ts) | 文件访问与命令执行 |
| [web/lib/skills.ts](web/lib/skills.ts) / [web/lib/mcp-store.ts](web/lib/mcp-store.ts) | 技能包、MCP 配置 |
| [web/lib/safety-store.ts](web/lib/safety-store.ts) | 围栏与工具策略 |
| [web/lib/pending-approvals.ts](web/lib/pending-approvals.ts) / [web/lib/session-approvals.ts](web/lib/session-approvals.ts) | 待审批生命周期、会话授权 |
| [web/lib/restore-pending-run.ts](web/lib/restore-pending-run.ts) | RunState 反序列化和审批恢复 |
| [web/lib/persistent-session.ts](web/lib/persistent-session.ts) / [web/lib/run-store.ts](web/lib/run-store.ts) | 历史和 Run 存储 |
| [web/lib/context-model.ts](web/lib/context-model.ts) / [web/lib/context-compaction.ts](web/lib/context-compaction.ts) | 用量观测与滚动压缩 |
| [web/lib/monitoring-hooks.ts](web/lib/monitoring-hooks.ts) / [web/lib/trace-store.ts](web/lib/trace-store.ts) | 生命周期监控与 Trace |
| [web/lib/discussion-hub.ts](web/lib/discussion-hub.ts) | 实验讨论室事务、轮次和租约 |

如果想顺着一次任务读代码，可以按这个顺序：聊天流式 API → 运行时组装 → 工具和审批 → Session 与 Run → 上下文和 Trace。很多能力由宿主代码强制实现，并不只是写在系统提示词里。

## 验证与排查

在 `web/` 下执行：

```bash
npm run typecheck
npm run test:permissions
npm run test:context
npm run test:compaction
npm run test:discussions
npm run build
```

这些回归脚本使用临时目录、假模型或本地测试 MCP，不会调用付费模型，也不会修改现有会话。它们主要检查服务端逻辑，不能替代真实模型兼容性测试和浏览器端到端测试。

常见排查：

- **模型请求失败**：确认 Provider、模型名称、API 模式、Base URL 和服务端 Key。示例中的模型名称不代表你的账号一定可用。
- **没有调用专家**：检查专家是否启用、职责是否写清楚、协作方式是否合适。专家委派由模型判断，并非每次任务必经的步骤。
- **工具不可用**：依次检查全局开关、专家权限、MCP 连接和工具发现，以及 Safety 规则。只改提示词不会增加真实权限。
- **网页访问失败**：先判断是搜索接口有问题，还是目标网页打不开。需要登录、点击或运行脚本的网页超出了 `web_fetch` 的能力。
- **审批恢复失败**：检查任务是否已取消或被新任务替换，再确认服务端凭据和工具配置是否仍然有效。当前并没有默认的 15 分钟过期规则。
- **任务已经完成，界面却没更新**：先到运行中心查看 Run，再结合 Trace 判断是任务执行失败，还是前端没有恢复显示。
- **端口或开发锁被占用**：先用 Ctrl+C 停止原服务，再运行 `npm run dev:check` 查看残留进程。
