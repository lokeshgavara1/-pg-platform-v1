import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// API base URL comes from VITE_API_BASE_URL; in development requests to /api go through this proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,
    proxy: { '/api': 'http://localhost:4000' },
  },
  preview: { port: 5175 },
  test: { environment: 'jsdom' },
});
