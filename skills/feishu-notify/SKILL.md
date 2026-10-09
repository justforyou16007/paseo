---
name: feishu-notify
description: 'Send notifications to Feishu/Lark. Internal utility used by other skills, or manually via /feishu-notify. Use when user says "发飞书", "notify feishu", or other skills need to send status updates.'
argument-hint: [message-text]
allowed-tools: Bash(curl *), Bash(cat *), Read, Glob
---

# Feishu/Lark Notification

Send a notification: **$ARGUMENTS**

## Overview

This skill provides Feishu/Lark integration for ARIS. It is designed as an **internal utility** — the worker calls it at key events (experiment done, submission scored, owner decision needed). It can also be invoked manually.

**Zero-impact guarantee**: If no `feishu.json` config exists, this skill does nothing and returns silently. All existing workflows are completely unaffected.

## Configuration

The skill reads `~/.claude/feishu.json`. If this file does not exist, **all
Feishu functionality is disabled** and no notification is sent.

### Config Format

```json
{
  "mode": "push",
  "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/YOUR_WEBHOOK_ID",
  "interactive": {
    "bridge_url": "http://localhost:5000",
    "timeout_seconds": 300
  }
}
```

### Modes

| Mode            | `"mode"` value         | What it does                                                         | Requires                                                                      |
| --------------- | ---------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Off**         | `"off"` or file absent | Nothing. Pure CLI as-is                                              | Nothing                                                                       |
| **Push only**   | `"push"`               | Send webhook notifications at key events. Mobile push, no reply      | Feishu bot webhook URL                                                        |
| **Interactive** | `"interactive"`        | Full bidirectional. Approve/reject from Feishu, reply to checkpoints | [feishu-claude-code](https://github.com/joewongjc/feishu-claude-code) running |

## Workflow

### Step 1: Read Config

```bash
cat ~/.claude/feishu.json 2>/dev/null
```

- **File not found** → return silently, do nothing
- **`"mode": "off"`** → return silently, do nothing
- **`"mode": "push"`** → proceed to Step 2 (push)
- **`"mode": "interactive"`** → proceed to Step 3 (interactive)

### Step 2: Push Notification (webhook)

Send a rich card to the Feishu webhook:

```bash
curl -s -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "msg_type": "interactive",
    "card": {
      "header": {
        "title": {"tag": "plain_text", "content": "TITLE"},
        "template": "COLOR"
      },
      "elements": [
        {"tag": "markdown", "content": "BODY"}
      ]
    }
  }'
```

**Card templates by event type:**

| Event             | Title                         | Color                       | Body                              |
| ----------------- | ----------------------------- | --------------------------- | --------------------------------- |
| `experiment_done` | Experiment Complete           | `green`                     | Results table, delta vs baseline  |
| `submission_scored` | Submission N: <score>       | `blue` (scored) / `orange` (cheating, unusable) | Score, verdict, problem types, submissions left |
| `checkpoint`      | Checkpoint: Waiting for Input | `yellow`                    | Question, options, context        |
| `error`           | Error: [type]                 | `red`                       | Error message, what failed        |
| `task_closed`     | Task completed / closed       | `purple`                    | Best score, target, submissions used |
| `custom`          | Custom                        | `blue`                      | Free-form message from $ARGUMENTS |

**Return immediately after curl** — push mode never waits for a response.

### Step 3: Interactive Notification (bidirectional)

Interactive mode uses [feishu-claude-code](https://github.com/joewongjc/feishu-claude-code) as a bridge:

1. **Send message** to the bridge:

   ```bash
   curl -s -X POST "$BRIDGE_URL/send" \
     -H "Content-Type: application/json" \
     -d '{"type": "EVENT_TYPE", "title": "TITLE", "body": "BODY", "options": ["approve", "reject", "custom"]}'
   ```

2. **Wait for reply** (with timeout):

   ```bash
   curl -s "$BRIDGE_URL/poll?timeout=$TIMEOUT_SECONDS"
   ```

   Returns: `{"reply": "approve"}` or `{"reply": "reject"}` or `{"reply": "user typed message"}` or `{"timeout": true}`

3. **On timeout**: proceed with the default option.

4. **Return the user's reply** to the calling skill so it can act on it.

### Step 4: Verify Delivery

- **Push mode**: Check curl exit code. If non-zero, log warning but do NOT block the workflow.
- **Interactive mode**: If the bridge is unreachable, log the notification
  failure and continue the workflow. Do not switch to another notification
  mode.

## Helper Function (for other skills)

Other skills should use this pattern to send notifications:

```markdown
### Feishu Notification (if configured)

Check if `~/.claude/feishu.json` exists and mode is not "off":

- If **push** mode: send webhook notification with event summary
- If **interactive** mode: send notification and wait for user reply
- If **off** or file absent: skip entirely (no-op)
```

**This check is always guarded.** If the config file doesn't exist, the skill skips the notification block entirely — zero overhead, zero side effects.

## Event Catalog

| Sender | Event | When |
| --- | --- | --- |
| worker | `submission_scored` | `query` returns a verdict for a submission |
| worker | `task_closed` | `query` reports `completed` or `closed` |
| worker | `experiment_done` | `collect-outputs.sh` of `run-<project>-experiment` wrote a receipt |
| worker | `checkpoint` | A step needs the owner (a captcha, an expired login, a missing credential) |
| worker | `error` | Work stopped on an error it cannot fix |

## Key Rules

- **NEVER block a workflow** because Feishu is unreachable. Always fail open.
- **NEVER require Feishu config** — all skills must work without it.
- **Config file absent = mode off.** No error, no warning, no log.
- **Push mode is fire-and-forget.** Send curl, check exit code, move on.
- **Interactive timeout = default option.** Don't hang waiting for a reply.
- **No secrets in notifications.** Never include API keys, tokens, or passwords in Feishu messages.
