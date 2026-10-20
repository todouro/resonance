import { Download } from 'lucide-react'
import {
  DiscFilled,
  HeartFilled,
  PlaylistFilled,
  PlusFilled,
  SettingsFilled,
} from './icons'
import { favoritesId, libraryId } from '../store/useMusicStore'
import type { Playlist, Track } from '../types'
import { PlaylistActionMenu } from './PlaylistActionMenu'

export type SidebarProps = {
  activePlaylistId: string
  playlists: Playlist[]
  tracks: Track[]
  playlistName: string
  setPlaylistName: (name: string) => void
  onSelect: (playlistId: string) => void
  onCreate: () => void
  onRenamePlaylist: (playlist: Playlist) => void
  onDeletePlaylist: (playlist: Playlist) => void
  onOpenAddToPlaylist?: (playlist: Playlist) => void
  onOpenSettings?: () => void
  isDownloadsActive?: boolean
  onOpenDownloads?: () => void
  autoHideEnabled?: boolean
  onAutoHideEnter?: () => void
  onAutoHideLeave?: () => void
}

export function Sidebar({
  activePlaylistId,
  playlists,
  tracks,
  playlistName,
  setPlaylistName,
  onSelect,
  onCreate,
  onRenamePlaylist,
  onDeletePlaylist,
  onOpenAddToPlaylist,
  onOpenSettings,
  isDownloadsActive = false,
  onOpenDownloads,
  autoHideEnabled = false,
  onAutoHideEnter,
  onAutoHideLeave,
}: SidebarProps) {
  return (
    <aside className="sidebar" onMouseEnter={autoHideEnabled ? onAutoHideEnter : undefined} onMouseLeave={autoHideEnabled ? onAutoHideLeave : undefined}>
      <div className="brand">
        <div className="brand-mark">
          <img className="brand-logo" src="/resonance-logo.png" alt="" />
        </div>
      </div>

      <nav className="nav-stack" aria-label="Music sections">
        <button
          className={activePlaylistId === libraryId ? 'nav-item active' : 'nav-item'}
          type="button"
          onClick={() => onSelect(libraryId)}
        >
          <DiscFilled size={18} />
          <span>All Songs</span>
          <em>{tracks.length}</em>
        </button>
        {playlists.map((playlist) => (
          <div
            key={playlist.id}
            className={`nav-item nav-playlist-item ${activePlaylistId === playlist.id ? 'active' : ''}`}
            onClick={() => onSelect(playlist.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault()
                onSelect(playlist.id)
              }
            }}
          >
            {playlist.id === favoritesId ? <HeartFilled size={18} /> : <PlaylistFilled size={18} />}
            <span className="nav-playlist-name">{playlist.name}</span>
            <em>{playlist.trackIds.length}</em>
            <div className="nav-item-actions">
              <PlaylistActionMenu
                playlist={playlist}
                onAddToPlaylist={onOpenAddToPlaylist}
                onRenamePlaylist={onRenamePlaylist}
                onDeletePlaylist={onDeletePlaylist}
              />
            </div>
          </div>
        ))}
        <form
          className="nav-item playlist-form"
          onSubmit={(event) => {
            event.preventDefault()
            onCreate()
          }}
        >
          <PlaylistFilled size={18} className="playlist-form-icon" />
          <input
            value={playlistName}
            onChange={(event) => setPlaylistName(event.target.value)}
            placeholder="New playlist"
            aria-label="New playlist name"
          />
          <button
            type="submit"
            aria-label="Create playlist"
            className="playlist-add-btn"
            title="Create playlist"
          >
            <PlusFilled size={14} />
          </button>
        </form>


        <button
          type="button"
          className={`nav-item ${isDownloadsActive ? 'active' : ''}`}
          title="Download audio with yt-dlp"
          aria-current={isDownloadsActive ? 'page' : undefined}
          onClick={onOpenDownloads}
        >
          <Download size={18} />
          <span>Downloads</span>
        </button>

        <div className="sidebar-divider" role="separator" />

        <button
          type="button"
          className="nav-item nav-settings-btn"
          title="Open settings"
          aria-label="Settings"
          onClick={onOpenSettings}
        >
          <SettingsFilled size={18} />
          <span>Settings</span>
        </button>

      </nav>
    </aside>
  )
}

export default Sidebar
