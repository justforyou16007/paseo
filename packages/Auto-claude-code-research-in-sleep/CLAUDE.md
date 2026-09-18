# CLAUDE.md

ARIS（Auto Research In Sleep）。这个文件记录在这个包里工作时的固定流程，不重复 `AGENT_GUIDE.md` 和 `CONTRIBUTING_CN.md` 已经写过的东西。

## 任务派发循环

我负责派发和审查，codex 子 agent 负责实现。循环是固定的四步，不要跳步：

1. **派发。** 把一批相关需求打包成一次 dispatch，不要拆成多次小派发——分批派发是返工的主要来源。子 agent 用 `provider: "codex/gpt-6-astra"`，`settings: { modeId: "full-access", thinkingOptionId: "low" }`，创建时就给 full-access，不要先建成 auto 再切，也不要留着审批弹窗等人点。
2. **等待。** 发完 `send_agent_prompt` 就守着，直到拿到完成报告、问题或错误，中途不要转去做别的事。子 agent 只有两种值得关心的状态变化——抛出需要授权的问题，或者挂掉——两种都要立刻反应，挂着没人答等于工作停摆。
3. **判断死活要看 `activeTurn` 和 `updatedAt`，不要只看 `lastError`。** 快照里的 `lastError` 可能是上一轮留下的陈旧记录，agent 此刻完全可能正常在跑。只凭 `lastError` 下结论会得出反向判断。
4. **配额耗尽就设定时器。** 报错文本里带重置时间（`try again at <时间>`）。按**重置时间 +5 分钟**建一个一次性 `CronCreate`（`recurring: false`），prompt 里写清楚醒来后要做什么：给**同一个 agent id** 发恢复指令（它保留着自己的会话，不要新建），带上它挂起的问题的答复、当前半成品清单（让它自查接着做，不要从头重来）、以及原简报的纪律。醒来后回到第 2 步继续守。

注意 `CronCreate` 建的任务是 session-only 的，会话退出就没了。

**一个任务一个 agent，但同一个任务的返工回到同一个 agent。** 新的、不同的任务才开新 agent。

## 审查纪律

- 子 agent 的报告不要照单全收。先核对它声称改过的地方是不是真在文件里，再核对它声称绿的测试。
- 它提出的跨块授权请求要看清楚是不是在扩大范围。如果那处改动和已授权任务是同一个缺陷的另一个实例，就属于原范围内的补漏，可以批；如果是新需求，退回。
- `npm run typecheck` 通过**不代表测试是绿的**：`tsconfig.json` 只 include `src/**/*`，测试文件从不进类型检查。
