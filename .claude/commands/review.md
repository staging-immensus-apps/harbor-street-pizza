---
description: "Review a pull request against CLAUDE.md §4 — usage: /review <PR#>"
argument-hint: <PR#>
---
Launch the `review` agent (Agent tool, subagent type `review`) with: "Review pull
request $ARGUMENTS per your charter. Read CLAUDE.md first, get the diff with
`gh pr diff`, rank findings most-severe first, and return them as your final message.
Do not post a comment and do not edit anything." If no PR number was given, review
the PR for the current branch (`gh pr view --json number`). Relay the findings back
verbatim; this is the same review agent-review.yml runs in CI, useful for a PR that
edits the workflow itself and therefore cannot be reviewed by the action.
