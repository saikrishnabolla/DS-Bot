import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const require = createRequire(import.meta.url)
const primitives = fileURLToPath(new URL('./ui/src/primitives.js', import.meta.url))

// The desktop bundle replaces the minimal source primitives with its rich renderer.
const ownPrimitives = {
  name: 'ds-bot-primitives',
  enforce: 'pre',
  resolveId(source, importer) {
    return source === './ui-primitives.js' && importer?.replaceAll('\\', '/').includes('/ds-bot/src/client/') ? primitives : null
  },
}

// The window loads the build from the app's own scheme, so asset paths stay relative.
export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  base: './',
  plugins: [ownPrimitives],
  // The Bot views come from the plugin's interface code in ../ds-bot, which has no React
  // of its own.
  resolve: {
    alias: { 'qrcode-generator': require.resolve('qrcode-generator') },
    dedupe: ['react', 'react-dom'],
  },
  // One bundle: the window loads it from disk, not over a network.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2048 },
})
