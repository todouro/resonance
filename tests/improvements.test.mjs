import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { findMissingTrackIds, isPathInside, normalizePathForCompare } from '../src/utils/missingTracks.ts'
import { shouldIgnoreShortcut } from '../src/utils/shortcutGuard.ts'
import { DEFAULT_KEYBOARD_SHORTCUTS, formatShortcut, matchesKeyboardShortcut, normalizeShortcutBinding, sanitizeKeyboardShortcutBindings } from '../src/utils/keyboardShortcuts.ts'
import { createLibrarySaver } from '../src/utils/desktopDatabase.ts'
import { pruneOrphanArtwork, referencedArtworkNames, statFingerprint } from '../src/utils/artworkStorage.ts'

const DAY = 24 * 60 * 60 * 1000
const track = (id, filePath, extra = {}) => ({ id, title: id, artist: '', album: '', duration: 0, fileName: id, accent: '#000', filePath, ...extra })

// ---------- missing tracks ----------
test('path comparison ignores case and separator style on Windows paths', () => {
  assert.equal(normalizePathForCompare('C:\\Music\\Song.MP3'), 'c:/music/song.mp3')
  assert.ok(isPathInside('C:\\Music\\Rock\\a.mp3', 'c:/music'))
  assert.ok(isPathInside('c:/music/a.mp3', 'C:\\Music\\'))
})

test('a sibling folder with the same prefix is not "inside" the music folder', () => {
  assert.equal(isPathInside('C:\\Music2\\a.mp3', 'C:\\Music'), false)
})

test('only tracks inside the scanned folder that were not found are reported missing', () => {
  const tracks = [
    track('kept', 'C:\\Music\\kept.mp3'),
    track('gone', 'C:\\Music\\Rock\\gone.mp3'),
    track('moved-case', 'C:\\Music\\Same.mp3'),
    track('elsewhere', 'D:\\Other\\elsewhere.mp3'),
    track('no-path', undefined),
  ]
  const scanned = ['c:/music/kept.mp3', 'C:\\MUSIC\\same.mp3']
  assert.deepEqual(findMissingTrackIds(tracks, scanned, 'C:\\Music'), ['gone'])
})

// ---------- keyboard guard ----------
const key = (overrides = {}) => ({
  key: 'm', code: 'KeyM', ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false,
  target: { tagName: 'DIV', isContentEditable: false, closest: () => null }, ...overrides,
})

test('plain keys on the page trigger shortcuts', () => {
  assert.equal(shouldIgnoreShortcut(key()), false)
})

test('browser/OS combinations are never hijacked', () => {
  for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
    assert.equal(shouldIgnoreShortcut(key({ key: 'r', code: 'KeyR', [mod]: true })), true, mod)
  }
})

test('typing in fields and already-handled keys are ignored', () => {
  assert.equal(shouldIgnoreShortcut(key({ target: { tagName: 'INPUT', closest: () => null } })), true)
  assert.equal(shouldIgnoreShortcut(key({ target: { tagName: 'DIV', isContentEditable: true, closest: () => null } })), true)
  assert.equal(shouldIgnoreShortcut(key({ defaultPrevented: true })), true)
})

test('Space on a focused button keeps its native meaning but still plays elsewhere', () => {
  const onButton = { tagName: 'BUTTON', closest: (sel) => (sel.includes('button') ? {} : null) }
  assert.equal(shouldIgnoreShortcut(key({ key: ' ', code: 'Space', target: onButton })), true)
  assert.equal(shouldIgnoreShortcut(key({ key: ' ', code: 'Space' })), false)
  // other keys are still allowed while a button has focus
  assert.equal(shouldIgnoreShortcut(key({ target: onButton })), false)
})

test('dialogs and menus keep their own keyboard handling', () => {
  const inDialog = { tagName: 'DIV', closest: (sel) => (sel.includes('dialog') ? {} : null) }
  assert.equal(shouldIgnoreShortcut(key({ key: 'ArrowDown', code: 'ArrowDown', target: inDialog })), true)
})

test('hardware media keys always work, even inside fields or with modifiers', () => {
  const input = { tagName: 'INPUT', closest: () => ({}) }
  assert.equal(shouldIgnoreShortcut(key({ key: 'MediaTrackNext', code: 'MediaTrackNext', target: input })), false)
})

// ---------- atomic, serialized library saves ----------
function fakeFs({ failRename = false, failWriteOnce = false, delay = 0 } = {}) {
  const log = []
  let writing = 0
  let maxConcurrent = 0
  let failedAlready = false
  return {
    log,
    get maxConcurrent() { return maxConcurrent },
    ensureAppDataDir: async () => { log.push('ensure') },
    writeText: async (name, text) => {
      writing += 1
      maxConcurrent = Math.max(maxConcurrent, writing)
      if (delay) await new Promise((r) => setTimeout(r, delay))
      writing -= 1
      if (failWriteOnce && !failedAlready) { failedAlready = true; throw new Error('disk full') }
      log.push(`write:${name}:${text}`)
    },
    rename: async (from, to) => {
      if (failRename) throw new Error('locked')
      log.push(`rename:${from}->${to}`)
    },
  }
}

test('a save writes the temp file first and only then renames it over the library', async () => {
  const fs = fakeFs()
  await createLibrarySaver(fs)('{"v":1}')
  const writes = fs.log.filter((l) => l.startsWith('write:')).map((l) => l.split(':')[1])
  assert.equal(writes.length, 1)
  assert.match(writes[0], /\.tmp$/) // the real file is never written directly
  assert.ok(fs.log.indexOf(`write:${writes[0]}:{"v":1}`) < fs.log.findIndex((l) => l.startsWith('rename:')))
})

test('if the rename fails, the library is still saved directly', async () => {
  const fs = fakeFs({ failRename: true })
  await createLibrarySaver(fs)('{"v":2}')
  assert.ok(fs.log.some((l) => l.startsWith('write:') && !l.includes('.tmp') && l.endsWith('{"v":2}')))
})

test('concurrent saves never overlap and are applied in order', async () => {
  const fs = fakeFs({ delay: 15 })
  const save = createLibrarySaver(fs)
  await Promise.all([save('1'), save('2'), save('3')])
  assert.equal(fs.maxConcurrent, 1)
  const tempWrites = fs.log.filter((l) => l.startsWith('write:') && l.includes('.tmp')).map((l) => l.split(':').pop())
  assert.deepEqual(tempWrites, ['1', '2', '3'])
})

test('one failed save is reported but does not break later saves', async () => {
  const fs = fakeFs({ failWriteOnce: true })
  const warnings = []
  const save = createLibrarySaver(fs, (message) => warnings.push(message))
  await save('first') // fails
  await save('second') // must still work
  assert.equal(warnings.length, 1)
  assert.ok(fs.log.some((l) => l.endsWith(':second')))
})

// ---------- artwork cache ----------
test('stat fingerprint changes when size or modified time changes, and is stable otherwise', () => {
  assert.equal(statFingerprint(100, 5000), statFingerprint(100, 5000))
  assert.notEqual(statFingerprint(100, 5000), statFingerprint(101, 5000))
  assert.notEqual(statFingerprint(100, 5000), statFingerprint(100, 5001))
})

test('referenced artwork names are read from paths and Windows asset URLs, ignoring temporary URLs', () => {
  const names = referencedArtworkNames(
    [
      { coverPath: 'C:\\Users\\me\\AppData\\Roaming\\app\\artwork\\Folder_A_1f.JPG' },
      { coverUrl: 'http://asset.localhost/C%3A%5CUsers%5Cme%5Cartwork%5Cpool_b.png?x=1' },
      { coverUrl: 'blob:http://localhost/abc' },
      { coverUrl: 'data:image/png;base64,AAAA' },
      {},
    ],
    ['C:\\x\\artwork\\extra.webp'],
  )
  assert.deepEqual([...names].sort(), ['extra.webp', 'folder_a_1f.jpg', 'pool_b.png'])
})

function pruneDeps(files) {
  const removed = []
  return {
    removed,
    listFiles: async () => Object.keys(files),
    modifiedAt: async (name) => files[name],
    remove: async (name) => { removed.push(name) },
  }
}

test('cleanup removes only old, unreferenced artwork', async () => {
  const now = 100 * DAY
  const deps = pruneDeps({
    'used-old.jpg': now - 90 * DAY, // referenced -> keep
    'orphan-old.jpg': now - 90 * DAY, // unreferenced + old -> remove
    'orphan-new.jpg': now - 2 * DAY, // unreferenced but recent -> keep
    'unknown-mtime.jpg': null, // cannot tell how old -> keep
  })
  const count = await pruneOrphanArtwork(new Set(['used-old.jpg']), deps, now)
  assert.equal(count, 1)
  assert.deepEqual(deps.removed, ['orphan-old.jpg'])
})

test('cleanup is case-insensitive about references and survives a missing folder or a failing delete', async () => {
  const now = 100 * DAY
  const deps = pruneDeps({ 'Used.JPG': now - 90 * DAY })
  assert.equal(await pruneOrphanArtwork(new Set(['used.jpg']), deps, now), 0)

  const noFolder = { listFiles: async () => { throw new Error('ENOENT') }, modifiedAt: async () => 0, remove: async () => {} }
  assert.equal(await pruneOrphanArtwork(new Set(), noFolder, now), 0)

  const flaky = {
    listFiles: async () => ['a.jpg', 'b.jpg'],
    modifiedAt: async () => now - 90 * DAY,
    remove: async (name) => { if (name === 'a.jpg') throw new Error('in use') },
  }
  assert.equal(await pruneOrphanArtwork(new Set(), flaky, now), 1) // b.jpg still removed
})


test('custom shortcut bindings normalize safely and format for the settings UI', () => {
  assert.equal(normalizeShortcutBinding('ctrl+alt+shift+KeyK'), 'Ctrl+Alt+Shift+KeyK')
  assert.equal(normalizeShortcutBinding('KeyM'), 'KeyM')
  assert.equal(normalizeShortcutBinding('Ctrl+KeyR'), null)
  assert.equal(normalizeShortcutBinding('Ctrl+Shift+KeyN'), null)
  assert.equal(normalizeShortcutBinding('Alt+ArrowLeft'), null)
  assert.equal(normalizeShortcutBinding('KeyThatDoesNotExist'), null)
  assert.equal(formatShortcut('ArrowLeft'), '←')
  assert.equal(formatShortcut('Ctrl+Alt+Shift+KeyK'), 'Ctrl+Alt+Shift+K')
})

test('shortcut matching respects modifiers and keeps default playback bindings', () => {
  assert.equal(matchesKeyboardShortcut(key({ key: 'm', code: 'KeyM' }), DEFAULT_KEYBOARD_SHORTCUTS.toggleMute), true)
  assert.equal(matchesKeyboardShortcut(key({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true, shiftKey: true }), 'Ctrl+Alt+Shift+KeyK'), true)
  assert.equal(matchesKeyboardShortcut(key({ key: 'k', code: 'KeyK' }), 'Ctrl+Alt+Shift+KeyK'), false)
  assert.equal(DEFAULT_KEYBOARD_SHORTCUTS.togglePlay, 'Space')
  assert.equal(DEFAULT_KEYBOARD_SHORTCUTS.previous, 'MediaTrackPrevious')
})

test('persisted shortcut preferences are sanitized and duplicate bindings are reset safely', () => {
  const saved = sanitizeKeyboardShortcutBindings({
    ...DEFAULT_KEYBOARD_SHORTCUTS,
    togglePlay: 'KeyM',
    toggleMute: 'KeyM',
    cycleRepeat: 'Ctrl+KeyR',
  })
  assert.equal(new Set(Object.values(saved)).size, Object.values(saved).length)
  assert.equal(saved.cycleRepeat, DEFAULT_KEYBOARD_SHORTCUTS.cycleRepeat)
})

test('UI typography tokens and form controls stay consistent across screens', () => {
  const globalStyles = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
  const styles = fs.readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
  const downloads = fs.readFileSync(new URL('../src/components/DownloadSection.tsx', import.meta.url), 'utf8')

  // Space Grotesk remains the single UI family; fields and controls share established sizes.
  assert.match(globalStyles, /--font-ui:\s*"Space Grotesk"/)
  assert.match(globalStyles, /font-family:\s*var\(--font-ui\)/)
  assert.match(globalStyles, /--font-size-field:\s*15px;/)
  assert.match(globalStyles, /--font-size-control:\s*13px;/)
  assert.match(globalStyles, /--radius-control:\s*12px;/)
  assert.match(globalStyles, /--radius-control-compact:\s*10px;/)

  assert.match(styles, /\.playlist-form input,[\s\S]*?\.download-url-textarea\s*\{\s*font-family:\s*var\(--font-ui\);\s*font-size:\s*var\(--font-size-field\);/)
  assert.match(styles, /\.form-group input\s*\{[\s\S]*?border-radius:\s*var\(--radius-control\);/)
  assert.match(styles, /\.download-format-wrap select\s*\{[\s\S]*?appearance:\s*none;[\s\S]*?-webkit-appearance:\s*none;/)
  assert.match(styles, /\.download-format-wrap:focus-within\s*\{[\s\S]*?box-shadow:\s*0 0 0 3px var\(--focus-ring\);/)
  assert.match(styles, /button:focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--lime/)

  // Keep a single base rule for each Downloads field, rather than competing old/new overrides.
  assert.equal([...styles.matchAll(/\.download-url-input\s*\{/g)].length, 1)
  assert.equal([...styles.matchAll(/\.download-format-wrap\s*\{/g)].length, 1)
  assert.match(downloads, /<ChevronDown size=\{15\} className="download-format-chevron" aria-hidden="true" \/>/)
})

test('Sidebar starts with navigation and uses compact, separated playlist groups', () => {
  const sidebar = fs.readFileSync(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8')
  const styles = fs.readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')

  assert.doesNotMatch(sidebar, /className="brand(?:-mark|-logo)?"/)
  assert.doesNotMatch(sidebar, /<strong>Resonance<\/strong>|Local library|resonance-logo\.png/)
  assert.match(sidebar, /<aside[\s\S]*?className="sidebar"[\s\S]*?<nav className="nav-stack"/)
  assert.match(sidebar, /nav-favorites-item/)
  assert.match(sidebar, /nav-section-heading">Your Playlists/)
  assert.match(sidebar, /nav-playlist-color/)
  assert.match(sidebar, /userPlaylists = playlists.filter/)
  assert.match(styles, /\.nav-section-heading\s*\{/)
  assert.match(styles, /\.nav-playlist-color\s*\{/)
})
