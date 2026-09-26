// Route Vue/Nuxt errors to the on-screen diagnostics overlay (diagnostics/early-errors.js) and mark the
// app as mounted so the early "did not start" timeout does not fire.
declare global {
  interface Window {
    __csShowError?: (err: unknown, context?: string) => void
    __csMounted?: boolean
  }
}

export default defineNuxtPlugin((nuxtApp) => {
  const show = (err: unknown, context: string) => window.__csShowError?.(err, context)

  nuxtApp.hook('vue:error', (err, _instance, info) => show(err, `vue: ${info}`))
  nuxtApp.hook('app:error', (err) => show(err, 'app'))
  nuxtApp.hook('app:mounted', () => {
    window.__csMounted = true
  })
})
