# Resonance

A polished local-first music player for your browser and Windows desktop.

Resonance is designed for people who want a clean, focused listening experience without handing their library over to a cloud service. It keeps your music local, supports deep library management, playlist curation, embedded metadata, and a fast desktop experience built with React, TypeScript, and Tauri.

## Highlights

- Local-first music library management for your own audio files
- Smart music-folder scanning and rescans
- Playlist creation, favorites, and quick search
- Editable track metadata and cover management
- Desktop-quality playback with Tauri on Windows
- Browser support for lightweight local listening
- Built-in download workflow for saving audio into your Music folder
- Modern UI with animated player controls and responsive layout

## Features

### Music library
- Add songs or entire music folders
- Automatically detect and organize tracks from local folders
- Rescan folders to keep the library up to date
- Search by song, artist, or album
- Track totals and total playtime at a glance

### Playback and management
- Play, pause, skip, repeat, shuffle, and volume controls
- Favorites playlist support
- Playlist actions including rename, delete, and add tracks
- Keyboard shortcuts for efficient playback control
- Metadata editing for track details

### Desktop experience
- Windows desktop app built with Tauri
- AppData-backed local storage for library and playback preferences
- Local cover art handling and durable references
- Built-in setup flow for choosing music and cover folders

### Download tools
- Save audio into your Music folder with yt-dlp integration
- Progress and cancel support for downloads
- First-run setup to bootstrap required tooling securely
- Audio conversion support for common formats including MP3, M4A, Opus, FLAC, and WAV

## Tech stack

- React 19
- TypeScript
- Vite
- Zustand
- Howler.js
- Framer Motion
- Tauri 2
- Rust backend support for desktop integration

## Requirements

- Node.js 22.12 or later (Node.js 24 LTS recommended)
- npm
- For Windows desktop builds: Rust stable toolchain and Microsoft Visual Studio C++ Build Tools

## Quick start

Clone the repository and install dependencies:

```bash
git clone https://github.com/todouro/resonance.git
cd resonance
npm install
```

Run the app locally in the browser:

```bash
npm run dev
```

The development server runs on http://localhost:3000 by default. If you want to expose it on a trusted network, run:

```bash
npm run dev -- --host 0.0.0.0
```

Use this only on a trusted network and avoid permissive host settings for convenience.

## Production and build commands

Run tests, lint, and a production build:

```bash
npm test
npm run lint
npm run build
npm run preview
```

Build the Windows installer with Tauri:

```bash
npm run tauri:build:win
```

The generated installer is output to the Tauri bundle directory in the project target folder.

## Notes on local file playback

- In the browser build, imported audio is only available while the browser can access the imported file references.
- For a durable desktop experience, use the Windows app, which stores library state in the app's local user data directory.
- Some audio formats rely on browser or OS decoder support. If a format cannot play, check compatibility and the platform-specific setup requirements.

## Contributing

Contributions are welcome. Please work on a feature branch and submit a focused pull request with the relevant changes.

Before opening a PR, run:

```bash
npm test
npm run lint
npm run build
```

Also verify keyboard and pointer interactions in the app flow you changed.

## License

This project is distributed under the repository's existing license terms. Please check the repository for the current license file.

## Project status

Resonance is a polished local music player focused on simplicity, ownership of your library, and a premium personal listening experience on the desktop and in the browser.
