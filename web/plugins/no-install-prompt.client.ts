// ADR A9: ChartSwipe is a plain website — never show "install app" banners/mini-infobars.
// The service worker stays only as an invisible cache for speed.
export default defineNuxtPlugin(() => {
  window.addEventListener('beforeinstallprompt', (e) => e.preventDefault())
})
