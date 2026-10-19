import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { motion } from 'framer-motion'
import { CheckFilled, CloseFilled, FolderImageFilled, FolderMusicFilled, RefreshFilled, SettingsFilled } from '../icons'
import { useMusicStore } from '../../store/useMusicStore'
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  SHORTCUT_DEFINITIONS,
  formatShortcut,
  normalizeShortcutEvent,
  type ShortcutAction,
} from '../../utils/keyboardShortcuts.ts'

type SettingsTab = 'Shortcuts' | 'Folders' | 'Appearance'
type FolderAction = () => void | Promise<void>

export type SettingsModalProps = {
  onClose: () => void
  isDesktop: boolean
  onAddMusicFolder: (event: ChangeEvent<HTMLInputElement>) => void
  onAddCoverFolder: (event: ChangeEvent<HTMLInputElement>) => void
  onNativeMusicFolder: FolderAction
  onNativeCoverFolder: FolderAction
  onRescanMusicFolder: FolderAction
  onRescanCoverFolder: FolderAction
  isScanningMusic: boolean
  isScanningCovers: boolean
  musicFolderName?: string
  coverFolderName?: string
  scanNotice?: string | null
}

export function SettingsModal({
  onClose, isDesktop, onAddMusicFolder, onAddCoverFolder,
  onNativeMusicFolder, onNativeCoverFolder, onRescanMusicFolder, onRescanCoverFolder,
  isScanningMusic, isScanningCovers, musicFolderName, coverFolderName, scanNotice,
}: SettingsModalProps) {
  const tracks = useMusicStore((state) => state.tracks)
  const playlists = useMusicStore((state) => state.playlists)
  const keyboardShortcuts = useMusicStore((state) => state.keyboardShortcuts)
  const setKeyboardShortcuts = useMusicStore((state) => state.setKeyboardShortcuts)
  const playerBarHoverMode = useMusicStore((state) => state.playerBarHoverMode)
  const setPlayerBarHoverMode = useMusicStore((state) => state.setPlayerBarHoverMode)
  const autoHideSidebar = useMusicStore((state) => state.autoHideSidebar)
  const setAutoHideSidebar = useMusicStore((state) => state.setAutoHideSidebar)
  const [activeTab, setActiveTab] = useState<SettingsTab>('Shortcuts')
  const [editingAction, setEditingAction] = useState<ShortcutAction | null>(null)
  const [shortcutError, setShortcutError] = useState<string | null>(null)
  const musicInputRef = useRef<HTMLInputElement>(null)
  const coverInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape' && !editingAction) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [editingAction, onClose])

  const startEditingShortcut = (action: ShortcutAction) => {
    setShortcutError(null)
    setEditingAction(action)
  }
  const cancelShortcutEdit = () => {
    setEditingAction(null)
    setShortcutError(null)
  }
  const handleShortcutCapture = (event: ReactKeyboardEvent<HTMLButtonElement>, action: ShortcutAction) => {
    if (editingAction !== action) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      cancelShortcutEdit()
      return
    }
    if (event.key === 'Tab') {
      cancelShortcutEdit()
      return
    }
    const binding = normalizeShortcutEvent(event.nativeEvent)
    event.preventDefault()
    event.stopPropagation()
    if (!binding) {
      setShortcutError('That key or key combination is unsupported or reserved by the system.')
      return
    }
    const conflict = SHORTCUT_DEFINITIONS.find(
      (definition) => definition.id !== action && keyboardShortcuts[definition.id] === binding,
    )
    if (conflict) {
      setShortcutError(`${formatShortcut(binding)} is already assigned to ${conflict.label}.`)
      return
    }
    setKeyboardShortcuts({ ...keyboardShortcuts, [action]: binding })
    setShortcutError(null)
    setEditingAction(null)
  }

  const openMusicFolder = () => {
    if (isDesktop) {
      void onNativeMusicFolder()
      return
    }
    musicInputRef.current?.click()
  }
  const openCoverFolder = () => {
    if (isDesktop) {
      void onNativeCoverFolder()
      return
    }
    coverInputRef.current?.click()
  }

  return (
    <motion.div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true"
      aria-labelledby="settings-modal-title" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
      <motion.div className="modal-card settings-modal-card" onClick={(event) => event.stopPropagation()}
        initial={{ opacity: 0, scale: 0.94, y: 16 }} animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.94, y: 12 }} transition={{ type: 'spring', damping: 26, stiffness: 380 }}>
        <header className="modal-header">
          <div className="settings-modal-title-group">
            <div className="settings-modal-icon-badge"><SettingsFilled size={20} /></div>
            <div>
              <h3 id="settings-modal-title">Settings</h3>
              <p className="settings-modal-subtitle">Manage shortcuts, folders, and appearance</p>
            </div>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close settings dialog" title="Close">
            <CloseFilled size={18} />
          </button>
        </header>

        <nav className="settings-tabs" aria-label="Settings sections">
          {(['Shortcuts', 'Folders', 'Appearance'] as const).map((tab) => (
            <button key={tab} type="button" className={activeTab === tab ? 'settings-tab active' : 'settings-tab'}
              aria-pressed={activeTab === tab} onClick={() => setActiveTab(tab)}>{tab}</button>
          ))}
        </nav>

        <div className="settings-tab-content">
          {activeTab === 'Shortcuts' && (
            <section className="settings-panel shortcuts-panel" aria-label="Shortcuts">
              <div className="settings-section-header">
                <span className="settings-eyebrow">Keyboard shortcuts</span>
                <p className="settings-section-desc">Select Change, then press a key or supported key combination. Updates apply immediately.</p>
              </div>
              <div className="shortcuts-list">
                {SHORTCUT_DEFINITIONS.map(({ id, label }) => (
                  <div className="shortcut-row" key={id}>
                    <span className="shortcut-action">{label}</span>
                    <div className="shortcut-controls">
                      <kbd className="shortcut-kbd">{formatShortcut(keyboardShortcuts[id])}</kbd>
                      <button type="button"
                        className={editingAction === id ? 'settings-action-button is-capturing' : 'settings-action-button'}
                        data-shortcut-capture={editingAction === id ? 'true' : undefined}
                        aria-label={editingAction === id ? `Press a key for ${label}` : `Change shortcut for ${label}`}
                        onClick={() => editingAction === id ? cancelShortcutEdit() : startEditingShortcut(id)}
                        onKeyDown={(event) => handleShortcutCapture(event, id)}>
                        {editingAction === id ? 'Press a key…' : 'Change'}
                      </button>
                      {editingAction === id && <button type="button" className="settings-cancel-edit" onClick={cancelShortcutEdit}>Cancel</button>}
                    </div>
                  </div>
                ))}
              </div>
              {shortcutError && <p className="settings-inline-error" role="alert">{shortcutError}</p>}
              <div className="settings-shortcut-footer">
                <button type="button" className="settings-action-button" onClick={() => {
                  cancelShortcutEdit()
                  setKeyboardShortcuts(DEFAULT_KEYBOARD_SHORTCUTS)
                }}>Restore defaults</button>
                <span>Hardware media previous/next keys are supported when available.</span>
              </div>
              <div className="app-info-footer">
                <div><strong>Resonance</strong><span>Local High-Fidelity Audio Player</span></div>
                <div className="app-stats"><span>{tracks.length} tracks</span><span>•</span><span>{playlists.length} playlists</span></div>
              </div>
            </section>
          )}

          {activeTab === 'Folders' && (
            <section className="settings-panel folders-panel" aria-label="Folders">
              <div className="settings-section-header">
                <span className="settings-eyebrow">Library folders</span>
                <p className="settings-section-desc">Choose the folders Resonance scans for music and cover artwork. Existing paths remain saved.</p>
              </div>
              <div className="settings-folder-row">
                <div className="settings-folder-icon"><FolderMusicFilled size={20} /></div>
                <div className="settings-folder-description"><strong>Music folder</strong><span>{musicFolderName || 'No music folder selected'}</span></div>
                <div className="settings-folder-actions">
                  <button type="button" className="settings-action-button" onClick={openMusicFolder}>Change</button>
                  <button type="button" className="settings-action-button" onClick={() => void onRescanMusicFolder()} disabled={isScanningMusic} aria-label="Rescan music folder">
                    <RefreshFilled size={14} /> {isScanningMusic ? 'Scanning…' : 'Rescan'}
                  </button>
                  {!isDesktop && <input ref={musicInputRef} type="file" multiple onChange={onAddMusicFolder}
                    {...{ webkitdirectory: '', directory: '' }} className="settings-hidden-folder-input" aria-label="Select music folder" />}
                </div>
              </div>
              <div className="settings-folder-row">
                <div className="settings-folder-icon"><FolderImageFilled size={20} /></div>
                <div className="settings-folder-description"><strong>Cover-art folder</strong><span>{coverFolderName || 'No cover-art folder selected'}</span></div>
                <div className="settings-folder-actions">
                  <button type="button" className="settings-action-button" onClick={openCoverFolder}>Change</button>
                  <button type="button" className="settings-action-button" onClick={() => void onRescanCoverFolder()} disabled={isScanningCovers} aria-label="Rescan cover-art folder">
                    <RefreshFilled size={14} /> {isScanningCovers ? 'Scanning…' : 'Rescan'}
                  </button>
                  {!isDesktop && <input ref={coverInputRef} type="file" multiple onChange={onAddCoverFolder}
                    {...{ webkitdirectory: '', directory: '' }} className="settings-hidden-folder-input" aria-label="Select cover-art folder" />}
                </div>
              </div>
              {scanNotice && <p className="settings-scan-notice" role="status"><CheckFilled size={14} /> {scanNotice}</p>}
            </section>
          )}

          {activeTab === 'Appearance' && (
            <section className="settings-panel appearance-panel" aria-label="Appearance">
              <div className="settings-section-header">
                <span className="settings-eyebrow">Display behavior</span>
                <p className="settings-section-desc">Customize how the player bar and navigation sidebar appear.</p>
              </div>
              <div className="settings-option-row">
                <div className="settings-option-copy"><strong>Player Bar Hover Mode</strong><span>When enabled, the player bar keeps its existing floating position. When disabled, it docks to the bottom of the application layout.</span></div>
                <button type="button" role="switch" aria-checked={playerBarHoverMode}
                  className={playerBarHoverMode ? 'settings-switch on' : 'settings-switch'}
                  onClick={() => setPlayerBarHoverMode(!playerBarHoverMode)}><span /></button>
              </div>
              <div className="settings-option-row">
                <div className="settings-option-copy"><strong>Auto-Hide Side Panel</strong><span>When enabled, the sidebar slides away and appears when the pointer approaches the left edge. It stays open while you interact with it.</span></div>
                <button type="button" role="switch" aria-checked={autoHideSidebar}
                  className={autoHideSidebar ? 'settings-switch on' : 'settings-switch'}
                  onClick={() => setAutoHideSidebar(!autoHideSidebar)}><span /></button>
              </div>
            </section>
          )}
        </div>
        <footer className="settings-modal-footer">
          <button type="button" className="btn-primary settings-done-btn" onClick={onClose}>Done</button>
        </footer>
      </motion.div>
    </motion.div>
  )
}

export default SettingsModal
