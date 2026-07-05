import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 建议添加以下配置
  base: '/joye-preschool/',
  server: {
    port: 5173,
    open: true
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // 建议清理旧文件
    emptyOutDir: true
  }
})
