# ARIS 长周期递归研究：流程与契约

这份文档用来对齐**目标能力是否已经实现**。它只写两类东西：系统应该做到什么，以及代码里靠什么机制做到。实现细节（函数签名、字段全集、错误码清单）不在这里，看代码。

写作原则：**以代码实际行为为准**。凡是文档和代码冲突的，代码是对的，文档是过期的。

---

## 1. 目标能力与落地状态

| # | 目标能力 | 靠什么机制成立 | 状态 |
|---|---|---|---|
| 1 | 研究可以无限递归下去，不靠人预设层数 | run 三字段（`parent_run_id` / `depth` / `scope_path`）+ 预算切分 | 已实现 |
| 2 | 子 run 不知道自己是谁的子、在第几层 | charter 的字段集合里没有这类信息，子 run 只收到任务 | 已实现 |
| 3 | 父子之间只有两个文件，任何深度形状一样 | `charter.json` 下行、`result-package.json` 上行 | 已实现 |
| 4 | 跑不起来和跑出来不好，是两条不同的修正路径 | `bridge_repair` vs. 参数修正 | 已实现 |
| 5 | 只有"换想法"算一次迭代，调参重跑不算 | metric-gate 按 iteration 索引，同号只留最后一条 | 已实现 |
| 6 | 所有会影响后续判断的落盘都要有独立 verifier | 每个前提文件在写入点解析它的 verifier 回执，回执字段从核实结果取 | 已实现 |
| 7 | 知识在 run 之间以事件流积累，不是共享可变状态 | Research Wiki 事件 + 投影 | 已实现 |
| 8 | 最优版本由导出阶段跨轮挑选，不是由某一轮自己宣称 | `result-export` 排名 | 已实现 |
| 9 | tester 只能说聚合数字和粗粒度方向，说不出测试内容 | tester 的出口是签名的结构化回执，没有放一段话的位置 | 已实现 |
| 10 | 停机判据是预算和验收，轮数只是可省略的兜底 | `budget_exhausted` 先于 `iteration_cap`，后者不配置就不存在 | 已实现 |
| 11 | 人配一个项目只需要一条命令，缺什么由检测器指出而不是靠记 | `/aris-setup` 编排六个阶段，`project-setup-cli.js status` 逐段判定并在没配全时退非零 | 已实现 |
| 12 | 一个 run 的优化对象可以是"这个问题该怎么拆"，而不是某个实验 | 每一代的分解图先落盘再派子，改图要 tester 信号开 wave | 已实现 |

---

## 2. 一次 run 内部：四个阶段

```
idea-discovery  →  experiment-bridge  →  auto-review-loop  →  metric-gate
   出想法              执行计划              跑+诊断+修正         判这轮成不成
```

四段是代码里的硬白名单（`dashboard-merge.ts` 的 `WORKER_RULES`）。不在白名单里的阶段回执进不来，所以流程不会被某个 skill 临时加一段绕过去。

各段的职责边界：

- **idea-discovery** 出想法，并且**自带 verifier**——想法不是自说自话落盘的。
- **规划在计划里，不在 bridge 里**：要不要派子 run、派几个、每个子 run 的 charter 写什么，是 idea-discovery 产出的实验计划决定的。只有一种 run 例外——它的优化对象就是这张分解图本身，那张图在派任何子之前已经单独落盘（§3），计划只能决定这一轮先派其中哪几个。
- **experiment-bridge 只是执行者**，不做规划决策。它的输出是"跑成了/没跑成"。
- **auto-review-loop** 跑实验、读结果、调参、重跑，直到达标或者这轮预算用光。它有参数诊断能力：结果不好时判断是想法不行还是参数没调对。
- **metric-gate** 判这一轮算不算有提升。

### 两条修正路径

这两条容易混，但触发条件、身份处理、对指标门的影响都不一样：

| | 跑不起来 | 跑起来了但结果不佳 |
|---|---|---|
| 触发 | `experiment-bridge` 返回失败回执或产物不可用 | `analyze-results` 判定是参数问题 |
| 路径 | `bridge_repair` | 参数修正（auto-review-loop 内部） |
| 身份 | 保持同一 candidate identity | 新的 trial identity |
| 指标门 | 不推进 | 推进 |
| 结束条件 | `repair_status` 为 `fixed` 或 `exhausted` | 本轮切分下来的预算用完 |

**判定权归 `analyze-results`，不归修正者。** 让修正者自己判断"我这次算不算修好了"就是让它给自己打分。监督信号必须来自 `analyze-results`，不能来自 tester——tester 是最后的验收方，不参与过程指导。

---

## 3. 递归：父怎么派子

递归靠三个字段成立，写在每个 run 的 `run.json` 里：

```json
{
  "run_id": "run-training-7",
  "parent_run_id": "run-root-1",
  "depth": 1,
  "scope_path": "/training"
}
```

- `parent_run_id` 为空就是根。
- `depth` 是**观测值，不是约束**——它记录"这个 run 在第几层"，不用来限制能派多深。
- `scope_path` 只用于知识作用域和所有权互斥，**不是文件路径**。
- 子的 run id 不用父 id 作前缀。父子链接只记在子的 `run.json.parent_run_id` 这一处（父另有 `runtime.children` 做位置索引，那是索引不是真相）。

### 单向可见性

这三个字段是**调度器侧的**。子进程拿到的 charter 和 manifest 里没有它们。`run-charter.ts` 维护一份拒绝列表：

```
parent_run_id, outer_run_id, scope_path, depth,
outer_iteration, wave_id, wave_kind, generation,
execution, depth_budget, max_depth
```

charter 里出现任何一个，直接 `UNKNOWN_FIELD` 拒绝。**父创建子，子没有知道父的必要**——子知道了父的身份和层数，就会开始为"在整体里的位置"做优化，而不是为自己的 charter 做优化。

### 层间只有两个文件

任何深度，形状都一样：

```
charter.json                      result-package.json
  charter_id                        run_id / run_version
  problem                           status
  evidence_refs                     input_snapshot_sha256
  constraints                       output_paths / output_hashes
  expected_output                   summary_sha256
  input_snapshot_refs               best_idea_ref / execution_plan_ref
  baseline_ref                      evidence_refs
  optimizable_scope                 failure { reason, failure_code, evidence_refs }
  budget                            child_summaries
  measurement                       cost_actual
```

`result-package.json` 旁边配一份人读的 `result-summary.md`，正文不超过 500 字。

### status 四分类

| status | 含义 | 能进 validation | 计入"本轮无提升" | 占用 tester 名额 |
|---|---|---|---|---|
| `succeeded` | 跑完了，有结果 | 能 | 按结果计 | 按流程 |
| `failed` | 跑完了但结果不合格 | 能，作为有效负结果 | 计入 | 按流程 |
| `not_executable` | 修复预算耗尽，实验没跑起来 | 不能 | 不计入 | 不占用 |
| `infra_unavailable` | 远程服务、GPU 或传输故障 | 不能 | 不计入 | 不占用 |

区分 `not_executable` 和 `infra_unavailable` 的判据只有一条：方案需要的资源**不在冻结清单里**是 `not_executable`；清单里有但运行时拿不到是 `infra_unavailable`。前者是方案的问题，后者是环境的问题，只有前者算研究上的负结果。

### 复用与缓存

```
run_identity = H(
  charter_sha256, input_snapshot_sha256, execution_plan_sha256,
  code_baseline_sha256, policy_revision, sorted(child_run_identities)
)
```

子身份进父身份，所以任何一层变了，上面所有层的身份都变。`execution_plan_sha256` 必须是实验方案本身的规范化哈希，不能拿别的凑。复用封存输出前必须重新校验 `output_hashes` 和磁盘一致——文件可能在两次之间被动过。

**预算是切分不是叠加。** 父把自己的预算分给子，子花完就没了，不能向父再要。这是递归能自然收敛的原因。

### 位置、任务和代

`children.json` 是父的位置索引：一个位置（`position_id`）记它这一代派给了哪个 run、任务哈希是多少、上一代同位置是谁。任务哈希只取父决定的那部分——问题、要求的产出、约束、依赖谁。于是"这一代和上一代是不是同一个任务"是可判定的事实，不靠谁声明：

- 任务没变：这一代照样开一个新 run（run 的预算只能花一次），但它从上一代同位置那个 run 的 Wiki 继承知识。
- 任务变了：那是另一个问题，新 run 从空 Wiki 开始。让它带着上一个问题的结论开工，等于让它去接着证明一件已经不成立的事。

### 串行边

一个位置可以声明 `depends_on`。声明了就意味着：上游没发布 `result-package.json` 之前，下游连派都派不出去；派的时候它的输入快照不是基线，是上游的产出哈希。没声明就是并行。这条边只存在于父的分解图里，子不知道自己前面还有谁。

### 当优化对象就是这张分解图

有一种 run 要优化的不是某个实验，而是"这个问题该怎么拆"：拆成哪几个子 ARL、每个子问什么、哪些串行哪些并行。子是普通的 ARL，父子之间还是 charter 下行、`result-package.json` 上行，形状一点没变。变的是三件事。

**一、图先落盘，再派子。** 每一代的分解图单独写在 `decomposition/generation-N.json`，在第一个子被派出去之前就写好。派子时拿这次派的位置去跟这张图核对：可以只派其中一部分（串行图本来就得分几批派），但不能派图里没有的位置，也不能改图里写好的任务。反过来做——从"派了哪些子"倒推这一代的图——在串行图上是错的：第一批只有上游，那张图会被冻死在只有上游的形状上。

**二、第一代就是基线。** 创建即基线，不需要先证明自己比谁好。之后要改结构，得先有 tester 的反馈信号，用它开一个 wave：wave 冻结"从上一代的哪张图出发、做哪几个改动、得到哪张图"，落在 `decomposition/wave-N.json`，然后才能记录下一代。所以结构演进只发生在整张图跑完一轮之后——没跑过的结构没有可比的证据。

**三、整体的分数要等全代收完。** 一代里每个位置都有终态子（成功、失败、或者跑完了但没报出验收要的指标）之后，这一代才算收回来。回收本身不写任何文件：谁应该存在看分解图，谁承载它看 `children.json`，它交回了什么看子自己的 result-package——三份都已经各有唯一写入方，再落一份就是第四份会过期的事实。每个子用父给它的验收器打一次分；验收器的内容不会在子跑的过程中变，已发布的 result-package 也不会变，所以这个分重算多少次都是同一个答案，不必记下来。

全代收完之后，父才用自己的 validator 去测装配起来的整体，把这个数写成 `metric.current` 进指标门。收完之前这个键会被拒——半个结构测出来的数没有意义，而下一代要拿它当比较基准。

父的预算按"还打算跑几代"切分，第一代不能把它全花掉，否则后面几代没有可派的东西。

### 父子不同时改

父在重排结构、子在跑迭代，改的是同一件东西的两端。所以锁只有一条规则：结构锁排斥它底下的一切，也被底下任何一个持有者挡住。别的组合都不冲突——父在迭代、子也在迭代，本来就是派发的常态。持有者是不是还在，不看进程，看它的 result-package 发没发布：一次迭代是一长串互相独立的命令，进程活不活证明不了任何事。

---

## 4. 递归怎么停

四条，任意一条命中就停：

1. 本轮 plan 没派子节点。
2. 成本预算切分耗尽。
3. stop gate 判定无提升。
4. 验收通过。

**没有深度上限。** 轮数也不是停机判据：`config.max_iterations` 是可省略的兜底，只在预算大到一个死循环能烧完它之前没人看的情况下才有意义。它排在所有判据最后（`invalid_metric > metric_met > budget_exhausted > patience_exhausted > iteration_cap`），不配置就没有轮数上限。

stop gate 数的是**想法轮数**。参数修正的重跑不产生新迭代号，同一迭代号只保留最后一条记录。这带来一条使用纪律：**一轮里调参多次时，最后提交的那次必须是最好的那次**，否则你把一个次优结果当成这轮的成绩交上去了。

预算文件是前置条件：任何能被 gate 评估的 run 必须先 `initializeRunBudget`，否则 gate 读预算时抛 `BUDGET_REQUIRED`。

---

## 5. 知识怎么积累：Research Wiki

Wiki 是**事件流 + 投影**，不是共享可变状态。写入是追加事件，读取是把事件投影成页面。两个 run 并发写不会互相覆盖，重放事件能重建任何时点的状态。

三种读写边界：

- **作用域隔离**：`assertResearchVisible` 决定哪些字段能进 Wiki、能被查出来。测试内容相关的字段（`case_id`、`prompt`、`question`、`answer`、`score`、`per_case`、`uri`、`raw_result` 等）在写入时就被拒。
- **signal 的 kind 不由调用方选**。它由结论唯一决定：`improved` → `observation`，`not_improved` → `failure`，其余 → `constraint`。调用方不能自己指定，否则一个想让自己好看的 worker 会把失败写成观察。
- **tester 值走签名回执入库**，没有手填的 flag。见 §7。

---

## 6. 怎么防止自欺

系统里所有的"防自欺"设计都落在同一条原则上：**判断的人不能是被判断的人**。

### 独立 verifier

凡是会改变后续研究判断所依据前提的写入，都要有一个独立 verifier 回执。回执不能是写入方自己填的两个字符串——那只是拼写规则，不是审查。所以核实发生在每个写入点，回执字段从核实结果拷贝，而不是从调用方入参拷贝：

| 前提文件 | 谁核实 | 核实什么 |
|---|---|---|
| `result-package.json` | `result-review.ts` 的 `requireApprovedResultReview` | 读回 reviewer 落盘的 verdict，要求它 `approved` 且 `package_sha256` 等于**正要写的这个包**的摘要 |
| `promotion-commit-intent.json` | `tester-public-receipt.ts` 的验签 | 用配置里钉死摘要的 tester 公钥验签，在 intent 构造之前 |

result package 的摘要绑定是关键：包由输入确定性构造，reviewer 拿着候选能算出和写入方一样的摘要，所以"拿 A 包过审、发 B 包"会因为摘要不匹配被拒（`RESULT_REVIEW_SUBJECT_MISMATCH`）。流程因此是三步：`plan_result_package` 打印摘要 → reviewer `submit_result_review` → `export_result_package` 才写。verdict 一旦落盘不可变。

`review-submit.ts` 是另一套东西，别和上面混。它管的是**父对自己派出去的工作**的审查（validation 比对、scorer 修订、promotion 测试），每条路径都要求外层 run 把被审的 run 列为自己的 child。research run 对自己产出的包的审查不属于它：审查者在 run 内部，没有父参与，父也无权知道这个 run 存在（§2 的身份隔离）。

`state-file.ts` 本身不核实任何东西，也不该被当成 verifier 读：它只保留一条与主题无关的不变式——产出者不能是自己的接受者（`REVIEWER_NOT_INDEPENDENT`）。新增前提文件时先在写入点给它一个真 verifier，再谈 receipt。

### 三道闸，一道比一道贵

1. **metric-gate**：每轮都过，判这轮有没有提升。便宜、可以反复跑。
2. **validation gate**：baseline 必须先过硬约束，候选必须跑完整且过硬约束，独立 review 的 verdict 必须是 `approved`。全过之后本 wave 至多产生**一个** finalist（`unique_validation_finalist`）。
3. **promotion gate + tester**：唯一 finalist 才能原子预留一次 tester exposure。提交给 tester 的两个槽位角色是**显式**的——契约里恰好一个 `reference`（matching baseline）和一个 `candidate`（finalist）。这里不能做成匿名：tester 要给的是 `improved | not_improved | inconclusive` 这种**有方向**的结论，不知道哪个是候选就无从判起，而这个判断权本来就该在 tester 手里。角色**不能按分数决定**，提交前就定死。真正匿名的是**模型身份**——提交体里只有产物摘要和 id，没有模型名；"谁对应哪个模型"只记在本机的 `tester-arm-map.json` 里，不出本机。统计用显式的 `paired_student_t`。一次 `promotion_trial_id` 最多结算一个 exposure。

失败时**同一个 wave 不允许把 runner-up 送进 tester**。这条是整个防自欺设计里最关键的一条：允许换人重试，等于用多次抽样换一次显著，tester 就只是个筛子而不是闸门了。

---

## 7. tester 边界

tester 持有 held-out 测试集。它的公开出口只有两样：

**一、`metrics`**——聚合数值。指标名必须和冻结的 `definition.gate.primaries` 完全一致（双向校验，上限 16 个）。指标可以有多个，不限单个。

**二、固定词表的粗判断**：

```
conclusion:  improved | not_improved | inconclusive
directions:  long_horizon_stability | tool_use_consistency |
             safety_regression | cost_efficiency | interface_compatibility
advice:      increase_long_horizon_consistency | strengthen_tool_use_consistency |
             review_safety_margin | reduce_cost_variance | tighten_interface_contracts
```

词表是**枚举，不是自由文本**。这是它能被公开的原因：一个 worker 无法通过精心措辞把 case 的信息编码进去。

### 读写不对称

- **写是封闭的**：只能通过签名验证的公开回执进入实验页，没有手填的 flag。
- **读是开放的**：进了页之后，它和任何别的测量值一样——query 路径返回它，markdown 投影打印它。`idea-discovery`、bridge repair、result-package 导出看到的是同一份聚合值。

**读它不构成对 held-out 集调参**，因为能让你调参的东西（case、prompt、answer、per-case 分数）从来没进过 Wiki。这不是靠扫一段话找敏感词——tester 的出口是一个签名的结构化 envelope，字段全是 id、摘要、枚举值和一个指标 map，没有能放一段话的位置。进 Wiki 的路径只有一条：`addExperiment` 用配置里钉死摘要的 tester 公钥验签，再把字段从验过的 envelope 拷进实验页。换密钥、改数字后重算自摘要、给回执贴一个它没判过的迭代号，三种都在写入前被拒，`tests/test_result_export.ts` 逐条覆盖。

### 子 ARL 碰不到 tester

递归里只有根那个 run 面对 tester。子 ARL 的验收器是父在派它的时候冻结的：一个指标名、一个方向、一个阈值，存在父这边，子的 charter 只拿到它的 id。子不能把 task tester 的 id 写进自己的 charter——bridge 直接拒——所以没有任何一条路径能让子去问 tester 要一个数。

这条边界同时是预算边界：tester 的曝光次数是按整个研究算的稀缺资源，子拿父给的验收器打分不消耗它。否则一个 run 只要多拆几层就能把曝光预算花光，而每个子拿回来的还是同一个 held-out 集的信息。

### tester 在哪、隔离靠什么

tester 是**另一台机器上的一个 Claude agent**，由那台机器自己的 Paseo daemon 管。研究侧通过 `paseo --host ssh://...` 把远端 daemon 端口隧道回本机，能做的只有两件事：**声明一个测试**（给 project id + 领域测试需求，tester 回一份签名的提交契约，说明它要什么格式的产物、怎么跑）、**提交一对产物去测**。

隔离**不靠文件属主**，靠两条物理事实：

- **私钥从来没离开那台机器**。密钥对在部署时由远程机器上的命令生成，只有公钥被拉回本机，并在配置里用 sha256 钉死。研究侧可以随便读公钥——公钥本来就是公开的——但签不出一份能过验签的回执。钉死摘要防的是"把公钥换成一把自己生成的钥匙"，这件事以前靠 root 属主挡，现在靠摘要比对挡，而且不需要有人来 sudo。
- **case 从来没离开那台机器**。tester 自己生成 case、自己评分，回来的只有一个签名的结构化 envelope。

边界要说清楚，别自欺：研究进程和做 setup 的人同 uid，能读同一个 `~/.ssh`，所以它**技术上能 ssh 到那台机器**。这套设计不声称挡得住这一条。它声称的是：私钥和 case 都不在研究这台机器上，远程 agent 只回答上面那两个请求。

### tester 自己选测什么，ARL 不许去搜同一个

研究侧给 tester 的只有一段领域/任务的**散文描述**，不带 benchmark 名。选哪个 benchmark、用什么
评测协议、case 怎么造，全由 tester 自己上网调研决定（论文、GitHub、dataset 站）。让研究侧指定测法
等于让被考的人出卷子，所以这件事必须在远端做，手册在 `templates/tester-agent-bundle/TESTER_AGENT.md`。

但这样就开了一个新洞：**tester 用的是公开 benchmark，那个仓库和那篇论文还在网上挂着**。ARL 根本
不需要碰 tester 那台机器，搜同一个名字、读同一个附录就够了。私钥不出远端挡不住这条，case 不出
远端也挡不住——泄漏源不是 tester，是公共互联网。

所以契约里多一个跟着一起签名的字段 `search_exclusions`：tester **真正用到**的 benchmark 名、
dataset 名、URL、host+路径前缀。研究侧拿它做两件事：

- `search-audit-cli.js emit-policy` 把它编译成 `<project>/.aris/search-policy.json`；
- `install-guard` 把一个 PreToolUse hook 并进 `<project>/.claude/settings.json`。

hook 判所有**网络形状**的调用：`WebSearch`、`WebFetch`、命令里带网络动词（`curl`/`wget`/
`git clone`/`pip install`/ARIS 自己那几个 paper fetcher）的 Bash、以及名字看着像检索的 MCP 工具。
命中屏蔽表的**硬拦**（exit 2），不命中的放行，两种都追加进哈希链账本
`<project>/.aris/search-audit.jsonl`。判定逻辑是 `search-policy.ts` 里的纯函数
`decideNetworkCall`，hook 本身只是 stdin/stdout 外壳，所以这套东西不需要真的开一个 Claude 会话
就能测。

几条不显然的设计：

- **策略文件缺失 = 全拦**，并记一条 `policy_missing`。否则 `rm .aris/search-policy.json` 就是
  一条免费通道。
- **账本首行必须是 `install-guard` 写的 genesis**。没有它就分不清"这轮没搜过网"和"拦截器从没装
  过"，所以 `submit` 直接拒。
- **屏蔽表从不打印**。skill、提示词、报告都不复述它；模型唯一看到某一条的时机，是它自己已经打出
  那个词然后被拦下——那时候它知道的东西没有增加。
- **屏蔽表是双向对抗的**。tester 如果拿 `benchmark`、`reasoning` 这种通用词凑数，ARL 的正常文献
  调研就被整个掐死了，那不是 tester 的权限。所以契约校验会拒通用词和"不带路径的通用大站"
  （`TESTER_EXCLUSIONS_OVERBROAD`）。

`submit` 发出去之前查账本，三种拒绝各指一件不同的事：`SEARCH_AUDIT_MISSING`（拦截器没装过）、
`SEARCH_AUDIT_BROKEN`（链断或 seq 跳号，写过的历史被改过）、`SEARCH_POLICY_MISMATCH`（这轮
守的不是当前这份契约）。**被拦的次数本身不作废本轮**，只打印出来给人看。

### 这套闸门挡不住什么

照直写，一条都不含糊：

- **它是关键词/域名匹配，不是沙箱。** 换个说法、用同义词、拼错一个字母都能绕过去。它挡的是最省事
  也最可能发生的那条路——把 benchmark 名字打进搜索框。
- **benchmark 大概率已经在模型权重里。** 拦住搜索不等于让模型忘掉 HumanEval。
- **屏蔽表就落在 ARL 这台机器上，同 uid 读得到。**"不给模型看"靠的是没有任何提示词打印它，不是
  靠权限。补偿是：命令里出现策略文件路径会被记成一条带标记的 `policy_read`。
- **账本和 ARL 同 uid，tester 不连带签名。** 哈希链只让**篡改已写入的历史**留下断点；从零伪造一份
  干净账本，本机没有任何办法识别。这是敞口，见 §10。

### 三条使用纪律

- tester 回执**不是证据**——不能给 `analyze-results` 用，不能进 Stage 3 的 review，不能当研究主张的依据。
- 没有"缺陷清单"字段。tester 说得最细的就是上面那三个词表，不要在任何地方描述成有更细的输入可用。
- 引用它时写成"tester 报告了什么"，不是"我发现了什么"。

### 这些东西谁来配

上面这套——远端 tester、搜索闸门、七项 root setup——以前**没有入口**。实验环境那层有两个入口
（人走 `/research-setup`，机器走 `auto-research-loop` 第 0b 步和 `experiment-bridge`），但
`tester-setup` 在自己目录之外没有任何地方引用，`research-setup` 全文
也不提 tester 和 charter。结果是人配完项目跑 `/auto-research-loop`，撞到一句"charter 缺失"，
没有东西告诉他接下来该跑什么。

现在入口是 `/aris-setup`，它只负责三件事：顺序、让人确认推断值、以及每个阶段没配好时指到哪。
判定和装配在 `project-setup-cli.js`：`status` 报六个阶段（项目基础、指标目标、实验环境、
tester、搜索闸门、root charter），没配全就退非零；`infer` 从已有文件里能读出来的读出来、**每个
值带着它的来源**，读不出来的进 `needs_owner` 让人答；`assemble` 把答案和推断合成 root-setup
的输入。

两条设计上不显然的：

- **`assemble` 不封存。** 写 setup 记录的仍然只有 `workflow-tools-cli.js root-setup`。第二条进
  `setupRootRun` 的路等于第二份它的校验实现。
- **推不出来的绝不编。** env.json 里没有加速卡型号、显存、配额、墙钟上限和出网白名单，这五样
  只能问人。编一个进冻结清单，后面 `classifyResourceRequest` 就会把"方案要了清单外的硬件"
  （研究上的负结果）判成别的东西，而且本机查不出来。

`status` 对搜索闸门只报条数和摘要，一个屏蔽词都不打印，和 §7 前面那条纪律是同一条。

---

## 8. 最优版本怎么选出来

递归保留，但**最优版本不由任何一轮自己宣称**。每个 auto-review-loop workspace 的 Research Wiki 上有一个**导出阶段**（`result-export`），跨轮挑选全局最优的 result-package。

排名判据两级：

1. **主判据：tester 指标**（多个必要指标，不是单个）。一个版本胜出，必须没有别的版本在 tester 证据上全面不劣于它。
2. **破平局：metric-gate 的值**。它只在 tester 证据分不出高下时起作用，不能盖过 tester 的判断。

理由很直接：单个 loop 内部看不到别的 loop 的结果，没法判断"所有轮里哪个最好"。把这个判断挪到导出阶段，它才有全部数据。

排名用的是 Pareto 分层剥离，不是把支配关系当比较器丢给排序函数——支配关系不是全序，当比较器用会得到无意义的顺序。

---

## 9. 磁盘布局

```
.aris/runs/                        所有深度平铺，不按树嵌套
  <run-id>/
    run.json                       含 workspace_id / workspace_root
    charter.json                   父给的
    result-package.json            交给父的
    children.json                  位置索引
    child-acceptance.json          父给每个子的验收标准
    decomposition/generation-N.json  这一代的分解图（只有编排 run 有）
    decomposition/wave-N.json        改图的那次冻结提案
    dashboard.json
    frozen-policy.json             只有根封存完整 policy
    cycles/<iteration>/*
```

平铺是有意的：run 的树结构靠 `parent_run_id` 表达，不靠目录嵌套。目录嵌套会让"读某个 run"依赖于知道它在第几层，而那恰好是子 run 不该知道的东西。

工作区**不在 `.aris` 下**，由 `mcp__paseo__create_workspace` 单独创建。

---

## 10. 已知缺口

**搜索账本是本机自证的。** 账本和研究进程同 uid，tester 也不连带签名（这是个明确的取舍：连带签名
要求每次提交都带上账本摘要，把一个本机审计问题变成跨机协议问题）。哈希链能发现"写完之后又改"，
发现不了"从头就是伪造的"。要关掉这条，唯一的办法是让账本摘要进提交体并由 tester 连带签名，本轮
没做。

除此之外没有已知的架构级缺口。上一版列出的三条都已关闭：轮数上限只剩 metric-gate 里的可选兜底（§4），`standalone-adapter.ts` 和 `evidence-review` skill 整个删除，`WIKI_MODULE_WORKERS` 只剩四段流程加 `idea-creator`；tester 回执入 Wiki 的路径不再依赖 root 属主，验签靠配置里钉死的公钥摘要（§7）。
