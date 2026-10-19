import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Download, FolderOpen, LoaderCircle, Music2 } from 'lucide-react'
import { fetchPublicSpotifyLink } from '../services/spotify'

type AudioFormat = 'best' | 'mp3' | 'm4a' | 'opus' | 'flac' | 'wav'

type DownloadSectionProps = {
  musicFolderPath?: string
  isDesktop: boolean
  onRefreshLibrary: () => Promise<unknown> | unknown
  onOpenSpotify: () => void
}

type DownloadTarget = { url: string; label: string }

type DownloadProgress = {
  stage: 'preparing' | 'downloading'
  percent: number | null
  speed: string
  eta: string
  message: string
}

function isSpotifyPublicLink(value: string): boolean {
  try {
    const parsed = new URL(value)
    return (
      (parsed.hostname === 'open.spotify.com' || parsed.hostname === 'www.open.spotify.com') &&
      /^\/(track|album|playlist)\//.test(parsed.pathname)
    )
  } catch {
    return false
  }
}

function describeProgress(progress: DownloadProgress | null, index: number, total: number) {
  const prefix = total > 1 ? `Link ${index} of ${total} · ` : ''
  if (!progress) return { text: `${prefix}Starting…`, percent: null }
  if (progress.stage === 'preparing') return { text: `${prefix}${progress.message || 'Preparing…'}`, percent: null }
  if (progress.percent === null) return { text: `${prefix}Downloading…`, percent: null }
  if (progress.percent >= 100) return { text: `${prefix}Finishing…`, percent: 100 }
  const details = [`${Math.round(progress.percent)}%`, progress.speed, progress.eta && `${progress.eta} left`]
  return { text: prefix + details.filter(Boolean).join(' · '), percent: progress.percent }
}

const formats: { value: AudioFormat; label: string; description: string }[] = [
  { value: 'best', label: 'Best available audio', description: 'Original audio stream · recommended' },
  { value: 'mp3', label: 'MP3', description: 'Compatible almost everywhere' },
  { value: 'm4a', label: 'M4A', description: 'AAC audio in an M4A file' },
  { value: 'opus', label: 'Opus', description: 'High quality at smaller sizes' },
  { value: 'flac', label: 'FLAC', description: 'Lossless when the source supports it' },
  { value: 'wav', label: 'WAV', description: 'Uncompressed audio · larger files' },
]

export function DownloadSection({
  musicFolderPath,
  isDesktop,
  onRefreshLibrary,
  onOpenSpotify,
}: DownloadSectionProps) {
  const [url, setUrl] = useState('')
  const [format, setFormat] = useState<AudioFormat>('best')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [downloadedPaths, setDownloadedPaths] = useState<string[]>([])
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [queue, setQueue] = useState({ index: 0, total: 0 })
  const [cancelling, setCancelling] = useState(false)
  const cancelRequested = useRef(false)

  useEffect(() => {
    if (!isDesktop) return
    let unlisten: (() => void) | undefined
    let disposed = false
    listen<DownloadProgress>('download-progress', (event) => setProgress(event.payload))
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => {
        // Progress is a nicety; downloads still work without it.
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [isDesktop])

  const handleCancel = async () => {
    cancelRequested.current = true
    setCancelling(true)
    try {
      await invoke<boolean>('cancel_download')
    } catch {
      // Nothing was running (it may have just finished).
    }
  }

  const handleDownload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const links = url.split(/\s+/).map((item) => item.trim()).filter(Boolean)
    if (!links.length) {
      setMessage({ type: 'error', text: 'Paste one or more media or Spotify links first.' })
      return
    }
    const invalid = links.find((link) => !/^https?:\/\//i.test(link))
    if (invalid) {
      setMessage({ type: 'error', text: \`This doesn't look like a valid URL: \${invalid}\` })
      return
    }
    if (!isDesktop) {
      setMessage({ type: 'error', text: 'Downloads are available in the Resonance Windows desktop app.' })
      return
    }
    if (!musicFolderPath) {
      setMessage({ type: 'error', text: 'Choose your Music folder in Settings first. Downloads are saved there.' })
      return
    }

    cancelRequested.current = false
    setCancelling(false)
    setBusy(true)
    setDownloadedPaths([])
    setProgress(null)
    setQueue({ index: 0, total: 0 })

    const savedPaths: string[] = []
    const failures: string[] = []
    const targets: DownloadTarget[] = []

    try {
      for (let index = 0; index < links.length; index += 1) {
        if (cancelRequested.current) break
        const link = links[index]
        if (isSpotifyPublicLink(link)) {
          throw new Error('Spotify links provide track metadata, not downloadable audio. Open Spotify tools to inspect the link, then paste a direct audio/media URL you have permission to download.')
        } else {
          targets.push({ url: link, label: `Link ${index + 1}` })
        }
      }

      if (cancelRequested.current) {
        setMessage({ type: 'info', text: 'Download cancelled before any files were downloaded.' })
        return
      }
      if (!targets.length) {
        setMessage({ type: 'error', text: 'No downloadable media links were found.' })
        return
      }

      for (let index = 0; index < targets.length; index += 1) {
        if (cancelRequested.current) break
        const target = targets[index]
        setQueue({ index: index + 1, total: targets.length })
        setProgress(null)
        setMessage({
          type: 'info',
          text: \`Downloading \${index + 1} of \${targets.length}: \${target.label}…\`,
        })
        try {
          const savedPath = await invoke<string>('download_audio', {
            url: target.url,
            outputDir: musicFolderPath,
            format,
          })
          savedPaths.push(savedPath)
          setDownloadedPaths([...savedPaths])
        } catch (error) {
          if (cancelRequested.current) break
          const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Download failed.'
          failures.push(\`\${target.label}: \${detail}\`)
        }
      }

      if (savedPaths.length) {
        try {
          await onRefreshLibrary()
        } catch {
          // The files are already downloaded; keep their successful status visible.
        }
      }

      if (cancelRequested.current) {
        setMessage({
          type: 'info',
          text: \`Download cancelled. \${savedPaths.length} of \${targets.length} audio file(s) downloaded.\`,
        })
      } else if (failures.length === 0) {
        setUrl('')
        setMessage({
          type: 'success',
          text: \`All \${savedPaths.length} audio file(s) downloaded and added to your library.\`,
        })
      } else {
        setMessage({
          type: 'error',
          text: \`\${savedPaths.length} of \${targets.length} audio file(s) downloaded. \${failures.slice(0, 4).join(' · ')}\${failures.length > 4 ? \` · and \${failures.length - 4} more failure(s)\` : ''}\`,
        })
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Could not prepare this download.'
      setMessage({
        type: cancelRequested.current ? 'info' : 'error',
        text: cancelRequested.current ? 'Download cancelled.' : detail,
      })
    } finally {
      setBusy(false)
      setProgress(null)
      setCancelling(false)
    }
  }

  const linkCount = url.trim() ? url.trim().split(/\s+/).filter(Boolean).length : 0

  return (
    <section className="download-page">
      <header className="download-page-header">
        <div className="download-heading-icon"><Download size={22} /></div>
        <div>
          <p className="eyebrow">RESONANCE · DOWNLOADS</p>
          <h1>Download audio</h1>
          <p className="download-subtitle">Paste one link or a whole list. Audio is saved directly to your local library.</p>
        </div>
      </header>

      <div className="download-card-heading"><div className="download-card-heading-copy"><p className="download-card-eyebrow">SPOTIFY</p><h2>Spotify links</h2><p>Look up public Spotify track, album, and playlist details here. Spotify itself does not provide downloadable audio files.</p></div><button type="button" className="spotify-connect-button" onClick={onOpenSpotify}><Music2 size={17} /> Open Spotify tools</button></div>
      <form className="download-card" onSubmit={handleDownload}>
        <div className="download-card-heading">
          <div className="download-card-heading-copy">
            <p className="download-card-eyebrow">DOWNLOAD SETUP</p>
            <h2>Queue up your audio</h2>
            <p>Add one source link or paste a whole batch. Files are saved straight into your Resonance library.</p>
          </div>
          <div className="download-queue-count" aria-live="polite">
            <strong>{linkCount}</strong>
            <span>{linkCount === 1 ? 'link queued' : 'links queued'}</span>
          </div>
        </div>

        <div className="download-workspace">
          <div className="download-links-panel">
            <div className="download-field-topline">
              <label className="download-field-label" htmlFor="download-url">Media or Spotify URLs</label>
              <span>ONE PER LINE</span>
            </div>
            <textarea
              id="download-url"
              className="download-url-input download-url-textarea"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={'Paste media URLs or public Spotify links…\nhttps://…\nhttps://open.spotify.com/track/…'}
              autoComplete="off"
              rows={6}
              disabled={busy}
            />
            <div className="download-url-hint">Direct media links download as-is. Public Spotify links are resolved to track details, then matched against available audio sources; check the matches and only save audio you have permission to download.</div>
          </div>

          <div className="download-options-panel">
            <div className="download-option-group">
              <label className="download-field-label" htmlFor="download-format">Audio format</label>
              <div className="download-format-wrap">
                <Music2 size={18} />
                <select id="download-format" value={format} onChange={(event) => setFormat(event.target.value as AudioFormat)} disabled={busy}>
                  {formats.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
              <p className="download-format-description">{formats.find((option) => option.value === format)?.description}</p>
            </div>

            <div className="download-destination">
              <FolderOpen size={19} />
              <div className="download-destination-copy">
                <strong>Save location</strong>
                <span title={musicFolderPath || 'No music folder selected'}>
                  {musicFolderPath ? musicFolderPath : 'No Music folder selected'}
                </span>
              </div>
            </div>

            <button className="download-submit download-submit-full" type="submit" disabled={busy || !url.trim()}>
              {busy ? <LoaderCircle size={17} className="download-spinner" /> : <Download size={17} />}
              <span>{busy ? 'Downloading queue…' : `Download ${linkCount} link${linkCount === 1 ? '' : 's'}`}</span>
            </button>
          </div>
        </div>

        {busy && (() => {
          const view = describeProgress(progress, queue.index, queue.total)
          return (
            <div className="download-progress">
              <div
                className="download-progress-track"
                role="progressbar"
                aria-label="Download progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={view.percent === null ? undefined : Math.round(view.percent)}
              >
                <div
                  className={`download-progress-fill${view.percent === null ? ' is-indeterminate' : ''}`}
                  style={view.percent === null ? undefined : { width: `${view.percent}%` }}
                />
              </div>
              <div className="download-progress-meta">
                <span aria-live="polite">{view.text}</span>
                <button type="button" className="download-cancel" onClick={handleCancel} disabled={cancelling}>
                  {cancelling ? 'Cancelling…' : 'Cancel'}
                </button>
              </div>
            </div>
          )
        })()}

        {message && (
          <div className={`download-message download-message-${message.type}`} role="status" aria-live="polite">
            {message.text}
          </div>
        )}
        {downloadedPaths.length > 0 && (
          <div className="download-completed-file">
            <span>Downloaded files ({downloadedPaths.length})</span>
            {downloadedPaths.map((path) => <code key={path} title={path}>{path}</code>)}
          </div>
        )}
      </form>


    </section>
  )
}
