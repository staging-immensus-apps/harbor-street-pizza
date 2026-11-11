---
description: "Launch an area agent on a task — usage: /dispatch <back-end|front-end> <task>"
argument-hint: <area> <task, ideally "Fix #N: ...">
---
Parse $ARGUMENTS: the first word is the area (one of: back-end, front-end), the rest is
the task. Launch that area's agent (Agent tool, subagent type = area name) with the
task, prefixed by: "Follow your charter in .claude/agents/ and CLAUDE.md exactly:
claim the issue before any code, work in a fresh worktree, draft PR first, add the
hermetic suite that pins what you change, and stop-and-report on anything needing the
human's accounts, credentials, spend, or a product judgment call." If the area is
missing or invalid, list the valid areas and ask. When the agent finishes, relay its
report and state whether it merged, stopped blocked, or needs the human — plus any
cleanup still owed (labels, worktree).
