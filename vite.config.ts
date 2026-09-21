import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  // 相对路径：GitHub Pages 部署在 用户名.github.io/仓库名/ 子路径下，
  // 绝对路径 /assets/... 会 404，必须用相对路径
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // three.js 单 chunk 较大属正常，不为此告警
    chunkSizeWarningLimit: 1500,
  },
})
