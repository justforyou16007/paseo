---
name: research-setup
description: 'Compatibility name for unified /aris-setup: show the complete modular configuration with options and recommendations, accept grouped edits, refresh, then confirm once before execution. Use for research setup or 初始化研究项目.'
allowed-tools: Read, Write, Bash(*), AskUserQuestion, mcp__paseo__list_models, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__get_agent_status, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission, mcp__paseo__archive_agent, mcp__paseo__create_heartbeat, mcp__paseo__delete_heartbeat
---

> **Dispatch watchdog (mandatory).** Every child dispatch follows
> `shared-references/paseo-subagent-dispatch.md` §"The dispatch watchdog":
> arm before waiting and disarm after collecting terminal receipts.

# research-setup compatibility entry

This name is an alias of [the unified ARIS setup procedure](../aris-setup/SKILL.md).
Read that definition and its [configuration guide](../shared-references/unified-setup.md),
then follow the same procedure in this session. Do not spawn another setup
agent or start a separate wizard or interview.

Show all modules and current sources, choice options and recommendations;
accept multiple edits together or a direct JSON draft edit; refresh the whole
sheet and report all gaps together. Finally obtain one explicit confirmation
of the complete latest configuration before execution. There is no follow-up
/research-setup, /tester-setup or /aris-setup conversation.

This includes environment configuration, reusable tester facilities and the root charter. Legacy quick/full arguments use the same review; legacy setup answers are read only for migration into the single draft/state.
