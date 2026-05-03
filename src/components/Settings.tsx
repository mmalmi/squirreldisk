import { useEffect, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import {
  type DownloadEvent,
  type Update,
  checkForUpdate,
  downloadAndInstall,
  loadPrefs,
  patchPrefs,
} from '../lib/updater'

type Status =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; update: Update }
  | { kind: 'upToDate' }
  | { kind: 'installing'; pct: number | null }
  | { kind: 'installed'; version: string }
  | { kind: 'error'; message: string }

export default function Settings() {
  const [version, setVersion] = useState<string>('')
  const [prefs, setPrefs] = useState(loadPrefs())
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  useEffect(() => {
    void getVersion().then(setVersion)
  }, [])

  const apply = (patch: Parameters<typeof patchPrefs>[0]) => {
    setPrefs(patchPrefs(patch))
  }

  async function manualCheck() {
    setStatus({ kind: 'checking' })
    try {
      const update = await checkForUpdate()
      apply({ lastCheckMs: Date.now() })
      if (update && update.updateAvailable) {
        setStatus({ kind: 'available', update })
      } else {
        setStatus({ kind: 'upToDate' })
      }
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  async function install(update: Update) {
    setStatus({ kind: 'installing', pct: null })
    try {
      await downloadAndInstall(update, (event: DownloadEvent) => {
        if (event.event === 'started') {
          setStatus({ kind: 'installing', pct: event.data.contentLength ? 0 : null })
        } else if (event.event === 'progress' && event.data) {
          setStatus((prev) => {
            if (prev.kind !== 'installing') return prev
            return { kind: 'installing', pct: prev.pct === null ? null : 50 }
          })
        }
      })
      setStatus({ kind: 'installed', version: update.version })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="p-6 text-white" style={{ background: '#0F1831', minHeight: '100%' }}>
      <h1 className="text-xl font-semibold mb-4">Settings</h1>

      <section className="mb-6">
        <h2 className="text-sm uppercase tracking-wide text-gray-400 mb-2">Updates</h2>
        <div className="text-sm text-gray-300 mb-3">Current version: {version || '—'}</div>

        <div className="flex items-center gap-2 mb-3">
          <button
            className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-sm"
            onClick={manualCheck}
            disabled={status.kind === 'checking' || status.kind === 'installing'}
          >
            {status.kind === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
          {prefs.lastCheckMs > 0 && (
            <span className="text-xs text-gray-500">
              Last checked {new Date(prefs.lastCheckMs).toLocaleString()}
            </span>
          )}
        </div>

        <label className="flex items-center gap-2 mb-2 text-sm">
          <input
            type="checkbox"
            checked={prefs.autoCheck}
            disabled={prefs.autoInstall}
            onChange={(e) => apply({ autoCheck: e.target.checked })}
          />
          Check for updates automatically
        </label>
        <label className="flex items-center gap-2 mb-3 text-sm">
          <input
            type="checkbox"
            checked={prefs.autoInstall}
            onChange={(e) => apply({ autoInstall: e.target.checked })}
          />
          Install updates automatically <span className="text-xs text-gray-500">(applies on next start)</span>
        </label>

        {status.kind === 'available' && (
          <div className="mt-3 p-3 rounded bg-white/5 text-sm">
            <div className="mb-2">
              Version <strong>{status.update.version}</strong> is available.
            </div>
            {status.update.notes && (
              <div className="text-gray-400 mb-2 whitespace-pre-line">{status.update.notes}</div>
            )}
            <button
              className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-sm"
              onClick={() => install(status.update)}
            >
              Install now
            </button>
          </div>
        )}
        {status.kind === 'upToDate' && (
          <div className="mt-3 text-sm text-green-300">You're up to date.</div>
        )}
        {status.kind === 'installing' && (
          <div className="mt-3 text-sm text-gray-300">
            Installing{status.pct !== null ? ` — ${status.pct}%` : '…'}
          </div>
        )}
        {status.kind === 'installed' && (
          <div className="mt-3 text-sm text-green-300">
            Installed {status.version}. Restart SquirrelDisk to apply.
          </div>
        )}
        {status.kind === 'error' && (
          <div className="mt-3 text-sm text-red-300">{status.message}</div>
        )}
      </section>
    </div>
  )
}
