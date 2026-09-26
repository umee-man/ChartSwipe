/* ChartSwipe early diagnostics. Inlined into <head> by nuxt.config.ts as a classic script, so it runs
 * before (and independently of) the module bundle: it still reports if the bundle fails to download,
 * fails to parse on an old browser, or throws before Vue mounts. Plain ES5 on purpose.
 * Exposes window.__csShowError(err, context) for the Nuxt plugin (vue:error / app:error). */
(function () {
  var MOUNT_TIMEOUT_MS = 20000
  var box = null
  var entries = []

  function text(v) {
    if (!v) return ''
    if (typeof v === 'string') return v
    if (v.stack) return String(v.stack)
    if (v.message) return String(v.message)
    try {
      return JSON.stringify(v)
    } catch (e) {
      return String(v)
    }
  }

  function el(tag, css, content) {
    var n = document.createElement(tag)
    n.setAttribute('style', css)
    if (content != null) n.textContent = content
    return n
  }

  function render(fatal) {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () {
        render(fatal)
      })
      return
    }
    if (box) box.parentNode && box.parentNode.removeChild(box)
    box = el(
      'div',
      'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;overflow:auto;-webkit-overflow-scrolling:touch;' +
        'touch-action:pan-y;background:#0b0e11;color:#e8eaed;font:14px/1.45 system-ui,-apple-system,sans-serif;' +
        'padding:max(16px,env(safe-area-inset-top)) 16px 24px;box-sizing:border-box',
    )
    box.appendChild(el('h1', 'margin:0 0 8px;font-size:22px;color:#ef5350', 'Ошибка'))
    box.appendChild(
      el('p', 'margin:0 0 12px;color:#8a929c', 'Сделайте скриншот этого экрана и отправьте разработчику.'),
    )
    var btns = el('div', 'display:flex;gap:8px;margin:0 0 12px')
    var reload = el(
      'button',
      'flex:1;min-height:48px;border:0;border-radius:12px;background:#f0b90b;color:#0b0e11;font:600 16px system-ui,sans-serif',
      'Перезагрузить',
    )
    reload.onclick = function () {
      location.reload()
    }
    btns.appendChild(reload)
    if (!fatal) {
      var close = el(
        'button',
        'flex:1;min-height:48px;border:0;border-radius:12px;background:#1c222a;color:#e8eaed;font:16px system-ui,sans-serif',
        'Закрыть',
      )
      close.onclick = function () {
        box.parentNode && box.parentNode.removeChild(box)
        box = null
        entries = []
      }
      btns.appendChild(close)
    }
    box.appendChild(btns)
    for (var i = 0; i < entries.length; i++) {
      box.appendChild(
        el(
          'pre',
          'white-space:pre-wrap;word-break:break-word;margin:0 0 10px;padding:10px;border-radius:10px;background:#12161b;font:12px/1.4 ui-monospace,Menlo,monospace',
          entries[i],
        ),
      )
    }
    box.appendChild(
      el(
        'p',
        'margin:12px 0 0;color:#8a929c;font-size:11px;word-break:break-word',
        location.href + '\n' + navigator.userAgent + '\nsecure: ' + !!window.isSecureContext,
      ),
    )
    document.body.appendChild(box)
  }

  function show(err, context) {
    if (entries.length >= 5) return // avoid runaway loops filling the screen
    entries.push((context ? '[' + context + '] ' : '') + text(err))
    // Before the app mounted there is nothing usable underneath: no "Закрыть".
    render(!window.__csMounted)
  }

  window.__csShowError = show

  // Capture phase also sees resource failures (e.g. a JS chunk that did not download).
  window.addEventListener(
    'error',
    function (e) {
      var t = e.target
      if (t && t !== window && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) {
        show('Не удалось загрузить: ' + (t.src || t.href), 'resource')
        return
      }
      if (!e.message && !e.error) return
      show(e.error || e.message + ' (' + e.filename + ':' + e.lineno + ':' + e.colno + ')', 'window.onerror')
    },
    true,
  )
  window.addEventListener('unhandledrejection', function (e) {
    show(e.reason, 'unhandledrejection')
  })

  setTimeout(function () {
    if (window.__csMounted || entries.length) return
    show(
      'Приложение не запустилось за ' +
        MOUNT_TIMEOUT_MS / 1000 +
        ' с. Скрипты не загрузились или браузер их не поддерживает.',
      'timeout',
    )
  }, MOUNT_TIMEOUT_MS)
})()
