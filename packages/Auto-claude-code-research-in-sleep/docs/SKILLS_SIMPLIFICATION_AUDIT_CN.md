# Skills 精简审查清单

审查日期：2026-10-06。范围是本仓库两处 skill 树：`packages/Auto-claude-code-research-in-sleep/skills/` 和根级 `skills/`，含嵌套分析技能。扫描全部正文、流程标题、代码块和跨文件重复段落，并逐项审阅用途与流程描述；大型技能针对候选教程段落与协议边界做定向核对。

本清单是维护审查记录，不被任何 skill 默认加载。它区分本轮已删减内容和后续候选，不能把候选项当成已经完成的重构。

## 判断标准

只写模型无法从任务和普通专业知识恢复的信息：本项目输入输出、字段/路径、状态转换、角色权限、证据要求、失败处理和必要例外。通用操作留给模型选择做法。

| 内容 | 处理 |
| --- | --- |
| 解析请求、读文件、建目录、复制/备份、SSH/Git、普通编译/绘图 | 删操作教程；保留确有要求的目标位置、不可变性或权限 |
| 一般科研、写作、数学、布局方法 | 写目标与验收标准；不写默认逐动作教程 |
| 稳定且机械的目录扫描、字段校验、状态写入、模板生成 | 放进 helper/模板；skill 调用权威实现 |
| 派发、watchdog、reviewer、manifest 等共用协议 | 单一权威定义，调用方引用；不复制步骤 |
| 本仓库特有 schema、服务 API、阶段交付、tester evidence | 保留；模型无法靠常识猜对 |
| 多 backend/jurisdiction/style 的差异 | 只在对应条件成立时读取特定参考 |

不能仅把通用教程搬到 references，再要求每次整篇阅读。行数不是唯一指标；长句和大 JSON 也会占上下文，本清单同时统计字符数。

## 本轮已落实

- 删除 `research-setup`、`tester-setup` 两个入口文件及目录清单/图示/调用说明；唯一 setup skill 为 `/aris-setup`。全局安装脚本改装新入口，并清理本 checkout 拥有的旧 symlink，保留用户目录。
- 28 处长 watchdog 重述缩为共享协议引用，13 处重复派发规则移除，8 处 manifest 读取样板缩为输入/路径绑定合同，10 处输出协议重复说明改为引用。保留 idea-discovery 的 `SUB_ARGS` 过滤规则；它是防止子技能错绑 manifest 的项目约束。
- `/aris-setup` 去掉 helper 路径查找和每步 shell 示例；保留配置总览、批量编辑、整份刷新、当前 digest 确认、设施执行和 root 协议。删除统一配置参考中与 review helper 重复的字段推荐表。
- `/paper-compile` 删除依赖安装、ls/grep/pdf 工具教程、固定 venue/year 页数表和长报告样板；保留单次编译/失败停止/源文件不改/实际投稿规则。
- `/system-profile` 删除常用工具和性能概念目录；保留实际测量证据、可逆插桩、产物位置和改动清单。

| 指标 | 修改前 | 当前 |
| --- | ---: | ---: |
| skill 数 | 96（ARIS 90 + Paseo 6） | 94（ARIS 88 + Paseo 6） |
| SKILL.md 总行数 | 33,335 | 32,570 |
| SKILL.md 总字符数 | 1,606,010 | 1,573,963 |
| 超过 500 行的 skill | 26 | 25 |

本轮改动 39 个现存 SKILL.md，另外删除 2 个入口；正文净减少 765 行、32,047 字符。字符数不是 tokenizer token 数。统计不包含本报告、参考文档和代码。

## 后续顺序

P0 优先：通用教程密度高，或将确定性实现写在提示词中。P1 次优先：还有重复工作流/示例，可改为目标、接口和条件。P2 定向精简：相对短，仅删明确重复句。保留：主要是项目专有合同，没有理由仅为变短删掉必要约束。

| 批次 | 候选 | 具体交付 |
| --- | --- | --- |
| 1 | paper-figure、paper-illustration、mermaid-diagram、paper-write、paper-slides、slides-polish | 删除通用绘图/排版/LaTeX 教程和长 prompt；保留真实数据、风格输入、现有 helper 与验收要求 |
| 2 | experiment-env-configuration、experiment-env-manager、aris-update | 先把脚本生成、修复状态和更新库存固化到 helper，再从 skill 删除重复实现；不能先删掉当前唯一实现 |
| 3 | auto-research-loop、auto-review-loop、paper-writing、research-refine、proof-checker | 合并重复流程/传输/模板；保留状态、交付、裁决和 evidence 协议，用现有回归校验 |

## 全量逐项清单

下表覆盖全部 94 个现存 skill，不遗漏短 skill。行数为修改前→当前；优先级属于后续建议，除标注“已精简”的项目外，不表示正文已全部改写。

### 配置、实验与 tester（15）

| Skill | 行数 | 级别 | 当前详细步骤主题 | 删减方向 | 必须保留 |
| --- | ---: | --- | --- | --- | --- |
| [aris-setup](../skills/aris-setup/SKILL.md) | 199→44 | 已精简 | 总览、编辑、确认、执行 | 删除 helper 查找脚本和逐动作 shell 示例；字段建议由 helper 生成 | 八模块总览、整份刷新、当前 digest 确认、设施证据与 root 写者 |
| [aris-update](../skills/aris-update/SKILL.md) | 605→605 | P0 | 安装扫描、差异、复制、manifest 重建 | 把扫描/复制/manifest 重建的整套 shell 实现交给更新 helper；skill 留决策 | 本地修改和项目生成 skill 的保护、dry-run/force、运行时库存 |
| [experiment-env-manager](../skills/experiment-env-manager/SKILL.md) | 1227→1222 | P0 | 配置、审计、分类修复三模式 | 共享修复逻辑只定义一次；时间戳/jq/状态文件代码交给 helper | 确认快照、独立审计、失败返回总览、运行时错误分类和完成状态写者 |
| [experiment-env-configuration](../skills/experiment-env-configuration/SKILL.md) | 1186→1186 | P0 | PRD 读取、环境部署、十个 ops 生成 | 删 conda/venv/SSH/rsync 的教程；库与 ops 固化模板后以参数渲染 | env.json/ops/receipt 合同、staging→pending_audit、patch 和 PRD 不变性 |
| [experiment-env-audit](../skills/experiment-env-audit/SKILL.md) | 736→736 | P1 | 静态检查、执行验证、审计输出 | 机械语法、字段、时间戳检查进验证器；不重复执行器部署教程 | 审计项目、真实执行证据、PASS/WARN/FAIL、reviewer 身份与新鲜度 |
| [run-experiment](../skills/run-experiment/SKILL.md) | 251→245 | P1 | 前检、同步、部署、监控、收集 | 避免重复 sync-code/build-env 和部署 skill 的操作说明；只列 ops 路由 | 当前 env 的十个 ops、异步监控终态、错误交 env-manager |
| [experiment-queue](../skills/experiment-queue/SKILL.md) | 543→537 | P1 | manifest/grid、远程队列调度与恢复 | 远端目录、命令包装和监控实现交 queue-manager；删普通 SSH 教程 | 资源不重叠、监控 heartbeat、恢复身份、wave 语义和完整结果 |
| [experiment-bridge](../skills/experiment-bridge/SKILL.md) | 604→585 | P1 | 计划实现、sanity、实验部署 | 压缩如何写代码和 sanity 的常识；不重述 run-experiment 的部署步骤 | milestone/children 计划执行、资源范围、交付件、tester 前置关系 |
| [tester-test](../skills/tester-test/SKILL.md) | 22→22 | 保留 | 完整 benchmark job 和结果预检 | 无明显通用教程；仅在确认字段已由引用覆盖时去重 | 完整样本/重复次数、候选交付件、job 恢复和原始结果绑定 |
| [tester-audit](../skills/tester-audit/SKILL.md) | 27→27 | 保留 | 独立证据审计与发布门禁 | 无明显通用教程；不能以长行替代协议或删除审计字段 | 独立 reviewer、结果/config/交付件绑定、当前 passing audit |
| [scorer-loop](../skills/scorer-loop/SKILL.md) | 25→21 | 保留 | scorer 修订、评测与裁决 | 已合并派发引用；其余主要是此工作流的特有合同 | revision 范围、评测/审计、候选选择和评审权限 |
| [vast-gpu](../skills/vast-gpu/SKILL.md) | 423→423 | P1 | 资源估算、报价选择、远端实验 | 删训练 VRAM/费用计算教学和重复租用/setup/deploy 示例 | 任务预算、实际资源证据、租用/销毁权限、原子脚本入口 |
| [serverless-modal](../skills/serverless-modal/SKILL.md) | 361→361 | P1 | 资源选择、Modal launcher、运行与收集 | 已有 env_helper deploy 就不再复述 launcher 实现与 SDK 样板 | backend 选择、运行/收集/清理路由及费用边界 |
| [system-profile](../skills/system-profile/SKILL.md) | 112→15 | 已精简 | 性能测量、插桩、瓶颈报告 | 删除工具目录、CPU/GPU/通信概念和逐步使用教程 | profile_output 原始证据、可逆插桩及完整改动清单 |
| [dse-loop](../skills/dse-loop/SKILL.md) | 298→298 | P1 | 参数空间、分阶段搜索、结果报告 | 删解析参数和探索/搜索的教学描述；过程留目标与约束 | 搜索空间、已有文件保护、禁止操作、结果来源与停止条件 |

### 研究编排（6）

| Skill | 行数 | 级别 | 当前详细步骤主题 | 删减方向 | 必须保留 |
| --- | ---: | --- | --- | --- | --- |
| [auto-research-loop](../skills/auto-research-loop/SKILL.md) | 1665→1661 | P0 | 单过程/递归、状态机、指标 gate、导出 | 重复 CLI 构造和 jq 运算进已有 helper；三层相同过程只定义一次 | 阶段顺序、charter/manifest、递归深度、stop gate、tester 与出口审计 |
| [research-pipeline](../skills/research-pipeline/SKILL.md) | 536→532 | P1 | 阶段选择与整链调度 | 只保留子 skill 顺序、输入输出和条件；删子 skill 的内部工作复述 | 阶段 receipt、接收门禁、dashboard 权限、独立于 ARL 的行为 |
| [idea-discovery](../skills/idea-discovery/SKILL.md) | 637→620 | P1 | 文献、创意、novelty、review、refine | 删各子 skill 的执行内容和重复报告样板 | 固定链条、SUB_ARGS 过滤、冻结输入、scope、结构化候选/children 交付 |
| [idea-discovery-robot](../skills/idea-discovery-robot/SKILL.md) | 385→381 | P1 | 机器人问题框架与研究链适配 | 删通用 ML 文献/创意步骤；只写机器人相对通用链的差异 | embodiment、真实机器人权限、数据/仿真边界和 robotics 交付字段 |
| [research-refine-pipeline](../skills/research-refine-pipeline/SKILL.md) | 193→189 | P2 | method 稳定后再计划实验 | 不重述 refine 和 experiment-plan 内部步骤及通用报告格式 | 方法规划顺序、规划 gate、输出路径和传参 |
| [auto-review-loop](../skills/auto-review-loop/SKILL.md) | 780→761 | P0 | review/fix/复审、停止、Wiki 吸收 | 共享 reviewer/backends 只留引用；修复教学和巨型示例移除 | reviewer 独立性、bridge_repair、tester 审计、metric 归属、result-to-claim |

### 文献、创意与实验规划（8）

| Skill | 行数 | 级别 | 当前详细步骤主题 | 删减方向 | 必须保留 |
| --- | ---: | --- | --- | --- | --- |
| [research-lit](../skills/research-lit/SKILL.md) | 598→589 | P1 | 多源检索、论文分析与综述 | 删“检索→阅读→按主题归纳”的常识、重复 source 导览和报告教程 | 显式 source 激活、验证 helper、真实引用、Wiki 写入 |
| [comm-lit-review-claude-single](../skills/comm-lit-review/SKILL.md) | 294→294 | P1 | 通信文献单 agent 综述 | 压缩与 research-lit 重复的库检索、阅读、归纳步骤 | 单 agent 边界、通信领域比较维度、来源和输出格式 |
| [idea-creator](../skills/idea-creator/SKILL.md) | 593→578 | P1 | landscape、生成、可行性、jury、pilot | 删“扫描资料/头脑风暴/写报告”教学；保留生成/裁决区别 | 不在 executor 做质量裁决、完整候选交 jury、pilot 限额、Wiki idea writer |
| [novelty-check](../skills/novelty-check/SKILL.md) | 122→116 | P2 | 提炼 claims、检索与独立 novelty 判断 | 删通用 novelty 检索方法和大段人类报告空模板 | 核心 claims、closest prior work、真实来源、独立 verdict |
| [research-review](../skills/research-review/SKILL.md) | 209→203 | P2 | 初评、延续对话与收敛 | 删收集上下文常识、重复 manual/codex 调用约定 | reviewer 线程连续性、评分/停止协议及结果路径 |
| [research-refine](../skills/research-refine/SKILL.md) | 802→798 | P0 | 问题锚、方案生成、评审与计划交接 | 删找 gap、选路线、写 proposal 的逐条教学与重复多份模板 | 不可变 problem anchor、冻结/评审状态、最终方法与实验 handoff |
| [experiment-plan](../skills/experiment-plan/SKILL.md) | 271→267 | P1 | claim→实验 storyline→执行顺序 | 删如何做科研计划的常识；大型示例交项目数据或模板 | claim-evidence 覆盖、baseline、资源观测、milestone 与可执行交付 |
| [ablation-planner](../skills/ablation-planner/SKILL.md) | 142→142 | P2 | 消融设计、审阅和可行性 | 删收集文件和解析计划常识；统一 reviewer 调用 | 针对机制的消融假设、对照变量、预算和输出路径 |

### 结果分析（7）

| Skill | 行数 | 级别 | 当前详细步骤主题 | 删减方向 | 必须保留 |
| --- | ---: | --- | --- | --- | --- |
| [analyze-results](../skills/analyze-results/SKILL.md) | 516→496 | P1 | 结果 bootstrap、子分析路由、verifier | 删每个分析子 skill 的方法复述和 manifest/jq 样板 | 已收集 result manifest、路由、probe 预算、cross-model 接收与 metric patch |
| [result-to-claim](../skills/result-to-claim/SKILL.md) | 478→472 | P1 | 结果→审计→claims/问题→Wiki | 删除通用 W&B/python 取数教程和重复人类报告样板 | 确定性 evidence precheck、tester audit、claim/experiment/problem writers |
| [analysis-comparison](../skills/analyze-results-tools/analysis-comparison/SKILL.md) | 70→70 | P2 | 跨运行比较、效应与统计 | 压缩“建表/算差值/置信区间”的方法教学 | 结果文件溯源、比较变量、统计条件、固定分析 artifact |
| [analysis-convergence](../skills/analyze-results-tools/analysis-convergence/SKILL.md) | 80→80 | P2 | 曲线、趋势、停滞/早停建议 | 删除平滑、斜率等普通分析步骤；保留所需判定标准 | 早停只给建议、run 范围、曲线来源、输出合同 |
| [analysis-training-dynamics](../skills/analyze-results-tools/analysis-training-dynamics/SKILL.md) | 69→69 | P2 | loss/LR/梯度与训练诊断 | 压缩常见 loss/LR/梯度解释和方法教学 | 观测与推断区别、证据、诊断限制、固定交付结构 |
| [analysis-wandb](../skills/analyze-results-tools/analysis-wandb/SKILL.md) | 55→55 | P2 | 运行定位与 W&B 导出 | 移除通用 SDK 取数说明；只列字段及导出接口 | run 映射、原始数字、无解释边界、结果路径 |
| [analysis-probe](../skills/analyze-results-tools/analysis-probe/SKILL.md) | 210→210 | 保留 | 假设、ledger、预算、受控 probe/replay | 短化代码实现示例；保留实际 ledger gate，不能当通用教程删 | evidence key、不可重复执行、预算、replay 权限和因果证据 |

### 检索服务与 Wiki（10）

| Skill | 行数 | 级别 | 当前详细步骤主题 | 删减方向 | 必须保留 |
| --- | ---: | --- | --- | --- | --- |
| [research-wiki](../skills/research-wiki/SKILL.md) | 545→545 | P1 | Wiki schema、命令、关系和 workflow 接口 | 把全文 CLI 手册缩成能力路由；完整模板由 helper/schema 提供 | 实体 ID、关系类型、唯一 writer、scope/head 绑定、指标门禁 |
| [wiki-enrich](../skills/wiki-enrich/SKILL.md) | 85→85 | P2 | 已有页面补充来源和内容 | 不重讲查论文和写摘要；仅留 enrich 输入输出差异 | 原内容保留、helper/source 激活及页面更新行为 |
| [arxiv](../skills/arxiv/SKILL.md) | 84→84 | 保留 | 检索、下载、读取与 Wiki | 已主要是专有 CLI 选项；可删普通 query/ID 解释 | helper、过滤项、失败停止、下载验证与 Wiki writer |
| [semantic-scholar](../skills/semantic-scholar/SKILL.md) | 76→76 | 保留 | 论文检索与 metadata | 不重讲通用搜索；保留 service 参数 | 真实 metadata、输入过滤、helper 和写入合同 |
| [openalex](../skills/openalex/SKILL.md) | 49→49 | 保留 | OpenAlex 检索 | 已短；无需改成泛泛搜索教程 | 显式过滤/排序、helper 和失败边界 |
| [deepxiv](../skills/deepxiv/SKILL.md) | 68→68 | 保留 | 逐级论文读取与检索 | 保留专有 progressive reading 接口，不复述如何读论文 | operation、深度、helper 和 Wiki provenance |
| [alphaxiv](../skills/alphaxiv/SKILL.md) | 45→45 | 保留 | 论文读取接口 | 已短；保留特有工具/操作映射 | helper、来源、Wiki 对接 |
| [exa-search](../skills/exa-search/SKILL.md) | 65→65 | 保留 | 语义检索、相似与内容提取 | 通用检索常识可省，工具参数属于未知接口应保留 | operation 选择、实际内容、helper、失败停止 |
| [gemini-search](../skills/gemini-search/SKILL.md) | 39→39 | 保留 | Gemini 检索与来源处理 | 已短；不另加通用搜索步骤 | MCP 可用性、citation count 限制、缺失字段和来源 |
| [qzcli](../skills/qzcli/SKILL.md) | 314→314 | P1 | Zotero 终端操作手册 | 从命令全目录改为能力索引；细节用 CLI help/特定操作参考 | 服务专有选项、集合/条目定位、真实引用及写入边界 |

### 论文与写作（8）

| Skill | 行数 | 级别 | 当前详细步骤主题 | 删减方向 | 必须保留 |
| --- | ---: | --- | --- | --- | --- |
| [paper-writing](../skills/paper-writing/SKILL.md) | 828→809 | P0 | plan→figure→write→compile→audits→improve | 只列阶段图、I/O 和条件；删除各子 skill 内部动作与冗长报告模板 | assurance、条件 audits、最终 submission verifier、输出和接收顺序 |
| [paper-plan](../skills/paper-plan/SKILL.md) | 401→397 | P1 | claim/evidence、章节与图表计划 | 删抽取素材/按章写提纲的教学及重复报告模板 | claim-evidence 主线、图表来源、引用支架及 PAPER_PLAN |
| [paper-write](../skills/paper-write/SKILL.md) | 609→609 | P0 | LaTeX 项目创建、逐节写作、编译交接 | 删目录创建、常用 LaTeX 宏/章节写作教程；模板直接引用 | 项目文件约定、真实证据/引用、写作 overlay、交付与下游编译 |
| [paper-compile](../skills/paper-compile/SKILL.md) | 212→22 | 已精简 | 编译、检查与 readiness 报告 | 删除安装/ls/grep/pdf 工具教程、易陈旧 venue 表和完整摘要样板 | 单次编译、源文件不改、失败停止、compile.log、真实 venue 规则 |
| [auto-paper-improvement-loop](../skills/auto-paper-improvement-loop/SKILL.md) | 656→650 | P1 | 保存原稿、review/fix、重复审阅 | 删复制/编译/修稿教程和重复 reviewer/backend 定义 | edit whitelist、reviewer 独立性、原稿保护、round 状态及停止 |
| [grant-proposal](../skills/grant-proposal/SKILL.md) | 710→706 | P0 | grant 结构、aims、草稿与评审 | 删除常见申请书写作教程和各项目重复长模板；按项目需求选参考 | grant 类型约束、用户研究事实、参考风格、预算和最终输出 |
| [writing-systems-papers](../skills/writing-systems-papers/SKILL.md) | 189→189 | P1 | 系统论文 thesis、contributions、故事与自检 | 删除常见写作常识；只保留本项目确实偏好的评分标准 | 系统实验真实性、thesis/贡献-证据映射和特定风格要求 |
| [interview-cheatsheet](../skills/interview-cheatsheet/SKILL.md) | 250→250 | P2 | 提纲、教程稿、math/code review | 删计划/写 Markdown/编译通用操作；保留用户要求的教程风格 | canonical style、独立数学/代码审阅、输出文件与修复闭环 |

### 图表与图像（6）

| Skill | 行数 | 级别 | 当前详细步骤主题 | 删减方向 | 必须保留 |
| --- | ---: | --- | --- | --- | --- |
| [paper-figure](../skills/paper-figure/SKILL.md) | 284→284 | P0 | 图表计划、matplotlib 风格、绘制与 LaTeX | 删除 matplotlib 样板、图种百科、mkdir/运行脚本/include 教程 | 真实数据、期刊/项目风格输入、可复现脚本和图表路径 |
| [paper-illustration](../skills/paper-illustration/SKILL.md) | 757→757 | P0 | 规划、布局、风格、生成、视觉评审 | 删除配色/箭头/布局常识和多套重复长 prompt；不用固定逐步仪式 | 数据语义、生成 helper、风格输入、独立视觉 gate 和资产来源 |
| [paper-illustration-image2](../skills/paper-illustration-image2/SKILL.md) | 382→382 | P1 | Image2 图像 bridge 与审阅 | 与 illustration 共用风格准则；只保留此 backend 的实际差异 | bridge 参数/输出、来源、质量 gate 与 backend 条件 |
| [figure-spec](../skills/figure-spec/SKILL.md) | 269→269 | P1 | FigureSpec 构建、渲染与评审 | 删除通用布局教学；专有 JSON schema 用一份权威定义 | FigureSpec 字段、渲染 helper、语义正确性和验证结果 |
| [mermaid-diagram](../skills/mermaid-diagram/SKILL.md) | 439→439 | P0 | 图种选择、语法验证、渲染、视觉 gate | 删 diagram 类型百科、语法教学与强制逐动作/评分模板 | 真实拓扑、允许类型、渲染入口、语法/可读性验收 |
| [pixel-art](../skills/pixel-art/SKILL.md) | 152→152 | P2 | SVG 图元、调色、迭代与导出 | 删 SVG 基础、像素艺术常识和一般迭代问答教程 | 用户像素尺寸/配色要求、像素网格和交付格式 |

### 演讲、展示与渲染（5）

| Skill | 行数 | 级别 | 当前详细步骤主题 | 删减方向 | 必须保留 |
| --- | ---: | --- | --- | --- | --- |
| [paper-slides](../skills/paper-slides/SKILL.md) | 649→649 | P0 | 演讲提纲、逐页内容、Beamer、编译 | 删除 Beamer/字体/配色样板和按 slide 固定章节教学 | talk 时长/听众、paper 证据、既定输出、风格输入和可编译交付 |
| [paper-talk](../skills/paper-talk/SKILL.md) | 401→397 | P1 | 提纲确认、baseline deck、polish、assurance | 只保留组合顺序；不要复述 paper-slides/slides-polish 内部操作 | 提纲 checkpoint、assurance、最终文件一致性及 paper provenance |
| [slides-polish](../skills/slides-polish/SKILL.md) | 577→573 | P0 | 逐页 triage、Beamer/PPTX 字体与布局 | 删 PPTX 常见坑目录、字号教学、固定 prompt；用渲染验收代替教程 | 原稿/working copy、视觉缺陷级别、真实纸面内容和改动记录 |
| [paper-poster-html](../skills/paper-poster-html/SKILL.md) | 313→313 | P1 | 设计输入、paper ingest、布局、导出 | 删 HTML/CSS 网格常识、重复 scaffold/截图步骤；复用现有模板 | venue 尺寸、数据/图 provenance、布局验收与导出状态 |
| [render-html](../skills/render-html/SKILL.md) | 394→379 | P1 | artifact→template→helper→review | 删一般 HTML 渲染和报告空模板；只留场景选择与 gate | template 映射、指定 helper、review 证据和输出路径 |

### 证据、数学与论文审计（9）

| Skill | 行数 | 级别 | 当前详细步骤主题 | 删减方向 | 必须保留 |
| --- | ---: | --- | --- | --- | --- |
| [proof-checker](../skills/proof-checker/SKILL.md) | 917→911 | P0 | proof ledger、review/fix、反例、闭合与 artifacts | 删读文件/改 TeX/编译教学；共享 reviewer；常用定理核对按需使用 | 两轴 severity、proof obligations、独立复审、不可证明报告及 artifact schema |
| [proof-writer](../skills/proof-writer/SKILL.md) | 259→259 | P1 | 命题正规化、依赖、证明与检查 | 压缩“读上下文/建依赖/分步写证明”的通用方法教程 | 真实 assumptions、证明完整性、目标边界和交付形式 |
| [formula-derivation](../skills/formula-derivation/SKILL.md) | 324→324 | P1 | 目标、invariant、假设、推导分类与说明 | 删普适推导教材和机械拆步；指定目标、证据与解释标准即可 | 推导目标固定、假设/符号一致、理论 vs 经验区别及输出 |
| [kill-argument](../skills/kill-argument/SKILL.md) | 593→576 | P1 | 独立 attack、adjudication、报告与问题 | 删除寻找源文件/报告格式教学、重复 reviewer 调用；保留两线程差异 | 独立 attack/adjudication、detect-only、未解决问题 writer、audit artifact |
| [paper-claim-audit](../skills/paper-claim-audit/SKILL.md) | 369→363 | P1 | 定位 paper/results、review、artifact | 删除“收集→送审→打印”脚本样板；核对字段由 verifier 承担 | 路径-only briefing、数字与实际结果、fresh reviewer、输入 hashes |
| [citation-audit](../skills/citation-audit/SKILL.md) | 542→536 | P1 | citation/context、核验、裁决与修改 | 抽取 cite keys/上下文与汇总进 helper；删 bib/编译通用教程 | 真实来源、fresh review、fix/replace/remove 权限及审核 schema |
| [experiment-audit](../skills/experiment-audit/SKILL.md) | 326→320 | P1 | 实验 artifact 独立审阅 | 删除收集文件/解析/报告常识；共享 review transport | 原始路径-only evidence、no summary leakage、verdict 与实际 artifacts |
| [rebuttal](../skills/rebuttal/SKILL.md) | 390→386 | P1 | reviews→concerns→strategy→evidence→draft | 删除普通 reviewer 回复写作教程及重复保存/备份步骤 | 原 review 保真、venue 规则、证据不虚构、draft/approval 输出 |
| [resubmit-pipeline](../skills/resubmit-pipeline/SKILL.md) | 455→451 | P1 | 新投稿副本、audits、文本修订与发布 | 删除 cp/目录/编译/同步教学；保留实际允许的编辑范围 | 历史投稿保护、text-only、无新实验、anonymity 和最终 gate |

### 专利（10）

| Skill | 行数 | 级别 | 当前详细步骤主题 | 删减方向 | 必须保留 |
| --- | ---: | --- | --- | --- | --- |
| [patent-pipeline](../skills/patent-pipeline/SKILL.md) | 353→353 | P1 | prior art→claims→spec→review→jurisdiction | 不重复各专利子 skill 的写作过程；留输入输出依赖 | jurisdiction、patent 类型、claims/spec 一致性及 examiner gate |
| [prior-art-search](../skills/prior-art-search/SKILL.md) | 160→160 | P2 | 概念检索、学术/专利对比、FTO 提示 | 删除一般关键词拆解/数据库检索步骤；FTO 限制保留 | 文献来源、element 对比、preliminary FTO 不作确定性结论 |
| [patent-novelty-check](../skills/patent-novelty-check/SKILL.md) | 164→164 | P2 | element、anticipation、obviousness、review | 压缩法律概念教材和通用比较教程；特定 jurisdiction 另取规则 | element-by-element evidence、jurisdiction 差异与 examiner review |
| [invention-structuring](../skills/invention-structuring/SKILL.md) | 204→204 | P2 | problem-solution-advantage、分解与依赖 | 删通用问题-方案框架教学和机械逐步提问 | 用户发明事实、claimable 结构、drawing/claim 对应 |
| [claims-drafting](../skills/claims-drafting/SKILL.md) | 245→241 | P2 | 独立/从属 claims、spec mapping、审阅 | 删通用 claims 写作教材；保留明确的本地规范和必要例外 | patent 类型/jurisdiction、支持关系、claim scope 与 examiner review |
| [specification-writing](../skills/specification-writing/SKILL.md) | 222→222 | P1 | 初始化、标题、技术领域、背景、内容 | 删创建文件和每个标准章节如何写的教程；使用模板 | 必需章节、发明事实、claims support、术语及输出布局 |
| [embodiment-description](../skills/embodiment-description/SKILL.md) | 135→135 | P2 | embodiments、标号、claim support | 删一般段落写法与算法实施例常识 | 覆盖 claims、reference numerals 一致、真实实现细节 |
| [figure-description](../skills/figure-description/SKILL.md) | 146→146 | P2 | 图发现、分析、标号、drawing descriptions | 删除 glob/目录搜索、逐图描述的常识 | 图和文本标号对应、原始图来源、reference numeral index |
| [patent-review](../skills/patent-review/SKILL.md) | 209→209 | P2 | 上下文、examiner 首评/复评、报告 | 删上下文收集和报告模板；共享 examiner transport | 同一 review 线程、支持/范围缺陷、jurisdiction 及最终输出 |
| [jurisdiction-format](../skills/jurisdiction-format/SKILL.md) | 215→215 | P2 | CN/US/EP 排版与一致性 | 避免标准章节逐条教程；可用权威模板，规则按 jurisdiction 读取 | 指定 jurisdiction、形式差异、内容一致性和交付格式 |

### 治理、同步与通知（4）

| Skill | 行数 | 级别 | 当前详细步骤主题 | 删减方向 | 必须保留 |
| --- | ---: | --- | --- | --- | --- |
| [meta-optimize](../skills/meta-optimize/SKILL.md) | 327→323 | P1 | usage 分析、优化目标、patch 与预审 | 删常见频率分析/报告教学；不在 skill 教如何写 diff | proposal staging、不可自批准、落地由 meta-apply 裁决 |
| [meta-apply](../skills/meta-apply/SKILL.md) | 136→136 | 保留 | staged patch、landing jury、应用与 provenance | 流程主要是权限协议；只合并规则重复，不删 gate | reject-default、jury-at-landing、Write/Edit 权限、receipt 不等于免责 |
| [overleaf-sync](../skills/overleaf-sync/SKILL.md) | 223→223 | P2 | clone/sync/push 与冲突保护 | 删一般 Git 操作说明；保留特定 Overleaf 连接和同步约定 | 双边编辑互斥、源/remote 身份、冲突及用户发布权限 |
| [feishu-notify](../skills/feishu-notify/SKILL.md) | 164→164 | P2 | 配置、单向/bidirectional 通知与 delivery | 删普通 webhook 拼装教程；调用通知 helper | mode off 静默、具体 config/response、超时与 side effect 激活条件 |

### Paseo 根级 skills（6）

| Skill | 行数 | 级别 | 当前详细步骤主题 | 删减方向 | 必须保留 |
| --- | ---: | --- | --- | --- | --- |
| [paseo](../../../skills/paseo/SKILL.md) | 131→131 | 保留 | projects/workspaces/agents/heartbeats API | 不教通用 CLI；专有 API 与所有权信息仍应保留 | daemon 路径、profile/provider discovery、background/notify 与 lifecycle |
| [paseo-help](../../../skills/paseo-help/SKILL.md) | 92→92 | 保留 | 拓扑、诊断、日志、升级反馈 | 通用排错常识可再短化，不能删多机器/daemon 拓扑边界 | 配置来源、证据、权限及官方文档入口 |
| [paseo-plugin](../../../skills/paseo-plugin/SKILL.md) | 646→646 | P1 | 插件 SDK、多 UI/API surface 与 examples | 删 npm/项目创建教程；各 surface 示例按需读取，核心仅留能力路由 | Paseo SDK/RPC/lifecycle hook 精确接口、daemon/client 语义及官方来源 |
| [paseo-handoff](../../../skills/paseo-handoff/SKILL.md) | 65→65 | P2 | profile 选择、交接 briefing、新 agent | 不重复完整交接提示词空模板；只列必需字段 | profile/owner/workspace 选择、已尝试内容及 agent 初始上下文 |
| [paseo-advisor](../../../skills/paseo-advisor/SKILL.md) | 63→63 | P2 | advisor 选择、briefing、持续讨论 | 压缩一般写 briefing/综合建议常识 | advisor profile、no edits、持久 agent 的用途与生命周期 |
| [paseo-committee](../../../skills/paseo-committee/SKILL.md) | 46→46 | 保留 | 双 profile 独立评议与综合 | 已短；只消除“写 prompt/汇总”泛泛描述 | 独立线程、no edits、委员会组成和结果归属 |

## 精简验收

一次精简必须满足：被引用的 helper/schema 真实存在；输入、输出、角色权限、状态和失败行为不变；没有把重复内容搬到默认必读参考；删减同时减少字符量；对应的 inventory、协议和功能检查通过。通用动作无需为了短 skill 再补一份逐步教程。
