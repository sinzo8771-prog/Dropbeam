import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist", "node_modules", "coverage", "playwright-report", "test-results", "*.min.js"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker },
    },
    rules: {
      // PRD NFR-7: no `any` without a comment justifying it (inline disable).
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "localStorage",
          message:
            "Only theme/language/auto-accept defaults may be persisted (FR-40). Import src/core/platform/storage.ts instead.",
        },
      ],
    },
  },
  {
    files: ["tests/**/*.ts", "scripts/**/*.{mjs,js}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-restricted-globals": "off",
    },
  },
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-globals": "error",
    },
  },
);
