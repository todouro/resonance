mod runner;
mod util;

use serde::Serialize;
use serde_json::Value;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_fs::FsExt;
use util::{installer_error, last_line, validate_url, Progress, PROGRESS_PREFIX};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How often the private yt-dlp copy checks for a newer release (sites change; old builds break).
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const UPDATE_MARKER: &str = "yt-dlp.update-check";

// Serialises tool installs/updates so two simultaneous commands never race on the same files.
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

// Downloads yt-dlp and refuses to install it unless its SHA-256 matches the checksum file
// published with the same release. The output path is passed through an environment
// variable (never interpolated into the script) so odd characters in a path cannot alter it.
const INSTALL_SCRIPT: &str = r#"$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$base='https://github.com/yt-dlp/yt-dlp/releases/latest/download/'
$out=$env:RESONANCE_YTDLP_OUT; $tmp=$out+'.download'; $sumsFile=$out+'.sums'
try {
  Invoke-WebRequest -UseBasicParsing -Uri ($base+'yt-dlp.exe') -OutFile $tmp
  # GitHub serves the checksum list as application/octet-stream, which PowerShell returns as
  # raw bytes rather than text, so save it to disk and read it back as lines.
  Invoke-WebRequest -UseBasicParsing -Uri ($base+'SHA2-256SUMS') -OutFile $sumsFile
  $line=(Get-Content -LiteralPath $sumsFile | Where-Object { $_ -match '^[0-9a-fA-F]{64}\s+\*?yt-dlp\.exe\s*$' } | Select-Object -First 1)
  if (-not $line) { throw 'Could not find the published yt-dlp checksum.' }
  $expected=($line.Trim() -split '\s+')[0].ToLower()
  $actual=(Get-FileHash -Algorithm SHA256 -LiteralPath $tmp).Hash.ToLower()
  if ($expected -ne $actual) { throw 'Checksum mismatch: the download was rejected.' }
  Move-Item -Force -LiteralPath $tmp -Destination $out
} catch { [Console]::Error.WriteLine('RESONANCE_ERROR: ' + $_.Exception.Message); throw
} finally { foreach ($f in @($tmp, $sumsFile)) { if (Test-Path -LiteralPath $f) { Remove-Item -Force -LiteralPath $f } } }"#;

// Same idea for ffmpeg (needed by yt-dlp for MP3/M4A/Opus/FLAC/WAV conversion): the zip is
// verified against the checksum list published with the release before anything is unpacked.
const FFMPEG_INSTALL_SCRIPT: &str = r#"$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression.FileSystem
$base='https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/'
$name='ffmpeg-master-latest-win64-gpl.zip'
$dest=$env:RESONANCE_FFMPEG_DIR; $work=$dest+'.work'
if (Test-Path -LiteralPath $work) { Remove-Item -Recurse -Force -LiteralPath $work }
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
  $zip=Join-Path $work $name
  Invoke-WebRequest -UseBasicParsing -Uri ($base+$name) -OutFile $zip
  $sumsFile=Join-Path $work 'checksums.sha256'
  Invoke-WebRequest -UseBasicParsing -Uri ($base+'checksums.sha256') -OutFile $sumsFile
  $line=(Get-Content -LiteralPath $sumsFile | Where-Object { $_ -match ('^[0-9a-fA-F]{64}\s+\*?'+[regex]::Escape($name)+'\s*$') } | Select-Object -First 1)
  if (-not $line) { throw 'Could not find the published ffmpeg checksum.' }
  $expected=($line.Trim() -split '\s+')[0].ToLower()
  $actual=(Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
  if ($expected -ne $actual) { throw 'Checksum mismatch: the ffmpeg download was rejected.' }
  $unzipped=Join-Path $work 'unzipped'
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $unzipped)
  $ffmpeg=Get-ChildItem -Path $unzipped -Recurse -Filter ffmpeg.exe | Select-Object -First 1
  if (-not $ffmpeg) { throw 'ffmpeg.exe was not found in the download.' }
  $ffprobe=Join-Path $ffmpeg.DirectoryName 'ffprobe.exe'
  if (-not (Test-Path -LiteralPath $ffprobe)) { throw 'ffprobe.exe was not found in the download.' }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item -Force -LiteralPath $ffmpeg.FullName -Destination (Join-Path $dest 'ffmpeg.exe')
  Copy-Item -Force -LiteralPath $ffprobe -Destination (Join-Path $dest 'ffprobe.exe')
} catch { [Console]::Error.WriteLine('RESONANCE_ERROR: ' + $_.Exception.Message); throw
} finally { if (Test-Path -LiteralPath $work) { Remove-Item -Recurse -Force -LiteralPath $work } }"#;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    /// "preparing" while tools are installed/updated, "downloading" while yt-dlp reports progress.
    stage: &'static str,
    percent: Option<f64>,
    speed: String,
    eta: String,
    message: String,
}

fn emit_progress(app: &tauri::AppHandle, stage: &'static str, message: &str, progress: Option<&Progress>) {
    let payload = DownloadProgress {
        stage,
        percent: progress.and_then(|p| p.percent),
        speed: progress.map(|p| p.speed.clone()).unwrap_or_default(),
        eta: progress.map(|p| p.eta.clone()).unwrap_or_default(),
        message: message.to_string(),
    };
    let _ = app.emit("download-progress", payload);
}

/// Builds a Command that never flashes a console window on Windows.
fn new_command<S: AsRef<OsStr>>(program: S) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn command_works<S: AsRef<OsStr>>(program: S) -> bool {
    new_command(program)
        .arg("-version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn tools_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir()
        .map_err(|error| format!("Could not locate Resonance's app data folder: {error}"))?;
    let tools = app_data.join("tools");
    fs::create_dir_all(&tools)
        .map_err(|error| format!("Could not prepare the downloader folder: {error}"))?;
    Ok(tools)
}

/// Checks (at most weekly) for a newer yt-dlp. Only used for Resonance's private copy; a
/// yt-dlp the user installed themselves is never modified. Best effort: failures are ignored.
fn maybe_update_yt_dlp(executable: &Path, tools: &Path) {
    let marker = tools.join(UPDATE_MARKER);
    let due = fs::metadata(&marker)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .map(|age| age > UPDATE_CHECK_INTERVAL)
        .unwrap_or(true);
    if !due {
        return;
    }
    // Write the marker first so being offline doesn't retry on every single download.
    let _ = fs::write(&marker, b"");
    let _ = new_command(executable).arg("-U").output();
}

fn yt_dlp_executable(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Prefer a normal installation if the user already has yt-dlp on PATH.
    if new_command("yt-dlp").arg("--version").output().map(|o| o.status.success()).unwrap_or(false) {
        return Ok(PathBuf::from("yt-dlp"));
    }

    // Otherwise, keep a private copy in Resonance's app data directory and
    // install it automatically on first use.
    let tools = tools_dir(app)?;
    let executable = tools.join("yt-dlp.exe");
    if executable.is_file() {
        if let Ok(_guard) = INSTALL_LOCK.lock() {
            maybe_update_yt_dlp(&executable, &tools);
        }
        return Ok(executable);
    }

    let _guard = INSTALL_LOCK.lock().map_err(|_| "The downloader installer is unavailable.".to_string())?;
    if executable.is_file() {
        return Ok(executable); // another command finished the install while we waited
    }

    emit_progress(app, "preparing", "Setting up the downloader (one-time)…", None);
    let result = new_command("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", INSTALL_SCRIPT])
        .env("RESONANCE_YTDLP_OUT", &executable)
        .output()
        .map_err(|error| format!("Resonance could not download yt-dlp automatically: {error}. Check your internet connection and try again."))?;

    if !result.status.success() || !executable.is_file() {
        let _ = fs::remove_file(&executable);
        let detail = installer_error(&result.stderr, "The download did not complete.");
        return Err(format!("Resonance could not install yt-dlp automatically: {detail} Check your internet connection and try again."));
    }

    let _ = fs::write(tools.join(UPDATE_MARKER), b""); // freshly installed = up to date
    Ok(executable)
}

/// Returns the folder to pass to `--ffmpeg-location`, or None when ffmpeg is already on PATH.
/// Installs a verified private copy the first time a format conversion is requested.
fn ffmpeg_location(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    if command_works("ffmpeg") && command_works("ffprobe") {
        return Ok(None);
    }

    let dir = tools_dir(app)?.join("ffmpeg");
    let ready = |path: &Path| path.join("ffmpeg.exe").is_file() && path.join("ffprobe.exe").is_file();
    if ready(&dir) {
        return Ok(Some(dir));
    }

    let _guard = INSTALL_LOCK.lock().map_err(|_| "The ffmpeg installer is unavailable.".to_string())?;
    if ready(&dir) {
        return Ok(Some(dir));
    }

    emit_progress(
        app,
        "preparing",
        "Setting up audio conversion (one-time download, about 200 MB)…",
        None,
    );
    let result = new_command("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", FFMPEG_INSTALL_SCRIPT])
        .env("RESONANCE_FFMPEG_DIR", &dir)
        .output()
        .map_err(|error| format!("Resonance could not download ffmpeg automatically: {error}."))?;

    if !result.status.success() || !ready(&dir) {
        let _ = fs::remove_dir_all(&dir);
        let detail = installer_error(&result.stderr, "The download did not complete.");
        return Err(format!(
            "Resonance could not set up audio conversion: {detail} Check your connection, or choose \"Best available audio\", which needs no conversion."
        ));
    }
    Ok(Some(dir))
}

fn run_download(app: tauri::AppHandle, url: String, output_path: PathBuf, format: String) -> Result<String, String> {
    emit_progress(&app, "preparing", "Preparing…", None);
    let executable = yt_dlp_executable(&app)?;
    let ffmpeg = if format == "best" { None } else { ffmpeg_location(&app)? };

    // Partial files go to a private temp folder, never into the user's Music folder, so a
    // cancelled or failed download leaves nothing behind there.
    let temp_dir = tools_dir(&app)?.join("tmp");
    let _ = fs::remove_dir_all(&temp_dir);
    fs::create_dir_all(&temp_dir).map_err(|error| format!("Could not prepare a temporary folder: {error}"))?;

    let mut command = new_command(executable);
    command
        .arg("--no-warnings")
        .arg("--no-playlist")
        .arg("--newline")
        .arg("--progress")
        .arg("--progress-template")
        .arg(format!(
            "download:{PROGRESS_PREFIX}%(progress.status)s|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s"
        ))
        .arg("--socket-timeout")
        .arg("30")
        .arg("--print")
        .arg("after_move:filepath")
        .arg("-P")
        .arg(&output_path)
        .arg("-P")
        .arg(format!("temp:{}", temp_dir.display()))
        .arg("-o")
        .arg("%(title)s.%(ext)s")
        .arg("-f")
        .arg("bestaudio/best");

    if format != "best" {
        command
            .arg("-x")
            .arg("--audio-format")
            .arg(&format)
            .arg("--audio-quality")
            .arg("0")
            .arg("--embed-metadata");
        if let Some(dir) = &ffmpeg {
            command.arg("--ffmpeg-location").arg(dir);
        }
    }

    // `--` guarantees the URL can never be parsed as an option.
    command.arg("--").arg(&url);

    let handle = app.clone();
    let on_progress: runner::ProgressCallback =
        Arc::new(move |progress| emit_progress(&handle, "downloading", "", Some(&progress)));
    let output = runner::run_with_progress(command, on_progress)
        .map_err(|error| format!("Could not start yt-dlp: {error}"));
    let _ = fs::remove_dir_all(&temp_dir);
    let output = output?;

    if output.cancelled {
        return Err("Download cancelled.".into());
    }
    if !output.success {
        let detail = output
            .stderr
            .iter()
            .rev()
            .find(|line| !line.trim().is_empty())
            .map(|line| line.trim().to_string())
            .unwrap_or_else(|| "yt-dlp could not download this URL.".to_string());
        return Err(format!("Download failed: {detail}"));
    }

    let saved_path = output
        .stdout
        .iter()
        .rev()
        .map(|line| line.trim())
        .find(|line| !line.is_empty() && Path::new(line).is_absolute())
        .unwrap_or("");

    if saved_path.is_empty() {
        return Err("yt-dlp finished, but Resonance could not identify the saved file path.".into());
    }
    Ok(saved_path.to_string())
}

// These commands are `async` and do their blocking work on a worker thread. Synchronous
// Tauri commands run on the main thread, which froze the whole window during downloads.
#[tauri::command]
async fn download_audio(
    app: tauri::AppHandle,
    url: String,
    output_dir: String,
    format: String,
) -> Result<String, String> {
    let url = validate_url(&url)?;

    let output_path = PathBuf::from(&output_dir);
    if !output_path.is_dir() {
        return Err("Your selected Music folder is unavailable. Choose the folder again in Resonance.".into());
    }
    // Only save into folders the user granted through the folder picker (or AppData), so a
    // compromised web view cannot use this command to write files anywhere on disk.
    if !app.fs_scope().is_allowed(&output_path) {
        return Err("Resonance doesn't have access to that folder. Choose your Music folder again.".into());
    }

    let allowed_formats = ["best", "mp3", "m4a", "opus", "flac", "wav"];
    if !allowed_formats.contains(&format.as_str()) {
        return Err("That audio format is not supported.".into());
    }

    tauri::async_runtime::spawn_blocking(move || run_download(app, url, output_path, format))
        .await
        .map_err(|error| format!("The download task stopped unexpectedly: {error}"))?
}


fn normalized_match_words(value: &str) -> Vec<String> {
    let normalized = value
        .chars()
        .flat_map(|character| character.to_lowercase())
        .map(|character| if character.is_alphanumeric() { character } else { ' ' })
        .collect::<String>();
    normalized.split_whitespace().map(str::to_string).collect()
}

fn word_overlap_ratio(wanted: &str, candidate: &str) -> f64 {
    let wanted_words: Vec<String> = normalized_match_words(wanted)
        .into_iter()
        .filter(|word| word.chars().count() > 2)
        .collect();
    if wanted_words.is_empty() {
        return 0.0;
    }
    let candidate_words = normalized_match_words(candidate);
    let overlap = wanted_words
        .iter()
        .filter(|word| candidate_words.contains(word))
        .count();
    overlap as f64 / wanted_words.len() as f64
}

fn supported_youtube_url(candidate: &Value) -> Option<String> {
    let raw_url = candidate
        .get("webpage_url")
        .or_else(|| candidate.get("webpageUrl"))
        .or_else(|| candidate.get("original_url"))
        .or_else(|| candidate.get("url"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let accepted = |url: &str| {
        url.starts_with("https://www.youtube.com/watch?")
            || url.starts_with("https://youtube.com/watch?")
            || url.starts_with("https://music.youtube.com/watch?")
            || url.starts_with("https://m.youtube.com/watch?")
            || url.starts_with("https://youtu.be/")
    };
    if accepted(raw_url) {
        return Some(raw_url.to_string());
    }

    let id = candidate.get("id").and_then(Value::as_str).unwrap_or("");
    let extractor = candidate
        .get("extractor_key")
        .or_else(|| candidate.get("extractor"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if !id.is_empty()
        && id.chars().all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '-')
        && (extractor.contains("youtube") || raw_url.is_empty() || !raw_url.starts_with("http"))
    {
        return Some(format!("https://www.youtube.com/watch?v={id}"));
    }
    None
}

fn score_spotify_audio_candidate(title: &str, artist: &str, candidate: &Value) -> Option<(i32, String)> {
    let candidate_title = candidate.get("title").or_else(|| candidate.get("fulltitle"))?.as_str()?.trim();
    let uploader = candidate
        .get("uploader")
        .or_else(|| candidate.get("channel"))
        .or_else(|| candidate.get("creator"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let combined = format!("{candidate_title} {uploader}");
    let wanted = format!("{title} {artist}");
    let title_ratio = word_overlap_ratio(title, candidate_title);
    let artist_ratio = if artist.trim().is_empty() {
        1.0
    } else {
        word_overlap_ratio(artist, &combined)
    };

    // Reject covers, edits, sped/slowed variants and other common false matches.
    let normalized_wanted = format!(" {} ", normalized_match_words(&wanted).join(" "));
    let normalized_candidate = format!(" {} ", normalized_match_words(&combined).join(" "));
    for rejected in [
        "slowed", "sped up", "speed up", "nightcore", "remix", "mashup",
        "live", "concert", "karaoke", "instrumental", "cover", "reaction",
        "shorts", "bass boosted", "8d audio",
    ] {
        let rejected_phrase = format!(" {} ", normalized_match_words(rejected).join(" "));
        if normalized_candidate.contains(&rejected_phrase) && !normalized_wanted.contains(&rejected_phrase) {
            return None;
        }
    }

    // Do not silently download an unrelated first search result. Both title and
    // artist need a strong textual match; unavailable duration metadata is common
    // on search results and therefore isn't treated as proof of a match.
    if title_ratio < 0.75 || (!artist.trim().is_empty() && artist_ratio < 0.65) {
        return None;
    }

    let candidate_url = supported_youtube_url(candidate)?;
    let official_hint = if normalized_candidate.contains("official audio")
        || normalized_candidate.contains("topic")
        || normalized_candidate.contains("official music")
    {
        8
    } else {
        0
    };
    let score = (title_ratio * 65.0).round() as i32
        + (artist_ratio * 35.0).round() as i32
        + official_hint;
    Some((score, candidate_url))
}

fn find_spotify_audio_url(app: &tauri::AppHandle, title: &str, artist: &str) -> Result<String, String> {
    let title = title.trim();
    let artist = artist.trim();
    if title.is_empty() {
        return Err("Spotify did not provide a track title.".into());
    }

    let executable = yt_dlp_executable(app)?;
    let queries = if artist.is_empty() {
        vec![format!("{title} official audio"), format!("{title} audio")]
    } else {
        vec![
            format!("{artist} - {title} official audio"),
            format!("{artist} {title} audio"),
        ]
    };

    let mut best: Option<(i32, String)> = None;
    let mut last_error = String::new();
    for query in queries {
        let search_url = format!("ytsearch8:{query}");
        let output = new_command(&executable)
            .arg("--dump-json")
            .arg("--flat-playlist")
            .arg("--no-warnings")
            .arg("--no-colors")
            .arg("--ignore-errors")
            .arg("--socket-timeout")
            .arg("30")
            .arg("--")
            .arg(&search_url)
            .output()
            .map_err(|error| format!("Could not start audio source search: {error}"))?;

        if !output.status.success() {
            last_error = last_line(&output.stderr, "Audio source search failed.");
            continue;
        }

        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let Ok(candidate) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if let Some(scored) = score_spotify_audio_candidate(title, artist, &candidate) {
                if best.as_ref().map(|current| scored.0 > current.0).unwrap_or(true) {
                    best = Some(scored);
                }
            }
        }
        // Prefer a confident match from the first targeted query; the second
        // query is a fallback for channels whose titles omit "official audio".
        if best.as_ref().map(|match_result| match_result.0 >= 100).unwrap_or(false) {
            break;
        }
    }

    best.map(|(_, url)| url).ok_or_else(|| {
        if last_error.is_empty() {
            format!("Couldn't find a confident audio match for “{}” by “{}”. Try another track or a direct media URL.", title, artist)
        } else {
            format!("Couldn't find a confident audio match for “{}” by “{}”: {}", title, artist, last_error)
        }
    })
}

#[tauri::command]
async fn download_spotify_track(
    app: tauri::AppHandle,
    title: String,
    artist: String,
    output_dir: String,
    format: String,
) -> Result<String, String> {
    let title = title.trim().to_string();
    let artist = artist.trim().to_string();
    if title.is_empty() || title.chars().count() > 300 || artist.chars().count() > 300 {
        return Err("Spotify track details are missing or too long.".into());
    }

    let output_path = PathBuf::from(&output_dir);
    if !output_path.is_dir() {
        return Err("Your selected Music folder is unavailable. Choose the folder again in Resonance.".into());
    }
    if !app.fs_scope().is_allowed(&output_path) {
        return Err("Resonance doesn't have access to that folder. Choose your Music folder again.".into());
    }
    let allowed_formats = ["best", "mp3", "m4a", "opus", "flac", "wav"];
    if !allowed_formats.contains(&format.as_str()) {
        return Err("That audio format is not supported.".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        emit_progress(&app, "preparing", &format!("Finding an audio match for “{title}”…"), None);
        let source_url = find_spotify_audio_url(&app, &title, &artist)?;
        emit_progress(&app, "preparing", &format!("Downloading matched audio for “{title}”…"), None);
        run_download(app, source_url, output_path, format)
    })
    .await
    .map_err(|error| format!("The Spotify download task stopped unexpectedly: {error}"))?
}

/// Stops the download that is currently running (including ffmpeg and other child processes).
#[tauri::command]
async fn cancel_download() -> bool {
    tauri::async_runtime::spawn_blocking(runner::cancel_active)
        .await
        .unwrap_or(false)
}

fn run_inspect(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let executable = yt_dlp_executable(&app)?;
    let result = new_command(executable)
        .arg("--dump-single-json")
        .arg("--no-warnings")
        .arg("--no-playlist")
        .arg("--skip-download")
        .arg("--socket-timeout")
        .arg("30")
        .arg("--")
        .arg(&url)
        .output()
        .map_err(|error| format!("Could not start yt-dlp: {error}"))?;

    if !result.status.success() {
        return Err(last_line(&result.stderr, "Could not inspect this media URL."));
    }

    let data: Value = serde_json::from_slice(&result.stdout)
        .map_err(|_| "yt-dlp returned invalid media information.".to_string())?;
    let title = data.get("title").and_then(Value::as_str).unwrap_or("Audio download");
    let duration = data.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
    Ok(serde_json::json!({ "title": title, "duration": duration }).to_string())
}

#[tauri::command]
async fn inspect_media_url(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let url = validate_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || run_inspect(app, url))
        .await
        .map_err(|error| format!("The inspection task stopped unexpectedly: {error}"))?
}


#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpotifyPublicTrack {
    id: String,
    name: String,
    artists: Vec<String>,
    album: String,
    duration: u64,
    cover_url: Option<String>,
    external_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpotifyPublicLink {
    id: String,
    name: String,
    kind: String,
    external_url: String,
    total_tracks: usize,
    tracks: Vec<SpotifyPublicTrack>,
}

fn parse_spotify_public_link(raw: &str) -> Result<(String, String, String), String> {
    let raw = raw.trim();
    let (kind, id) = if let Some(uri) = raw.strip_prefix("spotify:") {
        let mut parts = uri.split(':');
        let kind = parts.next().unwrap_or("");
        let id = parts.next().unwrap_or("");
        if parts.next().is_some() {
            return Err("Paste a Spotify playlist, album, or track link.".into());
        }
        (kind.to_string(), id.to_string())
    } else {
        let no_query = raw.split(|character| character == '?' || character == '#').next().unwrap_or("");
        let path = no_query
            .strip_prefix("https://open.spotify.com/")
            .or_else(|| no_query.strip_prefix("https://www.open.spotify.com/"))
            .ok_or_else(|| "Use a public https://open.spotify.com link (not a private or shortened share link).".to_string())?;
        let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
        let mut found: Option<(String, String)> = None;
        for index in 0..segments.len() {
            let segment = segments[index];
            if matches!(segment, "playlist" | "album" | "track") && index + 1 < segments.len() {
                found = Some((segment.to_string(), segments[index + 1].to_string()));
                break;
            }
        }
        found.ok_or_else(|| "This Spotify link is not a playlist, album, or track link.".to_string())?
    };

    if !matches!(kind.as_str(), "playlist" | "album" | "track")
        || id.len() < 18
        || id.len() > 24
        || !id.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err("The Spotify link ID looks invalid. Copy the link again from Spotify and retry.".into());
    }

    let canonical = format!("https://open.spotify.com/{kind}/{id}");
    Ok((kind, id, canonical))
}

fn spotify_curl(url: &str) -> Result<String, String> {
    let program = if cfg!(target_os = "windows") { "curl.exe" } else { "curl" };
    let mut command = Command::new(program);
    command
        .args([
            "--location",
            "--max-redirs", "3",
            "--connect-timeout", "8",
            "--max-time", "20",
            "--max-filesize", "12582912",
            "--silent",
            "--show-error",
            "--fail",
            "--compressed",
            "--proto", "=https",
            "--proto-redir", "=https",
            "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
            "--url", url,
        ]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command.output().map_err(|error| {
        format!("Resonance couldn't start curl to read the public Spotify page: {error}")
    })?;
    if !output.status.success() {
        return Err("Spotify did not return this public page. Check the link and your internet connection.".into());
    }
    if output.stdout.len() > 12 * 1024 * 1024 {
        return Err("Spotify's page was larger than the import safety limit.".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn html_attribute(tag: &str, attribute: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let needle = format!("{attribute}={quote}");
        if let Some(start) = tag.find(&needle) {
            let value_start = start + needle.len();
            if let Some(relative_end) = tag[value_start..].find(quote) {
                return Some(decode_spotify_html(&tag[value_start..value_start + relative_end]));
            }
        }
    }
    None
}

fn extract_spotify_meta(html: &str, key: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut offset = 0;
    while let Some(relative_start) = lower[offset..].find("<meta") {
        let start = offset + relative_start;
        let Some(relative_end) = lower[start..].find('>') else { break };
        let end = start + relative_end + 1;
        let tag = &html[start..end];
        let tag_lower = tag.to_ascii_lowercase();
        let is_match = tag_lower.contains(&format!("property=\"{key}\""))
            || tag_lower.contains(&format!("property='{key}'"))
            || tag_lower.contains(&format!("name=\"{key}\""))
            || tag_lower.contains(&format!("name='{key}'"));
        if is_match {
            if let Some(value) = html_attribute(tag, "content") {
                return Some(value);
            }
        }
        offset = end;
    }
    None
}

fn decode_spotify_html(raw: &str) -> String {
    raw.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn clean_spotify_title(raw: &str) -> String {
    let mut value = raw.trim();
    for suffix in [" | Spotify", " - Spotify", " • Spotify"] {
        if let Some(stripped) = value.strip_suffix(suffix) {
            value = stripped.trim();
            break;
        }
    }
    value.to_string()
}

fn extract_track_ids(html: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for marker in ["spotify:track:", "open.spotify.com/track/", "/track/"] {
        let mut offset = 0;
        while let Some(relative_start) = html[offset..].find(marker) {
            let start = offset + relative_start + marker.len();
            let tail = &html[start..];
            let id: String = tail.chars().take_while(|character| character.is_ascii_alphanumeric()).collect();
            if (18..=24).contains(&id.len()) && !ids.iter().any(|existing| existing == &id) {
                ids.push(id);
                if ids.len() >= 250 {
                    return ids;
                }
            }
            offset = start + tail.chars().take_while(|character| character.is_ascii_alphanumeric()).count().max(1);
            if offset >= html.len() {
                break;
            }
        }
    }
    ids
}

fn spotify_embed_title(url: &str) -> Option<String> {
    let encoded = url.replace(":", "%3A").replace("/", "%2F");
    let body = spotify_curl(&format!("https://open.spotify.com/oembed?url={encoded}")).ok()?;
    let data: Value = serde_json::from_str(&body).ok()?;
    data.get("title").and_then(Value::as_str).map(clean_spotify_title).filter(|value| !value.is_empty())
}

fn public_spotify_track(id: &str) -> SpotifyPublicTrack {
    let external_url = format!("https://open.spotify.com/track/{id}");
    let html = spotify_curl(&external_url).unwrap_or_default();
    let mut title = extract_spotify_meta(&html, "og:title").unwrap_or_default();
    if title.is_empty() {
        title = clean_spotify_title(&extract_spotify_meta(&html, "twitter:title").unwrap_or_default());
    }
    let description = extract_spotify_meta(&html, "og:description").unwrap_or_default();
    let image = extract_spotify_meta(&html, "og:image");
    let pieces: Vec<&str> = description.split('·').map(str::trim).filter(|part| !part.is_empty()).collect();

    let mut artist = String::new();
    let title_parts = title
        .split_once(" - ")
        .map(|(maybe_title, maybe_artist)| (maybe_title.trim().to_string(), maybe_artist.trim().to_string()));
    if let Some((maybe_title, maybe_artist)) = title_parts {
        title = maybe_title;
        artist = maybe_artist;
    }
    if artist.is_empty() && !pieces.is_empty() {
        artist = pieces[0].to_string();
    }
    let album = pieces.get(1).copied().unwrap_or("").to_string();

    // Spotify's public pages occasionally withhold full metadata. Keep an identifiable
    // entry rather than losing the whole public playlist because one track page changed.
    if title.is_empty() {
        title = spotify_embed_title(&external_url).unwrap_or_else(|| format!("Spotify track {id}"));
        let title_parts = title
            .split_once(" - ")
            .map(|(maybe_title, maybe_artist)| (maybe_title.trim().to_string(), maybe_artist.trim().to_string()));
        if let Some((maybe_title, maybe_artist)) = title_parts {
            title = maybe_title;
            if artist.is_empty() { artist = maybe_artist; }
        }
    }

    SpotifyPublicTrack {
        id: id.to_string(),
        name: title,
        artists: if artist.is_empty() { Vec::new() } else { vec![artist] },
        album,
        duration: 0,
        cover_url: image,
        external_url,
    }
}

fn fetch_public_spotify_link_impl(raw_url: String) -> Result<SpotifyPublicLink, String> {
    let (kind, id, canonical_url) = parse_spotify_public_link(&raw_url)?;
    let page_html = spotify_curl(&canonical_url)
        .or_else(|_| spotify_curl(&format!("https://open.spotify.com/embed/{kind}/{id}")))?;

    let page_name = extract_spotify_meta(&page_html, "og:title")
        .map(|title| clean_spotify_title(&title))
        .filter(|title| !title.is_empty());
    let name = spotify_embed_title(&canonical_url)
        .or(page_name)
        .unwrap_or_else(|| match kind.as_str() {
            "playlist" => "Spotify playlist".to_string(),
            "album" => "Spotify album".to_string(),
            _ => "Spotify track".to_string(),
        });

    let ids = if kind == "track" {
        vec![id.clone()]
    } else {
        let mut ids = extract_track_ids(&page_html);
        if ids.is_empty() {
            for url in [
                format!("https://open.spotify.com/embed/{kind}/{id}"),
                format!("{canonical_url}?nd=1"),
            ] {
                if let Ok(html) = spotify_curl(&url) {
                    ids = extract_track_ids(&html);
                    if !ids.is_empty() { break; }
                }
            }
        }
        ids
    };

    if ids.is_empty() {
        return Err("Spotify didn't expose tracks for this link. Make sure the playlist or album is public on Spotify and try again. Some public pages don't expose their full track list.".into());
    }

    let ids: Vec<String> = ids.into_iter().take(250).collect();
    let next_index = std::sync::atomic::AtomicUsize::new(0);
    let results: Mutex<Vec<Option<SpotifyPublicTrack>>> = Mutex::new(vec![None; ids.len()]);
    std::thread::scope(|scope| {
        for _ in 0..ids.len().min(8) {
            scope.spawn(|| loop {
                let index = next_index.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if index >= ids.len() { break; }
                let track = public_spotify_track(&ids[index]);
                if let Ok(mut guard) = results.lock() {
                    guard[index] = Some(track);
                }
            });
        }
    });

    let tracks: Vec<SpotifyPublicTrack> = results
        .into_inner()
        .unwrap_or_default()
        .into_iter()
        .flatten()
        .collect();
    if tracks.is_empty() {
        return Err("Spotify returned no readable track metadata for this link. Try the public link again.".into());
    }

    Ok(SpotifyPublicLink {
        id,
        name,
        kind,
        external_url: canonical_url,
        total_tracks: tracks.len(),
        tracks,
    })
}

#[tauri::command]
async fn fetch_spotify_public_link(url: String) -> Result<SpotifyPublicLink, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_public_spotify_link_impl(url))
        .await
        .map_err(|error| format!("The Spotify import task stopped unexpectedly: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .invoke_handler(tauri::generate_handler![download_audio, download_spotify_track, inspect_media_url, cancel_download, fetch_spotify_public_link])
        .run(tauri::generate_context!())
        .expect("error while running Resonance native music player");
}
