import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@dimforge')) return 'physics';
          if (id.includes('node_modules/three')) return 'three';
        },
      },
    },
  },
});
