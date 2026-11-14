import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import pluginImport from "eslint-plugin-import";
import tseslint from "typescript-eslint";

const usecaseImportPatterns = [
  {
    group: ["../*/impl.js"],
    message: "Use cases must receive sibling use cases through interfaces or dependency factories.",
  },
  {
    group: ["../**/repository/**/impl.js", "../**/repository/**/impl.ts"],
    message: "Use cases may depend on repository ports, but not repository implementations.",
  },
];

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
              target: "./apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/handler/**/!(*.test).ts",
              from: [
                "./apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/composition/**/*",
                "./apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/infrastructure/**/*",
              ],
              message: "Handlers must receive outer-layer implementations from the composition root.",
            },
            {
              target: "./apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/handler/**/!(*.test).ts",
              from: "./apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/usecase/**/impl.{ts,js}",
              message: "Handlers may depend on use case interfaces, but not use case implementations.",
            },
            {
              target: "./apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/domain/**/*",
              from: [
                "./apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/{app,config,env,main}.ts",
                "./apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/{composition,handler,infrastructure,message,repository,usecase}/**/*",
              ],
              message: "Domain modules must not depend on outer application layers.",
            },
            {
              target: "./apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/{infrastructure,repository}/**/*",
              from: [
                "./apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/{app,main}.ts",
                "./apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/{composition,handler}/**/*",
                "./apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/usecase/**/impl.{ts,js}",
              ],
              message: "Adapters must not depend on delivery, composition, entry points, or use case implementations.",
            },
            {
              target: "./apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/handler/**/!(*.test).ts",
              from: "./apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/repository/**/*",
              except: [
                `${import.meta.dirname}/apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/repository/**/interface.{ts,js}`,
              ],
              message: "Handlers may depend on repository ports, but not repository implementations.",
            },
            {
              target: "./apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/repository/**/*",
              from: "./apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/usecase/**/*",
              message: "Repository modules must not depend on use cases.",
            },
            {
              target: "./apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/usecase/**/*",
              from: [
                "./apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/{app,config,env,main}.ts",
                "./apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/{composition,handler,infrastructure}/**/*",
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
              from: ["./apps/takeoff", "./apps/dispatch", "./apps/clearance", "./apps/autopilot"],
              message: "Applications must not import other application implementation modules.",
            },
            {
              target: "./apps/takeoff",
              from: ["./apps/preflight", "./apps/dispatch", "./apps/clearance", "./apps/autopilot"],
              message: "Applications must not import other application implementation modules.",
            },
            {
              target: "./apps/dispatch",
              from: ["./apps/preflight", "./apps/takeoff", "./apps/clearance", "./apps/autopilot"],
              message: "Applications must not import other application implementation modules.",
            },
            {
              target: "./apps/clearance",
              from: ["./apps/preflight", "./apps/takeoff", "./apps/dispatch", "./apps/autopilot"],
              message: "Applications must not import other application implementation modules.",
            },
            {
              target: "./apps/autopilot",
              from: ["./apps/preflight", "./apps/takeoff", "./apps/dispatch", "./apps/clearance"],
              message: "Applications must not import other application implementation modules.",
            },
            {
              target: "./packages/github-policy",
              from: "./apps",
              message: "The shared GitHub policy client must not depend on applications.",
            },
            {
              target: "./packages/rules",
              from: "./apps",
              message: "The shared autopilot policy must not depend on applications.",
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
    files: ["apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/usecase/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: usecaseImportPatterns,
        },
      ],
    },
  },
  {
    files: ["apps/{clearance,autopilot}/src/usecase/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@flightdeck/github-policy",
              allowImportNames: ["decide", "PolicyGateway", "errorDetails", "ciStatus"],
              message: "Use cases may import only the policy decision, CI status, its port, and error details.",
            },
          ],
          patterns: [
            ...usecaseImportPatterns,
            {
              group: ["@flightdeck/github-policy/*", "**/packages/github-policy/**"],
              message: "Use cases must not import GitHub policy implementation modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/{clearance,autopilot}/src/{handler,domain}/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@flightdeck/github-policy", "@flightdeck/github-policy/*", "**/packages/github-policy/**"],
              message: "Handlers and domain must not depend on the GitHub policy package.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/{clearance,autopilot}/src/usecase/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportDeclaration[source.value='@flightdeck/github-policy'][specifiers.length=0]",
          message: "Use cases may import only the policy decision, CI status, its port, and error details.",
        },
        {
          selector: "ImportExpression[source.value=/github-policy/]",
          message: "Use cases must not dynamically import the GitHub policy package.",
        },
        {
          selector:
            "TSImportType[source.value='@flightdeck/github-policy']:not([qualifier.name='PolicyGateway']):not([qualifier.name='decide']):not([qualifier.name='errorDetails']):not([qualifier.name='ciStatus'])",
          message: "Use cases may import only the policy decision, CI status, its port, and error details.",
        },
        {
          selector: "TSImportType[source.value=/github-policy/]:not([source.value='@flightdeck/github-policy'])",
          message: "Use cases must not import GitHub policy implementation modules.",
        },
      ],
    },
  },
  {
    files: ["apps/{clearance,autopilot}/src/{handler,domain}/**/*.ts", "packages/rules/src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/github-policy/]",
          message: "This layer must not dynamically import the GitHub policy package.",
        },
        {
          selector: "TSImportType[source.value=/github-policy/]",
          message: "This layer must not depend on GitHub policy types.",
        },
      ],
    },
  },
  {
    files: ["apps/{takeoff,preflight,dispatch,clearance,autopilot}/src/util/**/*.ts"],
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
  {
    files: ["packages/{rules,github-policy}/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../../apps/**"],
              message: "The shared autopilot policy must not depend on applications.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/rules/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../../../apps/**",
                "@flightdeck/github-policy",
                "@flightdeck/github-policy/*",
                "**/github-policy/**",
              ],
              message: "The shared rules must not depend on applications or the GitHub policy package.",
            },
          ],
        },
      ],
    },
  },
  prettier,
];
