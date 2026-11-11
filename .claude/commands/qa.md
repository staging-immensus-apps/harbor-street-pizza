---
description: "Verify shipped work on the live app — usage: /qa <PR#> | /qa last <N>"
argument-hint: <PR#> | last <N>
---
Launch the `qa` agent (Agent tool, subagent type `qa`) with: "Verify the following
per your charter: $ARGUMENTS. If no target was given, verify the most recently
merged PR. Establish acceptance criteria, confirm the merged sha is what the cluster
serves (GET /build), exercise it with functional probes, file one routed issue per
regression, deliver your verdict with the evidence tier of every claim."
Relay the verdict report back verbatim.
