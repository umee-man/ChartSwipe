// ChartSwipe web client — Nuxt 3 SPA + PWA (arch §5.1).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Early on-screen error reporter, inlined so it works even when the JS bundle cannot run. */
const earlyErrors = readFileSync(fileURLToPath(new URL('./diagnostics/early-errors.js', import.meta.url)), 'utf8')

/**
 * Browsers we transpile for. Default Vite output keeps ES2021+ syntax (`??=` etc.), which is a hard
 * SyntaxError → blank screen on older iOS Safari / Android WebViews.
 */
const BROWSER_TARGET = ['es2020', 'safari14', 'chrome87', 'firefox78']

export default defineNuxtConfig({
  compatibilityDate: '2026-09-26',
  ssr: false,
  devtools: { enabled: false },
  modules: ['@pinia/nuxt', '@vite-pwa/nuxt'],
  css: ['~/assets/css/main.css'],

  typescript: {
    strict: true,
    typeCheck: false, // run explicitly via `npm run typecheck`
  },

  devServer: {
    host: '0.0.0.0', // reachable from a phone on the LAN
    port: 3000,
  },

  app: {
    head: {
      htmlAttrs: { lang: 'ru' },
      title: 'ChartSwipe',
      meta: [
        // viewport-fit=cover for safe-area insets; no page zoom so pinch goes to the chart.
        { name: 'viewport', content: 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover' },
        { name: 'theme-color', content: '#0b0e11' },
        { name: 'color-scheme', content: 'dark' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/icon.svg' },
        { rel: 'apple-touch-icon', href: '/icon-192.png' },
      ],
      // Classic inline script: runs before the (deferred) module bundle.
      script: [{ innerHTML: earlyErrors, tagPosition: 'head' }],
    },
  },

  vite: {
    // cssTarget lowers e.g. `inset` (Safari < 14.1) to top/right/bottom/left.
    build: { target: BROWSER_TARGET, cssTarget: BROWSER_TARGET },
    // Only the production bundle is lowered to BROWSER_TARGET. Do not set optimizeDeps.esbuildOptions.target
    // or esbuild.target: esbuild cannot lower some destructuring patterns in the Nuxt runtime/page macros
    // and the dev dependency scan then fails, serving 504s for every pre-bundled dep.
    optimizeDeps: {
      // Pre-bundle at dev-server start. Otherwise Vite discovers these on the first page load, re-optimises
      // and answers the in-flight imports with 504 "Outdated Optimize Dep", relying on an HMR full reload —
      // on a phone over LAN that left a dark, never-mounted page (the reported "black screen").
      include: ['lightweight-charts', 'idb'],
    },
  },

  // Served by the Nitro node server in production (arch §11). Hashed bundles are immutable;
  // the HTML shell and service worker must always revalidate so deploys take effect.
  routeRules: {
    '/_nuxt/**': { headers: { 'cache-control': 'public, max-age=31536000, immutable' } },
    '/': { headers: { 'cache-control': 'no-cache' } },
    '/sw.js': { headers: { 'cache-control': 'no-cache' } },
    '/manifest.webmanifest': { headers: { 'cache-control': 'no-cache' } },
  },

  // Service worker = invisible app-shell cache only (ADR A9); no install UI anywhere.
  pwa: {
    registerType: 'autoUpdate',
    manifest: {
      name: 'ChartSwipe',
      short_name: 'ChartSwipe',
      description: 'Лента крипто-графиков в формате рилсов',
      lang: 'ru',
      theme_color: '#0b0e11',
      background_color: '#0b0e11',
      // ADR A9: plain website, not an installable app — 'browser' keeps Chrome from offering install.
      display: 'browser',
      orientation: 'portrait',
      start_url: '/',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      // App shell only; market data (fapi/fstream) is never cached by the SW.
      navigateFallback: '/',
      globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
    },
    client: { installPrompt: false },
    devOptions: { enabled: false },
  },
})
