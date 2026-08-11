# Open-Source Provenance Document

This document records the provenance of open-source components and algorithms adapted or studied during the transition to the local agent harness in Research OS.

## 1. Upstream Project Information

- **Project Name**: OpenCode CLI
- **Repository URL**: https://github.com/anomalyco/opencode
- **License**: MIT License
- **Version/Commit Studied**: `dev` branch, commit `3a90639cb57619a21e59f544b3e8d23ffed56f48` (downloaded into `Temp Download` on 2026-08-11)

## 2. Adapted Algorithms and Concepts

The following algorithms and protocols were studied from the OpenCode CLI/SDK:
- **JSON Object Scanning/Extraction**: The depth-counting JSON parser used in `src/lib/agent-harness/output-parser.ts` is an independent implementation of the scanning method from the OpenCode runtime.
- **Model Routing**: The registry format and key aliases were transitioned from `src/lib/opencode/agent-registry.ts` to `src/lib/agent-harness/registry.ts`.
- **Runtime Contracts**: Canonical messages, provider event normalization, session/event projection, context compaction, typed tool settlement, permissions, skills, remote MCP, and bounded subagent patterns informed the replacement harness backend.

## 3. Implementation Status

All files in `src/lib/agent-harness/` are independent Research OS implementations for Node.js and Postgres. They preserve the existing research pipeline contracts and do not vendor OpenCode's Bun/Effect/SQLite runtime. No OpenCode source file was copied into this repository.

## 4. Attribution and Notices

OpenCode is distributed under the MIT License, Copyright (c) 2025 opencode. Because no upstream source file was copied, this document records design provenance; if source is copied later, its copyright and MIT notice must accompany the adapted file.
