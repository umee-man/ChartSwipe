// ChartSwipe web client — Nuxt 3 SPA + PWA (arch §5.1).
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
    },
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
