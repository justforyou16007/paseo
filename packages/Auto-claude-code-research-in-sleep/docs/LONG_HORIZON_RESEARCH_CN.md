# ARIS 长周期递归研究：流程与契约

这份文档用来对齐**目标能力是否已经实现**。它只写两类东西：系统应该做到什么，以及代码里靠什么机制做到。实现细节（函数签名、字段全集、错误码清单）不在这里，看代码。

写作原则：**以代码实际行为为准**。凡是文档和代码冲突的，代码是对的，文档是过期的。

---

## 1. 目标能力与落地状态

| # | 目标能力 | 靠什么机制成立 | 状态 |
|---|---|---|---|
| 1 | 研究可递归派子，层数由根冻结的 `max_depth` 封顶 | run 三字段（`parent_run_id` / `depth` / `scope_path`）+ frozen policy 的 `max_depth` | 已实现 |
| 2 | 子 run 不知道自己是谁的子、在第几层 | charter 的字段集合里没有这类信息，子 run 只收到任务 | 已实现 |
| 3 | 父子之间只有两个文件，任何深度形状一样 | `charter.json` 下行、`result-package.json` 上行 | 已实现 |
| 4 | 跑不起来和跑出来不好，是两条不同的修正路径 | `bridge_repair` vs. 参数修正 | 已实现 |
| 5 | 只有"换想法"算一次迭代，调参重跑不算 | metric-gate 按 iteration 索引，同号只留最后一条 | 已实现 |
| 6 | 所有会影响后续判断的落盘都要有独立 verifier | 每个前提文件在写入点解析它的 verifier 回执，回执字段从核实结果取 | 已实现 |
| 7 | 知识在 run 之间以事件流积累，不是共享可变状态 | Research Wiki 事件 + 投影 | 已实现 |
| 8 | 最优版本由导出阶段跨轮挑选，不是由某一轮自己宣称 | `result-export` 排名 | 已实现 |
| 9 | 正式指标先测试再审计 | tester设施部署benchmark，测试和审计保留完整证据 | 已实现 |
| 10 | Auto Research Loop 以必填轮数和指标目标停机 | root/child charter 启动 Workflow，评审收据进入 cycle summary，停机决定进入结果包 | 代码交接测试通过；现场 agent 派发仍需验证 |
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
- **auto-review-loop** 跑实验、读结果、调参、重跑，直到能给出本轮评审结论。它有参数诊断能力：结果不好时判断是想法不行还是参数没调对。
- **metric-gate** 判这一轮算不算有提升。

### 两条修正路径

这两条容易混，但触发条件、身份处理、对指标门的影响都不一样：

| | 跑不起来 | 跑起来了但结果不佳 |
|---|---|---|
| 触发 | `experiment-bridge` 返回失败回执或产物不可用 | `analyze-results` 判定是参数问题 |
| 路径 | `bridge_repair` | 参数修正（auto-review-loop 内部） |
| 身份 | 保持同一 candidate identity | 新的 trial identity |
| 指标门 | 不推进 | 推进 |
| 结束条件 | `repair_status` 为 `fixed` 或 `exhausted` | 得出本轮评审结论 |

**判定权归 `analyze-results`，不归修正者。** 让修正者自己判断"我这次算不算修好了"就是让它给自己打分。监督信号必须来自 `analyze-results`，不能来自 tester——tester 是最后的验收方，不参与过程指导。
桥接阶段的数值是暂存值，评审可判定后才进入 `metric.history`。`insufficient` 收据不发布有效指标；修复返回 `exhausted` 且没有可判定方案时，面板清除本轮暂存数值并记录 `no_proposal`；实验本身一直跑不通而耗尽修复时，run 以失败结束（见下文停机条件）。

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
- `depth` 记录"这个 run 在第几层"。旧工作流里它只是观测值；Auto Research Loop 用它和 frozen policy 里的 `max_depth` 比较，决定还能不能派子（见 §4）。
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
  mode/max_iterations               child_summaries
  measurement                       cost_actual
```

`result-package.json` 旁边配一份人读的 `result-summary.md`，正文不超过 500 字。
Auto Research Loop charter 不写 `budget`。旧工作流仍有预算字段和账本；结果包可记录实际成本，但它不控制 Auto Research Loop 派发或停机。

### status 四分类

| status | 含义 | 能进 validation | 计入"本轮无提升" | 占用 tester 名额 |
|---|---|---|---|---|
| `succeeded` | 跑完了，有结果 | 能 | 按结果计 | 按流程 |
| `failed` | 跑完了但结果不合格 | 能，作为有效负结果 | 计入 | 按流程 |
| `not_executable` | 方案无法在冻结资源内执行 | 不能 | 不计入 | 不占用 |
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

Auto Research Loop 的子 run 各自冻结 `max_iterations`，父 run 不向子 run 切分预算。

### 位置、任务和代

`children.json` 是父的位置索引：一个位置（`position_id`）记它这一代派给了哪个 run、任务哈希是多少、上一代同位置是谁。任务哈希只取父决定的那部分——问题、要求的产出、约束、依赖谁。于是"这一代和上一代是不是同一个任务"是可判定的事实，不靠谁声明：

- 任务没变：这一代照样开一个新 run，但它从上一代同位置那个 run 的 Wiki 继承知识。
- 任务变了：那是另一个问题，新 run 从空 Wiki 开始。让它带着上一个问题的结论开工，等于让它去接着证明一件已经不成立的事。

### 串行边

一个位置可以声明 `depends_on`。声明了就意味着：上游没发布 `result-package.json` 之前，下游连派都派不出去；派的时候它的输入快照不是基线，是上游的产出哈希。没声明就是并行。这条边只存在于父的分解图里，子不知道自己前面还有谁。

### 当优化对象就是这张分解图

有一种 run 要优化的不是某个实验，而是"这个问题该怎么拆"：拆成哪几个子 ARL、每个子问什么、哪些串行哪些并行。子是普通的 ARL，父子之间还是 charter 下行、`result-package.json` 上行，形状一点没变。变的是三件事。

**一、图先落盘，再派子。** 每一代的分解图单独写在 `decomposition/generation-N.json`，在第一个子被派出去之前就写好。派子时拿这次派的位置去跟这张图核对：可以只派其中一部分（串行图本来就得分几批派），但不能派图里没有的位置，也不能改图里写好的任务。反过来做——从"派了哪些子"倒推这一代的图——在串行图上是错的：第一批只有上游，那张图会被冻死在只有上游的形状上。

**二、第一代就是基线。** 创建即基线，不需要先证明自己比谁好。之后要改结构，得先有 tester 的反馈信号，用它开一个 wave：wave 冻结"从上一代的哪张图出发、做哪几个改动、得到哪张图"，落在 `decomposition/wave-N.json`，然后才能记录下一代。所以结构演进只发生在整张图跑完一轮之后——没跑过的结构没有可比的证据。

**三、整体的分数要等全代收完。** 一代里每个位置都有终态子（成功、失败、或者跑完了但没报出验收要的指标）之后，这一代才算收回来。回收本身不写任何文件：谁应该存在看分解图，谁承载它看 `children.json`，它交回了什么看子自己的 result-package——三份都已经各有唯一写入方，再落一份就是第四份会过期的事实。每个子用父给它的验收器打一次分；验收器的内容不会在子跑的过程中变，已发布的 result-package 也不会变，所以这个分重算多少次都是同一个答案，不必记下来。

全代收完之后，父才用自己的 validator 去测装配起来的整体，把这个数写成 `metric.current` 进指标门。收完之前这个键会被拒——半个结构测出来的数没有意义，而下一代要拿它当比较基准。

每一代完成后计入父 run 的轮数，达到 `max_iterations` 时停止派发新一代。

### 父子不同时改

父在重排结构、子在跑迭代，改的是同一件东西的两端。所以锁只有一条规则：结构锁排斥它底下的一切，也被底下任何一个持有者挡住。别的组合都不冲突——父在迭代、子也在迭代，本来就是派发的常态。持有者是不是还在，不看进程，看它的 result-package 发没发布：一次迭代是一长串互相独立的命令，进程活不活证明不了任何事。

---

## 4. 递归怎么停

**深度由 `max_depth` 封顶。** 子 run 继承与父相同的 `max_iterations`，自己还能再派子，所以轮数本身挡不住层数和总工作量的增长。根 setup 冻结 `max_depth`（默认 2，根是第 0 层）；它不写进子 charter，而是由子的 `start` 从父的 frozen policy 抄下来，子 charter 因此仍不含任何层数信息。`depth` 等于 `max_depth` 的 run 不能再派子，`bridge-expand` 以 `MAX_DEPTH_REACHED` 拒绝。

**修复次数按轮封顶。** 一轮里桥接失败和"证据不足"的评审共用一个修复计数，上限 `max_repair_attempts`（默认 3）。Workflow 由根 setup 冻结并沿 frozen policy 传给子；单过程写在 `dashboard.json` 的 `config` 里。计数用完后再来的失败直接记为 `exhausted`，不再派修复。单过程的修复记录带有所属轮次，进入下一轮后上一轮已修好的记录不再约束新候选的输入，也不占新一轮的次数。

Auto Research Loop 的每个 run 必须冻结正整数 `max_iterations`。有效指标达到目标时提前成功终止；否则在最大轮数结束时以 `iteration_cap` 停止。修复耗尽时分两种：评审一直判"证据不足"，以 `no_proposal` 停止并正常完成；实验本身一直执行失败，run 以 `failed` 结束。失败时两种模式都记下失败位置（哪个 worker、第几轮、哪个阶段、错误内容、修复次数和收据）：单过程写在 `dashboard.failure`，Workflow 写在该轮 cycle summary 的 `failure`，停机原因为 `bridge_failed`。单过程的指标门不读取预算账本，也不按连续无提升轮数停机。递归 Workflow 的 Auto Research Loop 模式用相同的判据；其他 Workflow 模式保留原有停机策略。

stop gate 数的是**想法轮数**。参数修正的重跑不产生新迭代号，同一迭代号只保留最后一条记录。这带来一条使用纪律：**一轮里调参多次时，最后提交的那次必须是最好的那次**，否则你把一个次优结果当成这轮的成绩交上去了。

恢复时从已保存的配置读取轮数上限；缺失或非法值是配置错误，不继续派发。
结果包把 Workflow 的 `target_reached` 映射为 `metric_met`，并保留 `iteration_cap` 或 `no_proposal`。失败的 run 也发布结果包，状态为 `failed`，`failure` 写明失败位置并引用桥接与修复收据，父 run 据此把它当作失败的子收回。

Workflow 的一轮必须等所有子 run 发布结果包后才能结束：`arl-cycle-complete` 以及修复耗尽后的 `cycle-complete` 在还有子没交结果时以 `ROUND_INCOMPLETE` 拒绝并列出这些子。Workflow 的读数来自 cycle summary 及其评审收据，`workflow-summary.json.stop_reason` 读取已落盘的停机决定。

---

## 5. 知识怎么积累：Research Wiki

Wiki 是**事件流 + 投影**，不是共享可变状态。写入是追加事件，读取是把事件投影成页面。两个 run 并发写不会互相覆盖，重放事件能重建任何时点的状态。

三种读写边界：

- **知识作用域**：Wiki保留正常run所有权和快照绑定，tester原始结果可用于分析。
- **signal 的 kind 不由调用方选**。它由结论唯一决定：`improved` → `observation`，`not_improved` → `failure`，其余 → `constraint`。调用方不能自己指定，否则一个想让自己好看的 worker 会把失败写成观察。
- **tester 值经完整测试和独立审计入库**。见 §7。

---

## 6. 怎么防止自欺

系统里所有的"防自欺"设计都落在同一条原则上：**判断的人不能是被判断的人**。

### 独立 verifier

凡是会改变后续研究判断所依据前提的写入，都要有一个独立 verifier 回执。回执不能是写入方自己填的两个字符串——那只是拼写规则，不是审查。所以核实发生在每个写入点，回执字段从核实结果拷贝，而不是从调用方入参拷贝：

| 前提文件 | 谁核实 | 核实什么 |
|---|---|---|
| `result-package.json` | `result-review.ts` 的 `requireApprovedResultReview` | 读回 reviewer 落盘的 verdict，要求它 `approved` 且 `package_sha256` 等于**正要写的这个包**的摘要 |
| `promotion-commit-intent.json` | `tester-promotion-result.ts` 的测试/审计绑定检查 | 当前完整结果和通过审计、产物摘要及promotion状态一致 |

result package 的摘要绑定是关键：包由输入确定性构造，reviewer 拿着候选能算出和写入方一样的摘要，所以"拿 A 包过审、发 B 包"会因为摘要不匹配被拒（`RESULT_REVIEW_SUBJECT_MISMATCH`）。流程因此是三步：`plan_result_package` 打印摘要 → reviewer `submit_result_review` → `export_result_package` 才写。verdict 一旦落盘不可变。

`review-submit.ts` 是另一套东西，别和上面混。它管的是**父对自己派出去的工作**的审查（validation 比对、scorer 修订、promotion 测试），每条路径都要求外层 run 把被审的 run 列为自己的 child。research run 对自己产出的包的审查不属于它：审查者在 run 内部，没有父参与，父也无权知道这个 run 存在（§2 的身份隔离）。

`state-file.ts` 本身不核实任何东西，也不该被当成 verifier 读：它只保留一条与主题无关的不变式——产出者不能是自己的接受者（`REVIEWER_NOT_INDEPENDENT`）。新增前提文件时先在写入点给它一个真 verifier，再谈 receipt。

### 三道闸，一道比一道贵

1. **metric-gate**：每轮都过，判这轮有没有提升。便宜、可以反复跑。
2. **validation gate**：baseline 必须先过硬约束，候选必须跑完整且过硬约束，独立 review 的 verdict 必须是 `approved`。全过之后本 wave 至多产生**一个** finalist（`unique_validation_finalist`）。
3. **promotion gate + tester**：冻结对照和候选身份，用完整测试证据进行paired统计，再独立审计。每个test id绑定唯一请求，重试沿用该请求；新的评测使用新的id，保留试验记录，不再有exposure预算或一次wave只能查询一次的限制。

## 7. tester设施与评测流程

`/aris-setup`在实验环境准备好后调用`/tester-setup`。Setup确定benchmark版本、数据revision/split、样本数、指标及聚合口径、执行位置和产物接口，运行安装、健康检查与smoke测试，成功后记录ready状态和配置/依赖证据摘要。五个setup阶段为项目基础、指标目标、实验环境、tester设施、root charter。

后续评测复用设施：`/tester-test`执行完整benchmark，保留样本结果、日志、配置、产物摘要和持久任务状态；`/tester-audit`独立核查协议、评分、覆盖率和可比性。`result-to-claim`提交正式Wiki指标之前必须提供这两步的当前结果和通过审计。Wiki事件写入和结果导出均验证绑定及证据摘要，防止混用迭代或改动后继续采用旧审计。

执行可使用同账户本地环境或SSH资源；安装和测试均由可配置命令完成，可安装真实benchmark及其依赖、部署模型服务。Docker可作为项目自行选定的执行工具，不再是tester边界要求。根run和子run复用同一设施，分别绑定自己的评测请求。

旧的独立用户/容器、tester镜像构建、私有结果通道、公钥签名、网络搜索屏蔽、搜索审计账本和exposure限额已删除。Setup迁移会移除旧search guard及搜索策略文件，保留其他项目hook。原始测试证据允许研究分析和审计读取。正常run所有权、知识快照、预算和独立审查仍按ARIS协议执行。

设施配置在`.aris/tester-config.json`，setup回执在相邻`.setup.json`；每次测试在`.aris/tester/tests/<test_id>/`，含`job.json`、`benchmark-output.json`、`test-result.json`、`test-audit.json`及日志。配置变更后重新setup；已完成test id不能绑定新请求。

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
    workflow-dashboard.json         递归 Workflow 的状态视图
    workflow-runtime.json           递归 Workflow 的阶段和轮次
    frozen-policy.json              根和子各自封存；子继承父的模型、资源和指标约束
    cycles/<iteration>/workers/*    每轮 worker 清单与收据
```

平铺是有意的：run 的树结构靠 `parent_run_id` 表达，不靠目录嵌套。目录嵌套会让"读某个 run"依赖于知道它在第几层，而那恰好是子 run 不该知道的东西。

工作区**不在 `.aris` 下**，由 `mcp__paseo__create_workspace` 单独创建。

---

## 10. 验证范围

设施和门禁回归使用小型可重复benchmark fixture验证。本地或SSH真实模型评测需要项目选择benchmark、数据和算力后执行`/aris-setup`；setup准备成功不代表完整评测或独立审计已经通过。
