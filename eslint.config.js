import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Dependency boundaries from docs/03-architecture.md:
 *
 *   shared   <- nothing
 *   content  <- shared
 *   engine   <- shared, content
 *   server   <- shared, content, engine
 *   client   <- shared, content, engine
 */
const FORBIDDEN_IMPORTS = {
  shared: ['@bahoth/content', '@bahoth/engine', '@bahoth/server', '@bahoth/client'],
  content: ['@bahoth/engine', '@bahoth/server', '@bahoth/client'],
  engine: ['@bahoth/server', '@bahoth/client'],
  server: ['@bahoth/client'],
  client: ['@bahoth/server'],
};

const boundaryConfigs = Object.entries(FORBIDDEN_IMPORTS).map(([pkg, forbidden]) => ({
  files: [`packages/${pkg}/**/*.{ts,tsx}`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: forbidden.map((name) => ({
          group: [name, `${name}/*`],
          message: `packages/${pkg} may not import ${name}. See docs/03-architecture.md#dependency-rules.`,
        })),
      },
    ],
  },
}));

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/dist-types/**', '**/node_modules/**', '**/*.tsbuildinfo'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  ...boundaryConfigs,

  // The determinism guarantee (docs/05-engine.md#54-determinism-and-rng).
  // The engine must be a pure function of (state, action, content). If it can
  // read a clock or a global RNG, replay and crash recovery silently break.
  {
    files: ['packages/engine/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message: 'Engine must be deterministic. Pass time in via the action.',
        },
        { name: 'performance', message: 'Engine must be deterministic.' },
        {
          name: 'crypto',
          message: 'Engine must be deterministic. Use the in-state RNG.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Engine must be deterministic. Use the in-state RNG from rng.ts.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'Engine must be deterministic. Pass time in via the TICK action.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Engine must be deterministic. Pass time in via the TICK action.',
        },
        {
          selector: 'ImportDeclaration[source.value=/^node:/]',
          message:
            'Engine must not depend on Node built-ins. It runs in the browser too.',
        },
      ],
    },
  },

  // Tests may use whatever they like.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts'],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
