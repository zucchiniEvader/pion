import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        // ws (remote-daemon client) bundles into main; its optional native
        // accelerators must resolve to a stub or Node crashes on load
        // ("Could not resolve \"bufferutil\"") — ws falls back to pure JS.
        bufferutil: resolve('scripts/stubs/empty-module.cjs'),
        'utf-8-validate': resolve('scripts/stubs/empty-module.cjs'),
      },
    },
    build: { lib: { entry: 'electron/main/index.ts' } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: 'electron/preload/index.ts', formats: ['cjs'] },
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
    },
  },
  renderer: {
    root: '.',
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
    build: { rollupOptions: { input: resolve('index.html') } },
  },
})
