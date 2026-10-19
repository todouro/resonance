import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { CheckFilled, CloseFilled, FolderImageFilled, FolderMusicFilled, RefreshFilled, SettingsFilled } from '../icons'
import { useMusicStore } from '../../store/useMusicStore'
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  SHORTCUT_DEFINITIONS,
  formatShortcut,
  normalizeShortcutEvent,
  type ShortcutAction,
} from '../../utils/keyboardShortcuts.ts'

const SETTINGS_TABS = ['Shortcuts', 'Folders', 'Appearance'] as const
type SettingsTab = (typeof SETTINGS_TABS)[number]
type FolderAction = () => void | Promise<void>

type SettingsTabRect = { left: number; top: number; width: number; height: number }
type SettingsTabMotionState = {
  x0: number
  x1: number
  v0: number
  v1: number
  alpha: number
  rects: Array<SettingsTabRect | null>
  raf: number
  last: number
  initialized: boolean
}
type SettingsTabMotionEngine = { refresh: (snap?: boolean) => void; wake: () => void }

function SettingsTabNavigation({
  activeTab,
  onChange,
  reducedMotion,
}: {
  activeTab: SettingsTab
  onChange: (tab: SettingsTab) => void
  reducedMotion: boolean
}) {
  const navRef = useRef<HTMLElement | null>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const indicatorRef = useRef<HTMLSpanElement | null>(null)
  const inkRef = useRef<HTMLDivElement | null>(null)
  const activeIndexRef = useRef(SETTINGS_TABS.indexOf(activeTab))
  const reducedMotionRef = useRef(reducedMotion)
  const engineRef = useRef<SettingsTabMotionEngine | null>(null)
  activeIndexRef.current = SETTINGS_TABS.indexOf(activeTab)
  reducedMotionRef.current = reducedMotion

  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return undefined

    const state: SettingsTabMotionState = {
      x0: 0,
      x1: 0,
      v0: 0,
      v1: 0,
      alpha: 0,
      rects: [],
      raf: 0,
      last: 0,
      initialized: false,
    }
    let disposed = false

    const render = () => {
      const indicator = indicatorRef.current
      const ink = inkRef.current
      const activeRect = state.rects[activeIndexRef.current] ?? state.rects.find((rect): rect is SettingsTabRect => rect !== null)
      if (!indicator || !ink || !activeRect) return

      const width = Math.max(0, state.x1 - state.x0)
      indicator.style.width = String(width) + 'px'
      indicator.style.height = String(activeRect.height) + 'px'
      indicator.style.transform = 'translate3d(' + state.x0 + 'px, ' + activeRect.top + 'px, 0)'
      indicator.style.opacity = String(state.alpha)

      const navWidth = nav.clientWidth
      const navHeight = nav.clientHeight
      const left = Math.max(0, state.x0)
      const right = Math.max(0, navWidth - state.x1)
      const top = Math.max(0, activeRect.top)
      const bottom = Math.max(0, navHeight - activeRect.top - activeRect.height)
      const radius = getComputedStyle(nav).getPropertyValue('--settings-tab-radius').trim() || '9px'
      ink.style.clipPath = 'inset(' + top + 'px ' + right + 'px ' + bottom + 'px ' + left + 'px round ' + radius + ')'
    }

    const measure = (snap: boolean) => {
      const navRect = nav.getBoundingClientRect()
      const originLeft = navRect.left + nav.clientLeft
      const originTop = navRect.top + nav.clientTop
      state.rects = tabRefs.current.map((element) => {
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return {
          left: rect.left - originLeft,
          top: rect.top - originTop,
          width: rect.width,
          height: rect.height,
        }
      })

      const target = state.rects[activeIndexRef.current]
      if (!target) return
      if (!state.initialized || snap || reducedMotionRef.current) {
        state.x0 = target.left
        state.x1 = target.left + target.width
        state.v0 = 0
        state.v1 = 0
        state.alpha = 1
        state.initialized = true
      }
      render()
    }

    const tick = (now: number) => {
      state.raf = 0
      const target = state.rects[activeIndexRef.current]
      if (!target || disposed) return

      const dt = state.last ? Math.min(0.05, (now - state.last) / 1000) : 1 / 60
      state.last = now
      if (reducedMotionRef.current) {
        state.x0 = target.left
        state.x1 = target.left + target.width
        state.v0 = 0
        state.v1 = 0
        state.alpha = 1
      } else {
        const target0 = target.left
        const target1 = target.left + target.width
        const direction = Math.sign((target0 + target1) / 2 - (state.x0 + state.x1) / 2)
        const bounce = 0.3
        const stretch = 0.5
        const zeta = 1 - 0.55 * bounce
        const base = 520
        const lead = base * (1 + 0.9 * stretch)
        const trail = base * (1 - 0.5 * stretch)
        const k0 = direction < 0 ? lead : direction > 0 ? trail : base
        const k1 = direction > 0 ? lead : direction < 0 ? trail : base
        const steps = Math.ceil(dt / (1 / 240))
        const h = dt / steps
        for (let i = 0; i < steps; i++) {
          state.v0 += (-k0 * (state.x0 - target0) - 2 * zeta * Math.sqrt(k0) * state.v0) * h
          state.x0 += state.v0 * h
          state.v1 += (-k1 * (state.x1 - target1) - 2 * zeta * Math.sqrt(k1) * state.v1) * h
          state.x1 += state.v1 * h
        }
        state.alpha += (1 - state.alpha) * (1 - Math.exp(-dt / 0.06))
      }

      render()
      const busy =
        Math.abs(state.x0 - target.left) > 0.05 ||
        Math.abs(state.x1 - (target.left + target.width)) > 0.05 ||
        Math.abs(state.v0) > 0.5 ||
        Math.abs(state.v1) > 0.5 ||
        state.alpha < 0.999
      if (busy) state.raf = requestAnimationFrame(tick)
    }

    const wake = () => {
      if (!state.raf && !disposed) {
        state.last = 0
        state.raf = requestAnimationFrame(tick)
      }
    }

    const refresh = (snap = false) => measure(snap)
    engineRef.current = { refresh, wake }
    measure(true)

    const handleResize = () => measure(true)
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(handleResize) : null
    resizeObserver?.observe(nav)
    tabRefs.current.forEach((element) => {
      if (element) resizeObserver?.observe(element)
    })
    window.addEventListener('resize', handleResize)
    void document.fonts?.ready.then(() => {
      if (!disposed) handleResize()
    }).catch(() => {})

    return () => {
      disposed = true
      if (state.raf) cancelAnimationFrame(state.raf)
      resizeObserver?.disconnect()
      window.removeEventListener('resize', handleResize)
      if (engineRef.current?.refresh === refresh) engineRef.current = null
    }
  }, [])

  useLayoutEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    if (reducedMotion) engine.refresh(true)
    else engine.wake()
  }, [activeTab, reducedMotion])

  return (
    <nav ref={navRef} className="settings-tabs" aria-label="Settings sections">
      {SETTINGS_TABS.map((tab, index) => (
        <button
          key={tab}
          ref={(element) => {
            tabRefs.current[index] = element
          }}
          type="button"
          className={activeTab === tab ? 'settings-tab active' : 'settings-tab'}
          aria-pressed={activeTab === tab}
          onClick={() => onChange(tab)}
        >
          {tab}
        </button>
      ))}
      <span ref={indicatorRef} className="settings-tab-indicator" aria-hidden="true" />
      <div ref={inkRef} className="settings-tabs-ink" aria-hidden="true">
        {SETTINGS_TABS.map((tab) => <span key={tab}>{tab}</span>)}
      </div>
    </nav>
  )
}


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
  const prefersReducedMotion = useReducedMotion() ?? (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const modalCardRef = useRef<HTMLDivElement>(null)
  const heightAnimationCleanupRef = useRef<(() => void) | null>(null)
  const previousTabRef = useRef<SettingsTab>(activeTab)
  const [editingAction, setEditingAction] = useState<ShortcutAction | null>(null)
  const [shortcutError, setShortcutError] = useState<string | null>(null)
  const musicInputRef = useRef<HTMLInputElement>(null)
  const coverInputRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    const card = modalCardRef.current
    if (!card) return
    const changed = previousTabRef.current !== activeTab
    previousTabRef.current = activeTab
    if (!changed) return

    if (prefersReducedMotion) {
      heightAnimationCleanupRef.current?.()
      card.style.removeProperty('height')
      card.style.removeProperty('transition')
      return
    }

    let finished = false
    let observer: ResizeObserver | null = null

    const cleanup = () => {
      card.removeEventListener('transitionend', handleTransitionEnd)
      window.removeEventListener('resize', updateTargetHeight)
      observer?.disconnect()
      if (heightAnimationCleanupRef.current === cleanup) heightAnimationCleanupRef.current = null
    }
    const finish = () => {
      if (finished) return
      finished = true
      cleanup()
      card.style.height = 'auto'
      card.style.removeProperty('transition')
    }
    const content = card.querySelector('.settings-tab-content') as HTMLElement | null
    const footer = card.querySelector('.settings-modal-footer') as HTMLElement | null
    const getTargetHeight = () => {
      if (!content || !footer) {
        const borderAndScrollbar = Math.max(0, card.offsetHeight - card.clientHeight)
        return Math.min(card.scrollHeight + borderAndScrollbar, Math.floor(window.innerHeight * 0.9))
      }
      const cardRect = card.getBoundingClientRect()
      const contentRect = content.getBoundingClientRect()
      const footerRect = footer.getBoundingClientRect()
      const styles = getComputedStyle(card)
      const leadingChrome = contentRect.top - cardRect.top + card.scrollTop
      const trailingChrome =
        footerRect.bottom - contentRect.bottom +
        (Number.parseFloat(styles.paddingBottom) || 0) +
        (Number.parseFloat(styles.borderBottomWidth) || 0)
      return Math.min(Math.ceil(leadingChrome + content.scrollHeight + trailingChrome), Math.floor(window.innerHeight * 0.9))
    }
    const updateTargetHeight = () => {
      if (finished) return
      const targetHeight = getTargetHeight()
      const currentTarget = Number.parseFloat(card.style.height)
      if (!Number.isFinite(currentTarget) || Math.abs(targetHeight - currentTarget) > 1) {
        card.style.height = String(targetHeight) + 'px'
      }
    }
    const handleTransitionEnd = (event: TransitionEvent) => {
      if (event.target === card && event.propertyName === 'height') finish()
    }

    const startHeight = card.getBoundingClientRect().height
    card.style.transition = 'height 380ms cubic-bezier(0.22, 1, 0.36, 1)'
    const targetHeight = getTargetHeight()
    card.style.height = String(targetHeight) + 'px'
    card.addEventListener('transitionend', handleTransitionEnd)
    window.addEventListener('resize', updateTargetHeight)

    const activePanel = card.querySelector('.settings-panel')
    if (activePanel && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(updateTargetHeight)
      observer.observe(activePanel)
    }

    heightAnimationCleanupRef.current = cleanup
    if (Math.abs(targetHeight - startHeight) < 1) finish()

    return cleanup
  }, [activeTab, prefersReducedMotion])

  const changeTab = (tab: SettingsTab) => {
    if (tab === activeTab) return
    heightAnimationCleanupRef.current?.()
    const card = modalCardRef.current
    if (card && !prefersReducedMotion) {
      const currentHeight = card.getBoundingClientRect().height
      card.style.transition = 'none'
      card.style.height = String(currentHeight) + 'px'
      void card.offsetHeight
    } else if (card) {
      card.style.removeProperty('height')
      card.style.removeProperty('transition')
    }
    setActiveTab(tab)
  }

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
      <motion.div ref={modalCardRef} className="modal-card settings-modal-card" onClick={(event) => event.stopPropagation()}
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

        <SettingsTabNavigation activeTab={activeTab} onChange={changeTab} reducedMotion={prefersReducedMotion} />

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
