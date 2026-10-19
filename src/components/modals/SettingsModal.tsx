import { useEffect } from 'react'
import { motion } from 'framer-motion'
import { CloseFilled, SettingsFilled } from '../icons'
import { useMusicStore } from '../../store/useMusicStore'
import { FolderImageFilled, FolderMusicFilled, RefreshFilled } from '../icons'

export type SettingsModalProps = {
  onClose: () => void
  musicFolderName?: string
  coverFolderName?: string
  isDesktop?: boolean
  isScanningMusic?: boolean
  isScanningCovers?: boolean
  onChooseMusicFolder: () => void
  onChooseCoverFolder: () => void
  onRescanMusicFolder: () => void
  onRescanCoverFolder: () => void
}

export function SettingsModal({ onClose, musicFolderName, coverFolderName, isDesktop = false, isScanningMusic = false, isScanningCovers = false, onChooseMusicFolder, onChooseCoverFolder, onRescanMusicFolder, onRescanCoverFolder }: SettingsModalProps) {
  const tracks = useMusicStore((state) => state.tracks)
  const playlists = useMusicStore((state) => state.playlists)

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <motion.div
      className="modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        className="modal-card settings-modal-card"
        onClick={(event) => event.stopPropagation()}
        initial={{ opacity: 0, scale: 0.94, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.94, y: 12 }}
        transition={{ type: 'spring', damping: 26, stiffness: 380 }}
      >
        <header className="modal-header">
          <div className="settings-modal-title-group">
            <div className="settings-modal-icon-badge">
              <SettingsFilled size={20} />
            </div>
            <div>
              <h3 id="settings-modal-title">Settings</h3>
              <p className="settings-modal-subtitle">Library folders, keyboard shortcuts, and library information</p>
            </div>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close settings dialog"
            title="Close"
          >
            <CloseFilled size={18} />
          </button>
        </header>

        <div className="settings-panel shortcuts-panel">
          <div className="settings-section-header">
            <span className="settings-eyebrow">Library folders</span>
            <p className="settings-section-desc">Choose where Resonance reads music and cover artwork. Rescan after adding files.</p>
          </div>
          <div className="settings-folder-list">
            <div className="settings-folder-row">
              <FolderMusicFilled size={19} />
              <div className="settings-folder-copy"><strong>Music folder</strong><span title={musicFolderName || 'No folder selected'}>{musicFolderName || 'No folder selected'}</span></div>
              <button type="button" className="settings-folder-action" onClick={onChooseMusicFolder}>{musicFolderName ? 'Change' : 'Choose'}</button>
              <button type="button" className="settings-folder-rescan" onClick={onRescanMusicFolder} disabled={!musicFolderName || isScanningMusic} title="Rescan music folder" aria-label="Rescan music folder"><RefreshFilled size={15} className={isScanningMusic ? 'spinning' : ''} /></button>
            </div>
            <div className="settings-folder-row">
              <FolderImageFilled size={19} />
              <div className="settings-folder-copy"><strong>Cover folder</strong><span title={coverFolderName || 'No folder selected'}>{coverFolderName || 'No folder selected'}</span></div>
              <button type="button" className="settings-folder-action" onClick={onChooseCoverFolder}>{coverFolderName ? 'Change' : 'Choose'}</button>
              <button type="button" className="settings-folder-rescan" onClick={onRescanCoverFolder} disabled={!coverFolderName || isScanningCovers} title="Rescan cover folder" aria-label="Rescan cover folder"><RefreshFilled size={15} className={isScanningCovers ? 'spinning' : ''} /></button>
            </div>
            {!isDesktop && <p className="settings-section-desc">Folder selection is available in the Windows desktop app.</p>}
          </div>
          <div className="settings-section-header">
            <span className="settings-eyebrow">Keyboard Shortcuts</span>
            <p className="settings-section-desc">Quick key controls for seamless playback without reaching for the mouse.</p>
          </div>

          <div className="shortcuts-list">
            <div className="shortcut-row">
              <span className="shortcut-action">Play / Pause</span>
              <kbd className="shortcut-kbd">Space</kbd>
            </div>
            <div className="shortcut-row">
              <span className="shortcut-action">Seek Backward 5s</span>
              <kbd className="shortcut-kbd">←</kbd>
            </div>
            <div className="shortcut-row">
              <span className="shortcut-action">Seek Forward 5s</span>
              <kbd className="shortcut-kbd">→</kbd>
            </div>
            <div className="shortcut-row">
              <span className="shortcut-action">Volume Up / Down</span>
              <kbd className="shortcut-kbd">↑ / ↓</kbd>
            </div>
            <div className="shortcut-row">
              <span className="shortcut-action">Toggle Mute</span>
              <kbd className="shortcut-kbd">M</kbd>
            </div>
            <div className="shortcut-row">
              <span className="shortcut-action">Toggle Shuffle</span>
              <kbd className="shortcut-kbd">S</kbd>
            </div>
            <div className="shortcut-row">
              <span className="shortcut-action">Cycle Repeat Mode</span>
              <kbd className="shortcut-kbd">R</kbd>
            </div>
          </div>

          <div className="app-info-footer">
            <div>
              <strong>Resonance</strong>
              <span>Local High-Fidelity Audio Player</span>
            </div>
            <div className="app-stats">
              <span>{tracks.length} tracks</span>
              <span>•</span>
              <span>{playlists.length} playlists</span>
            </div>
          </div>
        </div>

        <footer className="settings-modal-footer">
          <button type="button" className="btn-primary settings-done-btn" onClick={onClose}>
            Done
          </button>
        </footer>
      </motion.div>
    </motion.div>
  )
}

export default SettingsModal
