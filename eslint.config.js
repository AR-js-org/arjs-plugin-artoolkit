import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "types/",
      "coverage/",
      "node_modules/",
      "examples/**/vendor/**",
      "**/*.map",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.worker,
        ...globals.node,
        // Injected by vite.config.ts `define`.
        __ARTOOLKIT_PLUGIN_VERSION__: "readonly",
      },
    },
  },
  {
    files: ["tests/**/*.ts", "*.ts"],
    extends: [tseslint.configs.recommended],
    rules: {
      // Tests drive private members and hand-built payloads.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
    },
  },
  prettier,
);
