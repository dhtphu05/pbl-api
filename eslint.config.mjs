import eslint from '@eslint/js';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import tsEslint from 'typescript-eslint';

const SERVICES = [
  'platform',
  'catalog',
  'inventory',
  'sales',
  'customer',
  'finance',
  'integration',
  'insight',
];

const serviceIsolationConfigs = SERVICES.map((service) => {
  const otherServices = SERVICES.filter((s) => s !== service);
  const restrictedPatterns = [
    ...otherServices.flatMap((other) => [
      `apps/${other}`,
      `apps/${other}/**`,
      `**/apps/${other}/**`,
    ]),
    ...(service !== 'platform' ? ['@/*'] : []),
  ];

  return {
    files: [`apps/${service}/**/*.ts`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: restrictedPatterns,
              message: `Service "${service}" must not import directly from another service's app directory or platform aliases (ADR-0001, ADR-0006). Share contracts via @pbl/* libraries.`,
            },
          ],
        },
      ],
    },
  };
});

export default tsEslint.config(
  {
    ignores: [
      'eslint.config.mjs',
      'dist/**',
      'libs/*/dist/**',
      'docs/.vuepress/**/*',
      'src/generated/i18n.generated.ts',
    ],
  },
  eslint.configs.recommended,
  ...tsEslint.configs.recommended,
  prettierRecommended,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
        sourceType: 'module',
      },
    },
    rules: {
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  ...serviceIsolationConfigs,
  {
    files: ['libs/*/src/**/*.ts', 'libs/*/test/**/*.ts'],
    ignores: ['libs/events/test/m8-*.int-spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['apps/*', 'apps/**', '**/apps/**', '@/*'],
              message:
                'Shared libraries under libs/ must never import from apps/ (ADR-0006).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['libs/common/src/**/*.ts'],
    ignores: ['libs/common/src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@pbl/auth',
              message:
                '@pbl/common is the lowest layer and must not import @pbl/auth at runtime.',
            },
            {
              name: '@sapoclone/pbl-auth',
              message:
                '@pbl/common is the lowest layer and must not import @sapoclone/pbl-auth at runtime.',
            },
          ],
          patterns: [
            {
              group: ['apps/*', 'apps/**', '**/apps/**', '@/*'],
              message:
                'Shared libraries under libs/ must never import from apps/ (ADR-0006).',
            },
          ],
        },
      ],
    },
  },
);
