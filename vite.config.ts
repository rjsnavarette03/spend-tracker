import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      // Add a strict CSP to the production build (loaded via file://).
      // Dev mode needs inline scripts for react-refresh, so build-only.
      name: 'inject-csp',
      apply: 'build',
      transformIndexHtml(html: string) {
        return html.replace(
          '</title>',
          `</title>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" />`
        );
      },
    },
  ],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
