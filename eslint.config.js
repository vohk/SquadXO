import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const sourceFiles = [
  'index.js',
  'core/**/*.js',
  'squad-server/**/*.js',
  'scripts/**/*.{js,mjs}',
  'src/**/*.ts',
  'test/**/*.ts'
];

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', 'artifacts/**', 'dist/**', 'config*.json']
  },
  {
    ...eslint.configs.recommended,
    files: sourceFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node
    },
    rules: {
      ...eslint.configs.recommended.rules,
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_'
        }
      ]
    }
  },
  {
    files: ['index.js', 'core/**/*.js', 'squad-server/**/*.js', 'scripts/**/*.{js,mjs}'],
    rules: {
      // Legacy plugin callbacks intentionally retain framework-defined argument lists.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      // Preserve long-standing regular-expression semantics until each plugin is replaced or tested.
      'no-useless-escape': 'off'
    }
  },
  ...tseslint.configs.recommended.map((configuration) => ({
    ...configuration,
    files: ['src/**/*.ts', 'test/**/*.ts']
  })),
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_'
        }
      ]
    }
  },
  {
    files: [
      'src/compatibility/**/*.ts',
      'src/connectors/legacy-connector-manager.ts',
      'src/plugins/runtime.ts'
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  eslintConfigPrettier
);
