import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { apiShim } from './tests/shim-plugin';

// Test-only Vite config: identical to vite.config.ts but mounts the offline
// /api shim so the /setup wizard can be driven end-to-end with zero external
// effect. Never used for production builds.
export default defineConfig({
  plugins: [react(), tailwindcss(), apiShim()],
  // O harness exercita o caminho de bootstrap ZERO-ENV: o app deve começar
  // "não configurado" e mostrar o wizard /setup. Um `.env.local` de dev (com
  // VITE_SUPABASE_URL/ANON_KEY para testar telas pós-login contra um Supabase
  // real) faria getSupabaseCredentials() retornar credenciais de env →
  // configured=true → /setup redireciona p/ login → toda a suíte do wizard
  // falha. Forçamos essas vars vazias SÓ na config de teste para isolar o
  // harness de qualquer .env.local presente. A config de produção/dev real
  // (vite.config.ts) não é afetada.
  define: {
    'import.meta.env.VITE_SUPABASE_URL': '""',
    'import.meta.env.VITE_SUPABASE_ANON_KEY': '""',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 4317,
    strictPort: true,
    watch: {
      // Playwright grava traces/screenshots em tests/.artifacts durante a
      // execução; sem o ignore, cada arquivo dispara um full-reload no meio
      // dos testes (e o acúmulo derruba o dev server na suíte completa).
      ignored: ['**/tests/.artifacts/**', '**/test-results/**'],
    },
  },
});
