# Open-Source Provenance Document

This document records the provenance of open-source components and algorithms adapted or studied during the transition to the local agent harness in Research OS.

## 1. Upstream Project Information

- **Project Name**: OpenCode CLI
- **Repository URL**: https://github.com/anomalyco/opencode
- **License**: MIT License
- **Version/Commit Studied**: tag `v1.17.13`, commit `10c894bdeef3618f5666fb506ef7f9491bb964d8`

## 2. Adapted Algorithms and Concepts

The following algorithms and protocols were studied from the OpenCode CLI/SDK:
- **JSON Object Scanning/Extraction**: The depth-counting JSON parser used in `src/lib/agent-harness/output-parser.ts` is an independent implementation of the scanning method from the OpenCode runtime.
- **Model Routing**: The registry format and key aliases were transitioned from `src/lib/opencode/agent-registry.ts` to `src/lib/agent-harness/registry.ts`.

## 3. Implementation Status

All files in `src/lib/agent-harness/` are independent Research OS implementations targeting generic OpenAI-compatible streaming protocols. OpenCode's provider-neutral event-loop, cancellation, and routing concepts were studied; no OpenCode source file was copied into this repository.

## 4. Attribution and Notices

OpenCode is distributed under the MIT License, Copyright (c) 2025 opencode. Because no upstream source file was copied, this document records design provenance; if source is copied later, its copyright and MIT notice must accompany the adapted file.
