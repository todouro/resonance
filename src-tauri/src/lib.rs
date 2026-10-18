mod runner;
mod util;

use serde::Serialize;
use serde_json::Value;
use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpotifyOAuthCallback {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

fn open_spotify_url(url: &str) -> Result<(), String> {
    let allowed = url.starts_with("https://accounts.spotify.com/authorize?")
        || url == "https://developer.spotify.com/dashboard"
        || url == "https://open.spotify.com";
    if !allowed {
        return Err("Rejected an unapproved external URL.".into());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()
            .map_err(|error| format!("Could not open your browser: {error}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("Could not open your browser: {error}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("Could not open your browser: {error}"))?;
    }
    Ok(())
}
fn decode_query_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    decoded.push(byte);
                    index += 3;
                } else {
                    decoded.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn send_spotify_callback_page(stream: &mut std::net::TcpStream, status: &str, message: &str) {
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Resonance Spotify sign-in</title></head><body style=\"font:16px system-ui;max-width:40rem;margin:4rem auto;padding:0 1.5rem;background:#101311;color:#f4f7f4\"><h1>Resonance</h1><p>{}</p><p>You can return to the Resonance app.</p></body></html>",
        message
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}

fn wait_for_spotify_callback(expected_state: String, authorization_url: String) -> Result<SpotifyOAuthCallback, String> {
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;
    use std::time::Instant;

    let listener = TcpListener::bind(("127.0.0.1", 43821))
        .map_err(|error| format!("Could not open the Spotify sign-in port (43821). Close any other sign-in attempt and try again: {error}"))?;
    listener.set_nonblocking(true)
        .map_err(|error| format!("Could not prepare the Spotify sign-in receiver: {error}"))?;
    open_spotify_url(&authorization_url)?;

    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        match listener.accept() {
            Ok((mut stream, _peer)) => {
                let mut reader = BufReader::new(&mut stream);
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() || request_line.is_empty() {
                    continue;
                }
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).is_err() || header == "\r\n" || header == "\n" || header.is_empty() {
                        break;
                    }
                }
                drop(reader);

                let mut parts = request_line.split_whitespace();
                let method = parts.next().unwrap_or("");
                let target = parts.next().unwrap_or("");
                if method != "GET" {
                    send_spotify_callback_page(&mut stream, "405 Method Not Allowed", "This Spotify callback request was not accepted.");
                    continue;
                }
                let (path, query) = target.split_once('?').unwrap_or((target, ""));
                if path != "/callback" {
                    send_spotify_callback_page(&mut stream, "404 Not Found", "This local address is only used to finish Spotify sign-in.");
                    continue;
                }

                let params: std::collections::HashMap<String, String> = query
                    .split('&')
                    .filter_map(|pair| {
                        let (key, value) = pair.split_once('=')?;
                        Some((decode_query_component(key), decode_query_component(value)))
                    })
                    .collect();
                let returned_state = params.get("state").cloned();
                if returned_state.as_deref() != Some(expected_state.as_str()) {
                    send_spotify_callback_page(&mut stream, "400 Bad Request", "Spotify sign-in could not be verified. Return to Resonance and try again.");
                    continue;
                }

                let result = SpotifyOAuthCallback {
                    code: params.get("code").cloned(),
                    state: returned_state,
                    error: params.get("error").cloned(),
                };
                if result.error.is_some() {
                    send_spotify_callback_page(&mut stream, "200 OK", "Spotify access was not granted.");
                    return Ok(result);
                }
                if result.code.is_none() {
                    send_spotify_callback_page(&mut stream, "400 Bad Request", "Spotify did not return an authorization code.");
                    return Err("Spotify did not return an authorization code. Please try again.".into());
                }
                send_spotify_callback_page(&mut stream, "200 OK", "Spotify connected successfully.");
                return Ok(result);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("Spotify sign-in timed out. Reopen Spotify Import and try again.".into());
                }
                thread::sleep(Duration::from_millis(200));
            }
            Err(error) => return Err(format!("Could not receive the Spotify sign-in response: {error}")),
        }
    }
}

#[tauri::command]
async fn spotify_authorize(authorization_url: String, expected_state: String) -> Result<SpotifyOAuthCallback, String> {
    tauri::async_runtime::spawn_blocking(move || wait_for_spotify_callback(expected_state, authorization_url))
        .await
        .map_err(|error| format!("The Spotify sign-in receiver stopped unexpectedly: {error}"))?
}

/// Opens the official Spotify Developer Dashboard in the user's default browser.
#[tauri::command]
async fn open_spotify_dashboard() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| open_spotify_url("https://developer.spotify.com/dashboard"))
        .await
        .map_err(|error| format!("The browser-opening task stopped unexpectedly: {error}"))?
}

/// Copies the fixed Spotify redirect URI using the native system clipboard.
fn copy_redirect_uri_to_clipboard() -> Result<(), String> {
    const REDIRECT_URI: &str = "http://127.0.0.1:43821/callback";

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Set-Clipboard -Value 'http://127.0.0.1:43821/callback'",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|error| format!("Could not access the Windows clipboard: {error}"))?;
        if output.status.success() {
            return Ok(());
        }
        return Err("Windows could not copy the redirect URI to the clipboard.".into());
    }

    #[cfg(target_os = "macos")]
    {
        let mut child = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Could not access the macOS clipboard: {error}"))?;
        let mut input = child.stdin.take().ok_or_else(|| "Could not write to the clipboard.".to_string())?;
        input.write_all(REDIRECT_URI.as_bytes()).map_err(|error| format!("Could not write to the clipboard: {error}"))?;
        drop(input);
        let status = child.wait().map_err(|error| format!("Could not finish copying the redirect URI: {error}"))?;
        if status.success() { return Ok(()); }
        return Err("macOS could not copy the redirect URI to the clipboard.".into());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let attempts: [(&str, &[&str]); 3] = [
            ("wl-copy", &[]),
            ("xclip", &["-selection", "clipboard"]),
            ("xsel", &["--clipboard", "--input"]),
        ];
        for (program, args) in attempts {
            let spawned = Command::new(program)
                .args(args)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            let Ok(mut child) = spawned else { continue };
            let Some(mut input) = child.stdin.take() else { continue };
            if input.write_all(REDIRECT_URI.as_bytes()).is_err() {
                let _ = child.kill();
                continue;
            }
            drop(input);
            if child.wait().map(|status| status.success()).unwrap_or(false) {
                return Ok(());
            }
        }
        return Err("No supported clipboard utility was available.".into());
    }
}

#[tauri::command]
async fn copy_spotify_redirect_uri() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(copy_redirect_uri_to_clipboard)
        .await
        .map_err(|error| format!("The clipboard task stopped unexpectedly: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .invoke_handler(tauri::generate_handler![download_audio, inspect_media_url, cancel_download, spotify_authorize, open_spotify_dashboard, copy_spotify_redirect_uri])
        .run(tauri::generate_context!())
        .expect("error while running Resonance native music player");
}
