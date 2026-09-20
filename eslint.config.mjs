import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import pluginImport from "eslint-plugin-import";
import tseslint from "typescript-eslint";

/** @type {import("eslint").Linter.Config[]} */
export default [
  {
    ignores: ["**/node_modules", "**/dist", "**/dist-scripts", "**/coverage", "**/.wrangler/**", "eslint.config.mjs"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ["./apps/*/tsconfig.json", "./apps/*/tsconfig.scripts.json", "./packages/*/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    plugins: pluginImport.flatConfigs.recommended.plugins,
    rules: {
      ...pluginImport.flatConfigs.recommended.rules,
      ...pluginImport.flatConfigs.typescript.rules,
      "import/consistent-type-specifier-style": "error",
      "import/newline-after-import": "error",
      "import/no-cycle": "error",
      "import/no-duplicates": "error",
      "import/no-restricted-paths": [
        "error",
        {
          basePath: import.meta.dirname,
          zones: [
            {
              target: "./apps/{takeoff,preflight}/src/handler/**/!(*.test).ts",
              from: [
                "./apps/{takeoff,preflight}/src/composition/**/*",
                "./apps/{takeoff,preflight}/src/infrastructure/**/*",
              ],
              message: "Handlers must receive outer-layer implementations from the composition root.",
            },
            {
              target: "./apps/{takeoff,preflight}/src/handler/**/!(*.test).ts",
              from: "./apps/{takeoff,preflight}/src/repository/**/*",
              except: [`${import.meta.dirname}/apps/{takeoff,preflight}/src/repository/**/interface.{ts,js}`],
              message: "Handlers may depend on repository ports, but not repository implementations.",
            },
            {
              target: "./apps/{takeoff,preflight}/src/repository/**/*",
              from: "./apps/{takeoff,preflight}/src/usecase/**/*",
              message: "Repository modules must not depend on use cases.",
            },
            {
              target: [
                "./apps/preflight/src/!(*.test).{ts,js}",
                "./apps/preflight/src/!(test-helper)/**/!(*.test).{ts,js}",
              ],
              from: "./apps/preflight/src/test-helper/**/*",
              message: "Production modules must not import test helpers.",
            },
            {
              target: "./apps/preflight",
              from: "./apps/takeoff",
              message: "Applications must not import takeoff implementation modules.",
            },
            {
              target: "./apps/takeoff",
              from: "./apps/preflight",
              message: "Applications must not import preflight implementation modules.",
            },
          ],
        },
      ],
      "import/no-unresolved": ["error", { ignore: ["^cloudflare:workers$"] }],
      "import/order": [
        "error",
        {
          alphabetize: { order: "asc" },
          groups: ["builtin", "external", "internal", ["parent", "sibling"], "object", "type", "index"],
          "newlines-between": "always",
          pathGroupsExcludedImportTypes: ["builtin"],
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: ["apps/*/tsconfig.json", "apps/*/tsconfig.scripts.json", "packages/*/tsconfig.json"],
          noWarnOnMultipleProjects: true,
        },
        node: true,
      },
    },
  },
  {
    files: ["apps/{takeoff,preflight}/src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../composition/**",
                "../handler/**",
                "../infrastructure/**",
                "../repository/**",
                "../usecase/**",
              ],
              message: "Domain modules must not depend on outer application layers.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/{takeoff,preflight}/src/usecase/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../config.js",
                "../../config.js",
                "../composition/**",
                "../../composition/**",
                "../handler/**",
                "../../handler/**",
                "../infrastructure/**",
                "../../infrastructure/**",
              ],
              message: "Use cases must depend on application ports and values, not outer-layer implementations.",
            },
            {
              group: ["../*/impl.js"],
              message: "Use cases must receive sibling use cases through interfaces or dependency factories.",
            },
            {
              group: ["../**/repository/**/impl.js", "../**/repository/**/impl.ts"],
              message: "Use cases may depend on repository ports, but not repository implementations.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/{takeoff,preflight}/src/{infrastructure,repository}/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../composition/**", "../../handler/**"],
              message: "Adapters must not depend on delivery or composition layers.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/{takeoff,preflight}/src/util/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../composition/**",
                "../domain/**",
                "../handler/**",
                "../infrastructure/**",
                "../repository/**",
                "../usecase/**",
              ],
              message: "Utility modules must remain independent from application and adapter layers.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/pr-title/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../../apps/**"],
              message: "The shared title policy must not depend on either application.",
            },
          ],
        },
      ],
    },
  },
  prettier,
];
