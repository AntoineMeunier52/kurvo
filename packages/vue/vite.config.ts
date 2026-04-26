import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [vue()],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'editor/index': resolve(__dirname, 'src/editor/index.ts'),
      },
      formats: ['es'],
      fileName: (_, entryName) => `${entryName}.mjs`,
    },
    rollupOptions: {
      external: ['vue', '@kurvo/core'],
    },
  },
})
