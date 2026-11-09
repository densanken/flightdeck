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
        project: [
          "./apps/*/tsconfig.json",
          "./apps/*/tsconfig.scripts.json",
          "./packages/*/tsconfig.json",
          "./tsconfig.eslint.json",
        ],
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
              target: "./apps/{takeoff,preflight,dispatch}/src/handler/**/!(*.test).ts",
              from: [
                "./apps/{takeoff,preflight,dispatch}/src/composition/**/*",
                "./apps/{takeoff,preflight,dispatch}/src/infrastructure/**/*",
              ],
              message: "Handlers must receive outer-layer implementations from the composition root.",
            },
            {
              target: "./apps/{takeoff,preflight,dispatch}/src/handler/**/!(*.test).ts",
              from: "./apps/{takeoff,preflight,dispatch}/src/usecase/**/impl.{ts,js}",
              message: "Handlers may depend on use case interfaces, but not use case implementations.",
            },
            {
              target: "./apps/{takeoff,preflight,dispatch}/src/domain/**/*",
              from: [
                "./apps/{takeoff,preflight,dispatch}/src/{app,config,env,main}.ts",
                "./apps/{takeoff,preflight,dispatch}/src/{composition,handler,infrastructure,message,repository,usecase}/**/*",
              ],
              message: "Domain modules must not depend on outer application layers.",
            },
            {
              target: "./apps/{takeoff,preflight,dispatch}/src/{infrastructure,repository}/**/*",
              from: [
                "./apps/{takeoff,preflight,dispatch}/src/{app,main}.ts",
                "./apps/{takeoff,preflight,dispatch}/src/{composition,handler}/**/*",
                "./apps/{takeoff,preflight,dispatch}/src/usecase/**/impl.{ts,js}",
              ],
              message: "Adapters must not depend on delivery, composition, entry points, or use case implementations.",
            },
            {
              target: "./apps/{takeoff,preflight,dispatch}/src/handler/**/!(*.test).ts",
              from: "./apps/{takeoff,preflight,dispatch}/src/repository/**/*",
              except: [`${import.meta.dirname}/apps/{takeoff,preflight,dispatch}/src/repository/**/interface.{ts,js}`],
              message: "Handlers may depend on repository ports, but not repository implementations.",
            },
            {
              target: "./apps/{takeoff,preflight,dispatch}/src/repository/**/*",
              from: "./apps/{takeoff,preflight,dispatch}/src/usecase/**/*",
              message: "Repository modules must not depend on use cases.",
            },
            {
              target: "./apps/{takeoff,preflight,dispatch}/src/usecase/**/*",
              from: [
                "./apps/{takeoff,preflight,dispatch}/src/{app,config,env,main}.ts",
                "./apps/{takeoff,preflight,dispatch}/src/{composition,handler,infrastructure}/**/*",
              ],
              message: "Use cases must depend on application ports and values, not outer-layer implementations.",
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
              from: ["./apps/takeoff", "./apps/dispatch"],
              message: "Applications must not import other application implementation modules.",
            },
            {
              target: "./apps/takeoff",
              from: ["./apps/preflight", "./apps/dispatch"],
              message: "Applications must not import other application implementation modules.",
            },
            {
              target: "./apps/dispatch",
              from: ["./apps/preflight", "./apps/takeoff"],
              message: "Applications must not import other application implementation modules.",
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
    files: ["apps/{takeoff,preflight,dispatch}/src/usecase/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
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
    files: ["apps/{takeoff,preflight,dispatch}/src/util/**/*.ts"],
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
