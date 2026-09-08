# OpenCode integration notes

Research OS uses a native Node/Postgres agent runtime modeled on OpenCode's runtime contracts. It calls configured inference endpoints directly.

This folder follows OpenCode project config conventions from the MIT-licensed upstream project:

```text
https://github.com/anomalyco/opencode
```

The full OpenCode runtime is not vendored into this repository. The local implementation keeps Research OS domain state, validation, task lifecycle, and artifacts in this app.

Project skills live under `.opencode/skills`. The shared runner loads `unslop` into every new research-agent session so generated prose follows the same writing rules across reports, reviews, and chat answers.
