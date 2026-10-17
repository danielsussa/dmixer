/** Browser-side diagnostics sent to the server (/api/clientlog), so a phone can be debugged from the desktop. */
let queue: unknown[] = []
let timer = 0

export function diag(msg: string, data?: Record<string, unknown>) {
  queue.push({ msg, t: Math.round(performance.now()), ...data })
  if (!timer) timer = window.setTimeout(flush, 400)
}

function flush() {
  timer = 0
  const events = queue
  queue = []
  if (!events.length) return
  void fetch('/api/clientlog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events }) }).catch(() => {})
}

window.addEventListener('error', (e) => diag('error', { message: e.message, src: `${e.filename}:${e.lineno}` }))
window.addEventListener('unhandledrejection', (e) => diag('rejection', { message: String((e.reason as Error)?.stack ?? e.reason) }))
