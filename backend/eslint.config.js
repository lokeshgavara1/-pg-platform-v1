import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'storage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['tests/**', 'prisma/**', 'scripts/**', 'src/providers/sms.ts', 'src/lib/logger.ts'],
    rules: { 'no-console': 'off' },
  },
);
