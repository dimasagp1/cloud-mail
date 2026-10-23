import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import { fileURLToPath } from 'url'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { VitePWA } from 'vite-plugin-pwa'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, 'VITE')
  return {
    root: __dirname,
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true,
      hmr: false,
    },
    base: env.VITE_STATIC_URL || '/',
    optimizeDeps: {
      include: [
        'vue',
        'vue-router',
        'pinia',
        'pinia-plugin-persistedstate',
        'axios',
        'dayjs',
        'element-plus/es',
        '@iconify/vue',
        'nprogress',
        'echarts/core',
        'echarts/charts',
        'echarts/components',
        'echarts/renderers',
        'echarts/features',
        'lodash-es',
        'dexie',
        'compressorjs',
        '@vueuse/core',
        'vue-i18n',
      ],
    },
    plugins: [
      vue(),
      VitePWA({
        selfDestroying: true,
        injectRegister: null,
        manifest: {
          name: env.VITE_PWA_NAME || 'Cloud Mail',
          short_name: env.VITE_PWA_NAME || 'Cloud Mail',
          background_color: '#FFFFFF',
          theme_color: '#FFFFFF',
          icons: [
            {
              src: 'mail-pwa.png',
              sizes: '192x192',
              type: 'image/png',
            },
          ],
        },
        workbox: {
          disableDevLogs: true,
          globPatterns: [],
          runtimeCaching: [],
          navigateFallback: null,
          cleanupOutdatedCaches: true,
        },
      }),
      AutoImport({
        dts: false,
        resolvers: [ElementPlusResolver()],
      }),
      Components({
        dts: false,
        resolvers: [ElementPlusResolver()],
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    build: {
      target: 'es2022',
      outDir: path.resolve(__dirname, 'dist'),
      emptyOutDir: true,
      assetsInclude: ['**/*.json'],
    },
  }
})
