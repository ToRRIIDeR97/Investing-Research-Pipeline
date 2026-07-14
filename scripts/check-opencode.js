const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function checkCompatibility() {
  let sdkVersion = "1.17.13"; // fallback default
  try {
    const pkgPath = path.join(process.cwd(), "node_modules", "@opencode-ai/sdk", "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      sdkVersion = pkg.version;
    }
  } catch (err) {
    // Ignore and use default
  }

  let sidecarVersion = "";
  try {
    sidecarVersion = execSync("opencode --version", { encoding: "utf8" }).trim();
  } catch (err) {
    console.error(`\x1b[31mError: OpenCode compatibility check failed. Could not execute 'opencode --version'.\x1b[0m`);
    process.exit(1);
  }

  if (sdkVersion !== sidecarVersion) {
    console.error(`\x1b[31mError: OpenCode compatibility check failed!\x1b[0m`);
    console.error(`\x1b[31mSDK version is pinned to '${sdkVersion}' but the installed 'opencode' binary reports version '${sidecarVersion}'.\x1b[0m`);
    console.error(`\x1b[33mTo fix this, run 'opencode upgrade ${sdkVersion}' to align your CLI/sidecar with the application SDK.\x1b[0m`);
    process.exit(1);
  }

  console.log(`\x1b[32m✔ OpenCode compatibility check passed: SDK and sidecar are aligned on version ${sdkVersion}.\x1b[0m`);
}

checkCompatibility();
