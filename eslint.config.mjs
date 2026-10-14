import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      "storage/**",
      "prototype/**",
      "python/**",
      "Implementations/**",
      "Research References/**",
      "handover files/**",
      "docs/**",
      "drizzle/**",
      ".claude/**",
    ],
  },
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // ~480 existing uses, mostly at JSON/model-output boundaries and test fixtures.
      // Off until they can be typed incrementally.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // New in eslint-config-next 16 (React Compiler rules). Flags the existing load-on-mount
    // effects; a warning until those pages move to a data-loading pattern.
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    rules: { "react-hooks/set-state-in-effect": "warn" },
  },
  {
    // CommonJS scripts and node:test files use require() deliberately.
    files: ["**/*.cjs", "tests/**"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
];

export default config;
