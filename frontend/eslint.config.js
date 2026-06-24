import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // ── React 19 strict-mode rules ────────────────────────────────────────
      // These three rules were added in eslint-plugin-react-hooks v7 and are
      // very strict — they flag legitimate patterns like syncing a form field
      // to incoming server data, mutating a ref to track the "current path"
      // for use inside an async callback, etc. The patterns they flag are
      // NOT bugs; they're style preferences. Disable them so the lint baseline
      // reflects real issues (unused vars, any-typed catches, etc.) rather
      // than stylistic disagreements with React 19's new guidance.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',

      // Allow unused function arguments prefixed with _ (common convention
      // for "I know this arg exists but I don't need it" — e.g. catch (err: unknown)
      // where err is unused).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Downgrade `any` from error → warning. The codebase has ~24 intentional
      // uses in axios catch blocks (err.response.data.error pattern). Forcing
      // a custom interface cast at each site adds boilerplate without real
      // type safety (the runtime shape is already what we expect). Keep as
      // a warning so it's visible for future cleanup, but don't fail lint.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // DataActionsMenu co-exports two builder helpers (buildDataActions,
    // buildFileActions) alongside the DataActionsMenu component. They share
    // the DataActionItem type and are conceptually paired with the menu.
    // Splitting them into a separate file would just create import churn for
    // every consumer. Allow non-component exports in this one file.
    files: ['**/components/device/DataActionsMenu.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
