import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the browser talks only to this dev server, which forwards /api/* to the
// Express API. Same origin means the session cookie needs no CORS and no SameSite exceptions.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env['API_URL'] ?? 'http://127.0.0.1:3000',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
