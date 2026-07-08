# OpenCode Integration Notes

Research OS uses OpenCode as a local sidecar runtime through the official `@opencode-ai/sdk`.

This folder follows OpenCode project config conventions from the MIT-licensed upstream project:

```text
https://github.com/anomalyco/opencode
```

The full OpenCode runtime is not vendored into this repository. The local implementation keeps Research OS domain state, validation, task lifecycle, and artifacts in this app.
