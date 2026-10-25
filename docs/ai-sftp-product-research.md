# XSH：AI 助手与 SFTP 交互的有界产品调研

调研及访问日期：**2026-10-22（Asia/Shanghai）**。仓库：`C:\Users\Soren\codes\xsh`；本地检查基线：`346bc62` 加当前工作区。下列实现仍为未提交的工作区改动；XSH 已完成本机 Windows 构建、覆盖安装与原生链路验收，详情见 [本地验收记录](local-build-validation-2026-10-22.md)。竞品部分仍仅为官方资料和源码核查。

## 结论与边界

XSH 已补齐 **AI 命令与实际结果的对应，以及传输目标、失败恢复和双向冲突决策**，并继续接通上下文来源清单、逐步审阅的诊断和目录工作区。P0 的批次／方向筛选及远端定位也已补齐。P2 任务摘要与显式持久记忆仍待实现。

本次只研究 Termius、Warp、Wave Terminal（`wavetermdev/waveterm`）、electerm 四项；不扩展 SecureCRT、MobaXterm 或 MobaAI，不研究传输速率、限速、吞吐优化或模型排行榜。按 research skill 的证据要求，只采信官网文档、官方仓库源码和第一方发布记录；未安装产品做实机验收，也未验证各收费套餐的授权范围。

- **证实的产品功能**：官方资料明确说明，或已发布版本源码中能定位到实际交互及调用。官网宣传与源码不一致时，明确保留差异。
- **基于证据的设计建议**：针对 XSH 提出的改动；即使借鉴竞品，也不表示竞品已经具备建议中的完整流程。
- **未证实**：本次检查的官方材料不足，不等于产品绝对没有该功能。历史发布说明、预览功能、Coming Soon 和第三方 CLI 的能力均单独标注。
- 商业产品采用访问日的现行文档。开源产品以访问日 GitHub `releases/latest` 返回的稳定版为依据：electerm **v5.6.10**（官方发布时间 `2026-10-15T09:51:13Z`）、Wave **v0.14.5**（`2026-04-16T16:01:54Z`）；下方源码链接固定在这两个 tag，避免把主分支开发内容当作发布功能。[^E0][^V0]

## 本轮已落实的改进

2026-10-22 后续补充：新增终端提示符附近的命令建议浮层，支持当前会话的本机历史补全、保留当前前缀的 AI 续写，以及中文目标生成单行命令。采纳仅补入后缀，不带回车；Tab 保留给远端。模型请求由用户明确触发，终端输出默认不附加，附加时使用可预览的脱敏快照。建议绑定连接、提示符和输入版本，输入改变、重连或切换标签后失效。

可编辑位置通过 OSC 133 的提示符结束标记和实际回显共同核实；本次 Shell 集成进一步补充 C/D 执行边界及退出码，保留 Bash/Zsh 现有提示符与钩子，不修改启动文件。基础集成可在空提示符升级。未集成时可生成和复制，不能猜测输入位置。实现说明见 `apps/desktop/README.md`，核心边界见 `terminal-completion.ts`、`terminal-execution.ts` 和 `TerminalCommandSuggestions.tsx`。

2026-10-22 的本地实现优先改善现有流程：

- AI 回复采用 Markdown 展示，命令、日志、配置分开呈现；每个完整的 Shell 代码块可单独复制、放入可编辑草稿。正在生成、已停止或缺少结束围栏的代码不能放入执行草稿。
- 命令草稿由用户选择，不自动替用户选中第一段命令。确认发送后可附加实际终端输出继续诊断；取消确认保留草稿，不产生“已发送”状态。草稿仍绑定原终端连接。
- 对话记录和提问区分别滚动，提问入口保持可见；上下文通过选区、最近输出或手动粘贴附加，保留发送前检查。
- 诊断指令要求区分事实和推测，优先提供少量只读检查、预期结果与判断分支，结合后续输出推进分析。
- 远程文件面板补齐文字上传／下载入口、路径导航、文件搜索、名称／时间／大小排序和隐藏项开关；范围选择遵循筛选后的列表顺序。
- 传输卡片统一展示方向、来源、目标、进度与错误；当前连接和全局管理器均可按状态筛选，后者还支持文件／主机搜索。下载完成后可打开保存目录，清理失败会保留可见错误。

2026-10-22 续作对照后补齐：

- **②命令反馈：** 终端与 AI 面板共用执行记录。记录单行命令、目标连接、时间、输出和可取得的真实退出码；选定某次结果继续诊断或生成下一步命令，使用冻结的脱敏快照。发送失败、中断、未知边界均独立标明。记录限当前窗口内存、每标签 40 条和 256 KiB 输出。
- **⑤传输目标：** 文件选择、拖入、批量下载接入统一确认单，展示来源、主机、目标及策略；批次固定连接和路径。提交前刷新来源信息，检查冲突期间可取消；未确认完整批次前不启动文件传输。
- **⑦失败恢复：** 全局单项／勾选重试，沿用后端保存的原连接、路径与覆盖决定，保留旧错误和新任务的重试来源。关闭原 SFTP 面板后，失败／取消任务在既有保留上限内继续保留连接；过期自动回收。连接失效不会借用当前主机。补充按真实批次、方向和主机筛选；重试继承原批次，远端目录定位核对原会话及地址。
- **⑧双向冲突：** 共用两端路径、类型、大小、时间对照，支持覆盖普通文件、跳过、重命名和保留两份；名称碰撞阻止提交。新建／重命名使用禁止覆盖写入。目录下载合并目录，文件与目录冲突单独决策，取消后丢弃整个未提交批次。

2026-10-22 本轮继续补齐：

- **①来源清单：** 选区、最近输出、执行结果和手动文件片段分别保留，可单独取消附加／移除，显示来源主机、已报告目录、采集时间、字节数、脱敏和截短状态。重连前的条目明确标旧，取消附加或移除前不能发送。每项最多 8 KiB、最多 6 项，请求共用 16 KiB 上限；预览标明截短／省略。
- **③分步诊断：** 完整且通过结构校验的 `xsh-plan` 提案可进入审阅，每步包含目标、假设、可编辑命令和预期观察，支持跳过和暂停。执行仍逐次确认原连接，通过唯一执行 ID 回填实际结果；附加结果后由用户决定是否继续请求模型。无效结构保留普通文字回复。
- **⑥目录工作区：** 按主机、端口和用户保存目录书签、最近访问和本地保存目录；可展开本地／远端双栏，浅层读取本地文件并将所选普通文件送入原传输确认流程。Shell 集成增加 OSC 7 目录报告，“跟随终端”只使用该报告；在当前终端切换目录仍须确认。

验证：前端构建、127 项前端测试、179 项 Rust 测试、Rust 格式及 Clippy 检查通过；本轮 90 项 React/xterm 浏览器检查涵盖补全、执行结果、上下文清单、诊断步骤、目录工作区和队列筛选。Windows NSIS/MSI 已本地生成，NSIS 覆盖安装至原目录，安装版额外通过 33 项原生链路检查：真实 SSH/SFTP、Bash 输出／退出码、文件字节一致、冲突、空目录、批次定位及重连隔离。模型使用本地确定性 SSE 测试服务，没有评估线上模型回答质量。测试连接已清理，原数据库记录、AI 配置及 vault key 均校验保持一致。尚未在原生 macOS/Zsh 环境验收。

执行输出依靠 Shell 标记和 xterm 缓冲区，PTY 后台消息可能混入其中；无可靠边界、多行输入、缓冲区丢失或全屏程序不会被猜测为准确结果。文件片段目前手动粘贴，尚无 SFTP 一键读取片段入口；诊断初版编辑命令，调整假设／预期可重新生成计划。任务摘要与可选记忆仍为后续工作。

## 紧凑比较

以下单元格描述的是**证实的产品功能或明确的证据缺口**；其中的建议尚未写入产品能力。

| 比较维度 | Termius | Warp | Wave Terminal v0.14.5 | electerm v5.6.10 |
| --- | --- | --- | --- | --- |
| 会话上下文、选中输出、诊断 | Shell integration 能识别目录、历史、提示符及命令状态；当前 FAQ 证实 AI widget 入口。桌面选区诊断未证实。[^T1][^T2] | 命令 Block 或选中文本可作为 AI 上下文；附件仅用于当前对话。[^W1] | Widget Context 开关控制上下文；可按行读取终端回滚输出。远程文件读取仍列为 Coming Soon。[^V1] | 有终端文本解释入口；Agent 有读取终端输出的工具。[^E1][^E2] |
| 多步任务、执行前审阅 | 2023 年官方发布过 AI 命令生成；不能据此认定当前桌面已有多步 Agent 或逐条审批。[^T3] | 多步 Agent；计划可编辑、批准后进入实现；命令权限可设 Always Ask，并提供批准、拒绝、编辑后执行。[^W2][^W3] | 文件读写需批准，写入可预览 diff；**终端命令执行仍列为 Coming Soon**。[^V1] | Agent 有工具循环；状态卡展示参数和结果。已检查调用链未证实逐命令强制审阅，不能将状态卡称为审批卡。[^E1] |
| 命令执行反馈 | Shell integration 的命令状态识别已证实；AI 自动消费执行结果未证实。[^T1] | Block 绑定命令与输出，并显示非零退出状态；Agent 使用终端输出继续任务。[^W4][^W5] | 能读取输出；不能据此认定 AI 已执行命令并自动验证结果。[^V1] | 工具结果回填 Agent；普通发送命令工具等待终端静默后返回输出，静默不等于拿到退出码。[^E1] |
| 多轮与长期记忆 | Session Logs 保存终端记录；不能等同于 AI 多轮或语义记忆，后者未证实。[^T4] | 可恢复对话、自动压缩历史；Rules 是持久规则。另有 Agent Memory，但官方标为 research preview。[^W5][^W6][^W7] | 有当前聊天及清空/新建入口；跨重启恢复、长期记忆未在本次材料中证实。[^V1] | 可加载历史对话；支持压缩、自动压缩及上下文用量估算；对话历史写入本地数据库。[^E2][^E3] |
| 文件浏览、上传下载入口、目标目录 | 桌面 SFTP 双栏、跨栏拖拽、从系统拖入目标栏及终端/SFTP 切换；FAQ 明确客户端尚不直接支持默认 SFTP 路径。[^T5][^T6] | Warpify SSH 提供远程 File Tree 等扩展；这不足以证明完整 SFTP 上传下载管理器。平台限制见后文。[^W8] | `wsh view .` 打开目录；目录组件之间可跨连接拖拽，目标是接收组件的目录。此处证实的是 Wave 文件复制界面。[^V2][^V3] | 本地/远端双栏，各有路径和历史；Agent 上传下载工具也显式接收本地、远端路径。[^E1][^E4] |
| 传输队列、失败重试 | 官方 Transfers 进度、取消、错误说明属于 **iOS/Android** 分栏；本次未证实桌面队列及一键失败重试。[^T5] | 专用 SFTP 队列、失败重试未证实。[^W8] | 复制失败会显示错误；源码中的再次尝试限于覆盖/合并冲突，不能算通用失败重试或传输队列。[^V3] | 可按标签筛选任务、暂停/恢复、全部取消、拖动排序和置顶；检查的队列与历史界面未证实失败任务一键重试。[^E5] |
| 覆盖、冲突处理 | 本次桌面官方材料未证实具体决策界面。[^T5] | 本次 SSH 官方材料未证实具体传输冲突界面。[^W8] | 冲突出现 “Delete Then Copy” / “Sync”；后者设置 `merge=true`，不能称为双向同步。[^V3] | 同屏展示两端路径、大小、修改时间；提供覆盖/合并、跳过、重命名及本批次全部处理。[^E6] |

### 会影响产品判断的证据边界

**Termius：补全、日志、AI Agent 是三件事。** 现行文档把目录与历史识别描述为 Shell integration，不应直接写成“AI 自动理解整个 SSH 会话”。2023 年 AI 命令生成的发布说明曾提及操作系统、发行版、工作目录和 Shell；这是历史已证实的设计，当前 AI widget FAQ 只能进一步证明入口仍存在，不能证明当前每次请求仍发送同样字段。远程 Shell integration 文档还限定为 OpenSSH 7.2+、bash，不能泛化到所有设备。[^T1][^T2][^T3]

**Warp：已经不宜用“只有本地终端”概括，但要看平台。** 现行 Warpify SSH 文档明确列出远程 File Tree、编辑等扩展，并在平台矩阵中将 File Tree 标注为 Windows 不支持。其 Agent Memory 页面则明确写着 research preview；不能把它当作所有桌面 SSH 会话默认具备的稳定记忆。[^W7][^W8]

**Wave：终端/文件组件的能力不能自动归给 AI。** 发布版 AI 文档仍将远程文件读取和命令执行列为 Coming Soon，但文件浏览组件已经支持跨连接复制。二者并不矛盾。“Sync” 按钮也仅证实触发合并选项，本次没有证据支持双向同步、失败队列或自动恢复的额外推论。[^V1][^V2][^V3]

**electerm：宣传中的 approval gates 尚不能作为逐条审阅的实施证据。** 官网 Agent Mode 文章使用了该说法；但固定发布版的 `runAgentLoop → executeToolCall → mcpSendTerminalCommand` 路径及工具卡中，检查到的是直接调用和运行状态展示，未证实对应的逐条批准界面。因此本报告采信“多步工具调用、结果回传”，对“逐命令强制审阅”保留未证实结论。普通命令工具读取静默后的缓冲区，也不能与独立执行接口所能提供的退出码混为一谈。[^E1][^E7]

## XSH 当前基础与具体缺口

以下是本地工作区的只读检查结果，访问日期同为 2026-10-22。

| 已有基础 | 仍值得改善的实际位置 |
| --- | --- |
| 解释选区、分析报错、生成可编辑草稿；来源清单分别保留选区、输出、结果和文件片段；按标签隔离对话 | 文件片段目前手动粘贴，可进一步补充 SFTP 内的显式片段选择入口。[^X1] |
| 最近最多 6 轮完整问答、32 KiB 请求历史；不完整回复不进入历史；会话仅在内存保留 | 现有“多轮”不等于跨任务记忆。应先改善可核对的任务摘要，再考虑可选持久化。[^X1] |
| 草稿执行前确认主机与原连接；可审阅诊断步骤、编辑命令、跳过／暂停，并关联唯一执行结果 | 假设／预期目前通过重新生成方案修改；未知边界和后台消息限制需保留。[^X2] |
| 远端单栏及可展开双栏；目录书签、最近访问、本地保存目录与 Shell 目录报告联动 | 上传仍支持普通文件；本地浅层列表上限 5000 项；跨平台交互还需 macOS 实机验收。[^X3] |
| 全局按主机／方向／真实批次／状态筛选、原目标重试、远端定位与双向冲突决策 | 旧任务缺少原会话标识时需手动定位；任务仅在应用运行及保留期内存在。[^X3][^X4][^X5] |

## 八项具体产品改进

八项的类型均为 **“基于证据的设计建议”**；每项另外列出 **“证实的产品功能”** 作为依据，避免把 XSH 的目标方案写成竞品现状。P0 表示建议先做，P1 表示下一轮，P2 表示在前述体验稳定后再做。

### 1. 带来源的上下文清单，而不只是一块文本框

**类型：基于证据的设计建议；优先级：P1。**

**实施状态：来源清单核心流程已落实；文件片段采用显式手动粘贴，SFTP 内选取片段入口待补。**

- **证实的产品功能：** Warp 可添加完整 Block 或选中文本；Wave 有 Widget Context 开关和按行读取终端输出；electerm 显示上下文用量。[^W1][^V1][^E2]
- **XSH 改动：** 在现有预览上增加可移除条目：“终端选区”“最近输出”“本次执行结果”“手动添加的文件片段”。各条目显示主机、目录（已知时）、采集时间、字节数和是否截短。SSH 用户、主机、Shell、系统信息仅在可核实且用户勾选后附加；未知项明确显示未知。保留现有脱敏与大小限制。[^X1]
- **验收场景：** 用户从两个输出片段发起报错分析时，能在发送前删去无关片段；连接重建后，旧条目显示“来自上次连接”。SFTP 文件选中的“作为分析材料”入口只能添加经过预览的片段，不能把整个远端目录自动发给模型。

### 2. 命令执行记录与“用这次结果继续分析”

**类型：基于证据的设计建议；优先级：P0。**

**实施状态：核心流程已落实，限可核实的单行命令和 Shell 边界；未知范围明确标注。**

- **证实的产品功能：** Warp Block 关联命令、输出和非零退出状态；electerm Agent 将工具结果带回下一次模型请求。[^W4][^E1]
- **XSH 改动：** 将已有 `lastExecution` 及继续诊断入口扩展为按命令保存的执行记录，展示实际发送的命令、目标会话、开始时间和状态。继续分析时优先附加对应命令的输出，而非统一读取最近若干行。有可靠命令边界时关联这次输出；支持取得真实退出码时再显示成功/失败。尚无可靠边界时标为“已发送，结束状态未知”，允许用户选择输出范围；不要用终端静默或输出 ACK 当作执行成功。[^X2]
- **验收场景：** 连续运行两条检查命令后，用户能分别展开其输出，并针对第一条继续诊断；不会把第二条或其他后台输出误配给第一条。长时间无输出的任务不会被误报完成；收起 AI 面板再打开时仍能看到本次运行内的执行记录。

### 3. 可审阅的分步诊断，逐步获取证据

**类型：基于证据的设计建议；优先级：P1，依赖第 2 项。**

**实施状态：已落实结构校验、命令编辑、逐步确认、跳过／暂停及唯一执行结果关联；当前不自动连续运行步骤。**

- **证实的产品功能：** Warp 计划可编辑、批准后进入实现，命令也可设为逐次询问，并允许编辑后运行。[^W2][^W3]
- **XSH 改动：** 将一次“分析报错”组织为三至五步可修改计划：每步包含要验证的假设、目标主机/目录、命令草稿及预期观察。每次只执行已审阅的一步，附加结果后再决定下一步；允许跳过、停止或改写计划。先做这种有限的诊断流程，再评估是否需要更多自动执行。
- **验收场景：** 排查 “nginx 启动失败” 时，先查看状态与相关日志；证据尚不足时继续检查。重启服务应作为独立、可编辑且须审阅的步骤出现；每步均能追溯到支持它的输出。

### 4. 可核对的任务摘要与可选会话记忆

**类型：基于证据的设计建议；优先级：P2。**

**实施状态：待实现；当前标签内的对话与诊断计划不等于持久记忆。**

- **证实的产品功能：** Warp 能恢复对话并压缩长历史，Rules 提供持久规则；electerm 支持历史对话、压缩及本地保存。Warp 的独立 Agent Memory 仍是 research preview，不能作为成熟度等价依据。[^W5][^W6][^W7][^E2][^E3]
- **XSH 改动：** 在现有历史上增加一份可编辑摘要：“目标”“已验证事实及来源”“已执行操作”“尚未解决的问题”。先在当前任务内使用；另提供显式保存到特定主机/项目的选项，并允许查看、修改、删除和本次不附加。保存摘要与保留整段终端历史分开处理。[^X1]
- **验收场景：** 超出当前 6 轮请求历史后，用户仍能核对“8080 已确认被某进程占用”的来源；重连后该事实带有旧连接时间提示。切换另一台主机不会自动携带上一台的运行状态。

### 5. 上传、下载共用明确的来源 → 目标传输单

**类型：基于证据的设计建议；优先级：P0。**

**实施状态：已落实统一确认、批次目标固定和提交前检查。**

- **证实的产品功能：** Termius 以目标窗格承接拖拽；Wave 跨组件复制使用接收目录；electerm 明确维护本地/远端路径。[^T5][^V2][^V3][^E4]
- **XSH 改动：** 在已有上传/下载文字按钮和拖拽目标提示上，进一步让文件选择、拖入、批量下载共用轻量传输单，直接展示 `本地目录 → user@host:远端目录` 或反向路径、项目数和冲突策略，允许修改目标。选定本次目标后将其固定到批次，后续浏览其他目录不改变待提交任务；传输记录也始终可查看完整两端路径。[^X3][^X4]
- **验收场景：** 用户在 `/etc/nginx` 选择上传文件后切去 `/var/log`，传输单仍清楚指向 `/etc/nginx`；多项下载不需要靠记忆判断刚才选了哪个本地目录。系统文件选择器和拖拽进入同一套目标展示。

### 6. 保留侧栏，补目录导航和可选双栏工作区

**类型：基于证据的设计建议；优先级：P1。**

**实施状态：书签、最近目录、本地保存目录、可展开双栏及已报告目录联动已落实；目录终端入口在当前连接发送经确认的 Bash/Zsh `cd` 命令。**

- **证实的产品功能：** Termius、electerm 有双栏浏览；electerm 维护路径历史；Wave 能从目录组件打开该目录的终端。Termius 默认 SFTP 路径 FAQ 明确说客户端尚不直接支持，这一点不作为正面功能借鉴。[^T5][^T6][^E4][^V2]
- **XSH 改动：** 在现有 `initialDirectory` 基础上，增加按主机和用户区分的最近目录、目录书签及明确的本地下载目录。窄侧栏保留远端单栏，展开文件工作区后可选本地/远端双栏；提供“在此目录打开终端”和“定位到终端目录”。后者仅在能可靠获知当前目录时启用，不能从任意输出猜测路径。[^X3]
- **验收场景：** 第二次连接同一主机能一键回到常用部署目录；用户能看见并更改本地下载位置；在目录中打开终端后，界面明确显示目标主机和目录。

### 7. 全局队列成为失败恢复入口

**类型：基于证据的设计建议；优先级：P0。**

**实施状态：单项／勾选重试、原主机约束、记录保留、批次／方向／主机筛选及远端定位已落实。**

- **证实的产品功能：** electerm 队列支持按标签筛选、批量暂停/恢复/取消及排序。这里没有借它证明“一键重试失败项”；失败恢复方案是结合 XSH 已有单连接重试提出的。[^E5][^X3]
- **XSH 改动：** 全局管理器按主机、批次、方向、状态筛选；增加“仅看失败”“重试此项”“重试所选失败项”，保留错误原因、原始两端路径和重试记录。关联连接失效时显示“需要重新连接原主机”，不能借当前活动标签把文件发到别的主机。完成项提供“打开本地目录”或“定位远端目录”。[^X4]
- **验收场景：** 用户关闭原 SFTP 面板后，仍能从全局队列找到并重试失败任务；十个任务中三个失败时只重试这三个。暂停显示为可恢复状态，取消显示为已取消，两者不混用。

### 8. 上传、下载一致的冲突决策面板

**类型：基于证据的设计建议；优先级：P0。**

**实施状态：已落实双向元数据对照、批次策略、保留两份及防碰撞重命名。**

- **证实的产品功能：** electerm 冲突弹窗对照两端路径、大小、修改时间，并提供单项/本批次策略；Wave 区分覆盖删除后复制与目录合并。[^E6][^V3]
- **XSH 改动：** 在现有上传冲突选项上补齐来源和目标的完整路径、类型、大小、修改时间；下载批次接入同一套决策。保留覆盖、跳过、重命名，并用“保留两份”生成尚未占用的名称；“应用到其余冲突”明确限定为当前批次。文件与目录类型冲突单独说明；目录合并与目录替换不能共用含混标签。当前“重命名后仍同名即覆盖”的警告路径应改为重新选择有效名称或明确转入覆盖决策。[^X3][^X5]
- **验收场景：** 批量下载碰到本地同名文件时可以先比较再决策；重命名不会意外覆盖另一个同名文件；关闭一个批次后，其“全部覆盖”选择不延续到下一批。修改时间和大小仅作为比较线索，不直接宣称内容相同。

## 建议实施次序与评估

以下为**基于证据的设计建议**，不是竞品路线图，也不包含传输速率指标。

| 次序 | 建议组合 | 可核验的结果 |
| --- | --- | --- |
| 第一轮 P0（已落实） | **②执行反馈、⑤传输目标、⑦失败恢复、⑧冲突决策** | 命令结果续诊、传输确认、全局重试、双向冲突以及真实批次筛选／远端定位已接通。 |
| 第二轮 P1（核心流程已落实） | **①上下文清单、③分步诊断、⑥目录工作区** | 来源可核对，诊断命令可编辑、可停，常用目录、本地保存目录和可展开双栏可用；SFTP 片段选取及更完整的计划编辑仍可继续。 |
| 第三轮 P2 | **④摘要与可选记忆** | 在已有可靠执行记录后沉淀任务知识，避免把未经验证的模型推测保存成服务器事实。 |

评估先采用四个固定场景：端口占用诊断后继续追问；拖入文件后切换目录；关闭 SFTP 面板后重试部分失败项；批量上传与下载遇到同名文件。观察完成所需操作、是否误用目标目录、能否从原始错误恢复、能否区分“已发送”与“成功完成”。本报告不虚构节省时间或成功率数字。

## 官方证据与本地定位

各关键事实已在正文逐项关联到下列来源。所有来源的访问日期均为 **2026-10-22**；历史发布日期及预览状态不因访问日期而改变。源码行号用于定位，标签用于固定版本。

[^T1]: Termius，Autocomplete & Shell integration，尤其 Shell integration、Known limitations & system requirements。精确 URL：https://docs.termius.com/terminal/autocomplete-and-shell-integration 。访问：2026-10-22。

[^T2]: Termius，How can I hide the AI widget?（证明当前文档中的 AI widget 入口，不证明完整 Agent 能力）。精确 URL：https://docs.termius.com/help-center/faq/how-can-i-hide-the-ai-widget 。访问：2026-10-22。

[^T3]: Termius，Boost Your Terminal Experience with AI，发布于 2023-06-26（历史 AI 命令生成及环境上下文说明）。精确 URL：https://termius.com/blog/boost-your-terminal-experience-with-ai 。访问：2026-10-22。

[^T4]: Termius，Session logs（终端记录、保留与书签）。精确 URL：https://docs.termius.com/organize-and-connect-to-hosts/session-logs 。访问：2026-10-22。

[^T5]: Termius，Managing files with SFTP，尤其 Overview、Transfer files 的 Desktop/iOS/Android 分栏。精确 URL：https://docs.termius.com/organize-and-connect-to-hosts/managing-files-with-sftp 。访问：2026-10-22。

[^T6]: Termius，How to set a default SFTP path?（明确写客户端尚不直接支持，所列办法为服务器端配置）。精确 URL：https://docs.termius.com/help-center/faq/how-to-set-a-default-sftp-path 。访问：2026-10-22。

[^W1]: Warp，Blocks as Context，尤其 Attaching a Block to an AI query、Block Attachment Persistence。精确 URL：https://docs.warp.dev/agents/local-agents/agent-context/blocks-as-context/ 。访问：2026-10-22。

[^W2]: Warp，Agent Profiles & Permissions，尤其 Run commands、Command allowlist、Command denylist；文档给出 Approve、Reject、Edit。精确 URL：https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/ 。访问：2026-10-22。

[^W3]: Warp，Planning，尤其 Editing a plan、Approving a plan and starting implementation。精确 URL：https://docs.warp.dev/agents/capabilities/planning/ 。访问：2026-10-22。

[^W4]: Warp，Block Basics，尤其 What is a block?、Block contents、Errors（非零退出状态）。精确 URL：https://docs.warp.dev/terminal/blocks/block-basics/ 。访问：2026-10-22。

[^W5]: Warp，Interacting with Agents，尤其 Conversations、Resuming a conversation、Context window management。精确 URL：https://docs.warp.dev/agents/local-agents/interacting-with-agents/ 。访问：2026-10-22。

[^W6]: Warp，Rules（持久的个人及项目规则，区别于对话记录）。精确 URL：https://docs.warp.dev/agents/capabilities/rules/ 。访问：2026-10-22。

[^W7]: Warp，Agent Memory（页面明确为 research preview；说明 memory stores、对话后生成记忆与检索）。精确 URL：https://docs.warp.dev/agents/agent-memory/ 。访问：2026-10-22。

[^W8]: Warp，Warpify SSH，尤其 Available Extensions 和平台支持表。精确 URL：https://docs.warp.dev/terminal/warpify/ssh/ 。访问：2026-10-22。

[^V0]: Wave 官方 v0.14.5 发布记录：https://github.com/wavetermdev/waveterm/releases/tag/v0.14.5 ；稳定版核对接口：https://api.github.com/repos/wavetermdev/waveterm/releases/latest 。访问：2026-10-22。

[^V1]: Wave v0.14.5 官方 AI 文档，含 Widget Context Toggle、AI Tools、Coming Soon。固定版本：https://github.com/wavetermdev/waveterm/blob/v0.14.5/docs/docs/waveai.mdx#L29 ；对应在线文档：https://docs.waveterm.dev/waveai 。访问：2026-10-22。

[^V2]: Wave v0.14.5 官方 Widgets 文档，Preview → Directory、Copy a File、Open a New Terminal。固定版本：https://github.com/wavetermdev/waveterm/blob/v0.14.5/docs/docs/widgets.mdx 。访问：2026-10-22。

[^V3]: Wave v0.14.5 目录组件源码，`handleDropCopy` 与 `useDrop`，包含覆盖/合并冲突、错误呈现和目标目录 URI。精确 URL：https://github.com/wavetermdev/waveterm/blob/v0.14.5/frontend/app/view/preview/preview-directory.tsx#L714 。访问：2026-10-22。

[^E0]: electerm 官方 v5.6.10 发布记录：https://github.com/electerm/electerm/releases/tag/v5.6.10 ；稳定版核对接口：https://api.github.com/repos/electerm/electerm/releases/latest 。访问：2026-10-22。

[^E1]: electerm v5.6.10 Agent 工具及循环：工具定义/调度 https://github.com/electerm/electerm/blob/v5.6.10/src/client/components/ai/agent-tools.js#L469 ；结果以 `role: tool` 回填 https://github.com/electerm/electerm/blob/v5.6.10/src/client/components/ai/agent.js#L234 ；工具状态卡 https://github.com/electerm/electerm/blob/v5.6.10/src/client/components/ai/agent-tool-call-card.jsx#L41 ；命令发送、输出读取及静默判定 https://github.com/electerm/electerm/blob/v5.6.10/src/client/store/mcp-handler.js#L660 。访问：2026-10-22。

[^E2]: electerm v5.6.10 文本解释及历史对话操作 https://github.com/electerm/electerm/blob/v5.6.10/src/client/store/common.js#L432 ；AI 面板的 Ask/Agent、历史、压缩和用量提示 https://github.com/electerm/electerm/blob/v5.6.10/src/client/components/ai/ai-chat.jsx#L237 ；实际请求历史构造与估算 https://github.com/electerm/electerm/blob/v5.6.10/src/client/components/ai/ai-context.js#L153 。访问：2026-10-22。

[^E3]: electerm v5.6.10 对话历史持久化：`aiChatHistory` 数据集合及监听列表 https://github.com/electerm/electerm/blob/v5.6.10/src/client/common/db.js#L26 ；数据库增删改写入 https://github.com/electerm/electerm/blob/v5.6.10/src/client/store/watch.js#L23 。访问：2026-10-22。

[^E4]: electerm v5.6.10 SFTP 双栏、各自地址及路径历史，`renderSection` / `renderSections`。精确 URL：https://github.com/electerm/electerm/blob/v5.6.10/src/client/components/sftp/sftp-entry.jsx#L1241 。访问：2026-10-22。

[^E5]: electerm v5.6.10 队列筛选及批量控制 https://github.com/electerm/electerm/blob/v5.6.10/src/client/components/sidebar/transfer-list-control.jsx#L16 ；单项控制、置顶与拖动排序 https://github.com/electerm/electerm/blob/v5.6.10/src/client/components/sidebar/transport-ui.jsx#L21 ；核查的历史面板 https://github.com/electerm/electerm/blob/v5.6.10/src/client/components/sidebar/transfer-history-modal.jsx 。这些来源不作为失败一键重试的证明。访问：2026-10-22。

[^E6]: electerm v5.6.10 冲突队列与批次策略 https://github.com/electerm/electerm/blob/v5.6.10/src/client/components/file-transfer/conflict-resolve.jsx#L76 ；两端元数据与动作按钮从同文件第 120 行开始：https://github.com/electerm/electerm/blob/v5.6.10/src/client/components/file-transfer/conflict-resolve.jsx#L120 。访问：2026-10-22。

[^E7]: electerm 官网，Build and Run with AI: Agent Mode in electerm，含 approval gates 的宣传描述。精确 URL：https://electerm.org/blogs/ai-electerm-org/ 。访问：2026-10-22。逐命令强制审阅是否落实，以正文所列发布版调用链核查结果为限。

[^X1]: 本地源码，访问：2026-10-22：[AI 任务与入口](C:/Users/Soren/codes/xsh/apps/desktop/src/ai-ui.ts)、[上下文编辑器](C:/Users/Soren/codes/xsh/apps/desktop/src/components/AiTaskComposer.tsx:22)、[AI 面板与预览](C:/Users/Soren/codes/xsh/apps/desktop/src/components/AiAssistantPanel.tsx:150)、[历史构造及限制](C:/Users/Soren/codes/xsh/apps/desktop/src/ai-conversation.ts:3)、[按标签保留在 React 内存状态](C:/Users/Soren/codes/xsh/apps/desktop/src/components/useAiConversation.ts:68)。

[^X2]: 本地源码，访问：2026-10-22：[发送前确认与原连接约束](C:/Users/Soren/codes/xsh/apps/desktop/src/App.tsx)、[命令记录与边界](C:/Users/Soren/codes/xsh/apps/desktop/src/terminal-execution.ts)、[终端发送与解析](C:/Users/Soren/codes/xsh/apps/desktop/src/components/TerminalPane.tsx)、[可展开的执行结果及续诊入口](C:/Users/Soren/codes/xsh/apps/desktop/src/components/TerminalExecutionList.tsx)。

[^X3]: 本地源码，访问：2026-10-22：[目录浏览、目标冻结、预检与传输提交](C:/Users/Soren/codes/xsh/apps/desktop/src/components/SftpPanel.tsx)、[统一批次规划](C:/Users/Soren/codes/xsh/apps/desktop/src/transfer-plan.ts)、[传输确认单](C:/Users/Soren/codes/xsh/apps/desktop/src/components/TransferPlanModal.tsx)。

[^X4]: 本地源码，访问：2026-10-22：[全局重试与批量结果](C:/Users/Soren/codes/xsh/apps/desktop/src/components/TransferManagerModal.tsx)、[队列状态展示](C:/Users/Soren/codes/xsh/apps/desktop/src/transfer-queue.ts)、[后端重试、原参数与连接保留](C:/Users/Soren/codes/xsh/crates/xsh-sftp/src/lib.rs)。

[^X5]: 本地源码，访问：2026-10-22：[双向冲突元数据与策略](C:/Users/Soren/codes/xsh/apps/desktop/src/components/TransferConflictModal.tsx)、[名称校验、保留两份及禁止覆盖](C:/Users/Soren/codes/xsh/apps/desktop/src/transfer-plan.ts)。Zsh 钩子状态核对：[官方 callhookfunc](https://github.com/zsh-users/zsh/blob/master/Src/utils.c)、[官方 doshfunc 的 noreturnval 保存与恢复](https://github.com/zsh-users/zsh/blob/master/Src/exec.c)；此源码核对不等于 macOS/Zsh 实机验收。
