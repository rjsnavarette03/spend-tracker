import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Keep the framework in its own hash-stable chunk so it stays cached
        // across app deploys (app code changes far more often than deps).
        manualChunks: { vendor: ['react', 'react-dom', 'react-router-dom'] },
      },
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    // Local PHP dev server (php -S) hosts the API during development.
    proxy: {
      '/api': 'http://127.0.0.1:8124',
    },
  },
});
