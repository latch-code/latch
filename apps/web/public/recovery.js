// Keep this independent of the application's hashed modules and styles.
{
  const root = document.getElementById('root')
  const surface = document.getElementById('latch-recovery')
  const status = surface?.querySelector('[role="status"]')
  const reload = surface?.querySelector('button')
  const instructions = document.getElementById('latch-recovery-instructions')
  if (root && surface && status && reload && instructions) {
    const words = {
      'zh-CN': { loading: '正在打开…', failed: 'Latch 无法打开此页面。', reload: '重新加载' },
      en: { loading: 'Opening…', failed: 'Latch could not open this page.', reload: 'Reload' },
    }
    const languages = navigator.languages ?? []
    const supported = languages.find(language => /^(zh|en)(-|$)/iu.test(language))
    const browserLanguage = /^zh/iu.test(supported ?? '') || languages.length === 0 ? 'zh-CN' : 'en'

    function showStatus(language, failed = false) {
      surface.lang = language
      const copy = words[language === 'en' ? 'en' : 'zh-CN']
      status.textContent = failed ? copy.failed : copy.loading
      reload.textContent = copy.reload
      reload.hidden = !failed
    }

    showStatus(browserLanguage)
    reload.addEventListener('click', () => location.reload())
    instructions.hidden = true

    // Browser events cover a missing entry, a missing static dependency and startup before React can handle errors.
    window.addEventListener(
      'error',
      event => {
        if (root.hasChildNodes()) return
        const moduleFailed = event.target instanceof HTMLScriptElement && event.target.type === 'module'
        const appFailed = event instanceof ErrorEvent && event.filename.startsWith(`${location.origin}/link/`)
        if (!moduleFailed && !appFailed) return
        event.preventDefault()
        showStatus(browserLanguage, true)
      },
      true,
    )
    document.addEventListener('latch:page-load-error', () => showStatus(document.documentElement.lang, true))
  }
}
