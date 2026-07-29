import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-server-only proxy so `npm run dev` can talk to the Express API on :4000
// without CORS. In production the built dist/ is served by Express directly
// (same origin, no proxy needed) - see server/index.js.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:4000'
    }
  }
});
