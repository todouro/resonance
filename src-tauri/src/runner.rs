//! Runs external downloader processes with live progress and per-job cancellation.
use crate::util::{parse_progress_line, Progress};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

static ACTIVE_DOWNLOAD: Mutex<Option<Arc<DownloadJob>>> = Mutex::new(None);
static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);
const MAX_KEPT_LINES: usize = 200;

pub type ProgressCallback = Arc<dyn Fn(Progress) + Send + Sync>;

#[derive(Debug)]
pub struct DownloadJob {
    id: String,
    cancelled: AtomicBool,
    active_pid: Mutex<Option<u32>>,
}

impl DownloadJob {
    pub fn new() -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let sequence = NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed);
        Self {
            id: format!("{}-{timestamp}-{sequence}", std::process::id()),
            cancelled: AtomicBool::new(false),
            active_pid: Mutex::new(None),
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Marks this job cancelled and stops its currently registered child process, if any.
    /// Holding the PID lock until termination is requested prevents killing a stale, reused PID.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.active_pid.lock() {
            if let Some(pid) = *guard {
                kill_tree(pid);
                *guard = None;
            }
        }
    }

    fn register_child(&self, pid: u32) {
        if let Ok(mut guard) = self.active_pid.lock() {
            *guard = Some(pid);
            if self.is_cancelled() {
                kill_tree(pid);
                *guard = None;
            }
        } else {
            // A poisoned process-state lock is not safe to leave running.
            kill_tree(pid);
        }
    }

    fn clear_child(&self, pid: u32) {
        if let Ok(mut guard) = self.active_pid.lock() {
            if *guard == Some(pid) {
                *guard = None;
            }
        }
    }
}

/// Owns the single active download slot for the full async command lifetime.
/// Dropping the guard makes the backend available for the next download.
pub struct ActiveDownloadGuard {
    job: Arc<DownloadJob>,
}

impl ActiveDownloadGuard {
    pub fn job(&self) -> Arc<DownloadJob> {
        Arc::clone(&self.job)
    }
}

impl Drop for ActiveDownloadGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_DOWNLOAD.lock() {
            if active
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &self.job))
            {
                *active = None;
            }
        }
    }
}

pub fn begin_active_download() -> Result<ActiveDownloadGuard, String> {
    let mut active = ACTIVE_DOWNLOAD
        .lock()
        .map_err(|_| "Download state is unavailable. Restart Resonance and try again.".to_string())?;
    if active.is_some() {
        return Err("A download is already running. Wait for it to finish before starting another.".into());
    }

    let job = Arc::new(DownloadJob::new());
    *active = Some(Arc::clone(&job));
    Ok(ActiveDownloadGuard { job })
}

/// Cancels the active download, including work still preparing an installer.
pub fn cancel_active() -> bool {
    let job = ACTIVE_DOWNLOAD
        .lock()
        .ok()
        .and_then(|active| active.as_ref().map(Arc::clone));
    match job {
        Some(job) => {
            job.cancel();
            true
        }
        None => false,
    }
}

/// A per-download temporary directory removed on every return path, including errors and panics.
pub struct TemporaryDirectory {
    path: PathBuf,
}

impl TemporaryDirectory {
    pub fn create(parent: &Path, job_id: &str) -> Result<Self, String> {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not prepare the temporary folder: {error}"))?;
        let path = parent.join(format!("download-{job_id}"));
        fs::create_dir(&path)
            .map_err(|error| format!("Could not create a unique temporary folder: {error}"))?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[derive(Debug)]
pub struct RunOutput {
    pub success: bool,
    pub cancelled: bool,
    pub stdout: Vec<String>,
    pub stderr: Vec<String>,
}

fn cancelled_output() -> RunOutput {
    RunOutput {
        success: false,
        cancelled: true,
        stdout: Vec::new(),
        stderr: Vec::new(),
    }
}

fn kill_tree(pid: u32) {
    let pid_text = pid.to_string();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // /T also stops ffmpeg and any other child processes yt-dlp started.
        let _ = Command::new("taskkill")
            .creation_flags(0x0800_0000)
            .args(["/PID", pid_text.as_str(), "/T", "/F"])
            .output();
    }
    #[cfg(not(windows))]
    {
        // The child leads its own process group (see run_with_progress), so a negative pid
        // stops the whole tree, like taskkill /T on Windows.
        let _ = Command::new("sh")
            .arg("-c")
            .arg(format!("kill -s KILL -- -{pid_text}"))
            .output();
    }
}

fn read_lines<R: Read + Send + 'static>(
    stream: R,
    on_progress: ProgressCallback,
) -> thread::JoinHandle<Vec<String>> {
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut kept: Vec<String> = Vec::new();
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buffer).trim_end().to_string();
                    if let Some(progress) = parse_progress_line(&line) {
                        on_progress(progress);
                    } else if !line.is_empty() {
                        if kept.len() >= MAX_KEPT_LINES {
                            kept.remove(0);
                        }
                        kept.push(line);
                    }
                }
            }
        }
        kept
    })
}

pub fn run_with_progress(
    mut command: Command,
    on_progress: ProgressCallback,
    job: &Arc<DownloadJob>,
) -> Result<RunOutput, String> {
    if job.is_cancelled() {
        return Ok(cancelled_output());
    }

    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_error) if job.is_cancelled() => return Ok(cancelled_output()),
        Err(error) => return Err(error.to_string()),
    };
    let pid = child.id();
    // If cancellation raced with spawn, registration observes the token and kills this child.
    job.register_child(pid);

    let stdout_handle = child.stdout.take().map(|stream| read_lines(stream, on_progress.clone()));
    let stderr_handle = child.stderr.take().map(|stream| read_lines(stream, on_progress));
    let status = child.wait();
    job.clear_child(pid);

    let stdout = stdout_handle.and_then(|handle| handle.join().ok()).unwrap_or_default();
    let stderr = stderr_handle.and_then(|handle| handle.join().ok()).unwrap_or_default();
    let cancelled = job.is_cancelled();
    let status = status.map_err(|error| error.to_string())?;
    Ok(RunOutput {
        success: status.success() && !cancelled,
        cancelled,
        stdout,
        stderr,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use std::time::{Duration, Instant};

    // These tests exercise process-wide active-job state and must not overlap.
    static SERIAL: StdMutex<()> = StdMutex::new(());

    fn sh(script: &str) -> Command {
        let mut command = Command::new("sh");
        command.arg("-c").arg(script);
        command
    }

    #[test]
    fn captures_output_and_reports_progress() {
        let _guard = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let seen: Arc<StdMutex<Vec<Option<f64>>>> = Arc::new(StdMutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let callback: ProgressCallback = Arc::new(move |progress| {
            sink.lock().unwrap().push(progress.percent);
        });
        let job = Arc::new(DownloadJob::new());
        let output = run_with_progress(
            sh("echo 'RESONANCE_PROGRESS|downloading| 10.0%|1MiB/s|00:05'; echo 'RESONANCE_PROGRESS|downloading|100%|1MiB/s|00:00' >&2; echo /music/song.mp3"),
            callback,
            &job,
        )
        .unwrap();

        assert!(output.success && !output.cancelled);
        assert_eq!(output.stdout, vec!["/music/song.mp3".to_string()]);
        let mut received = seen.lock().unwrap().clone();
        received.sort_by(|left, right| left.partial_cmp(right).unwrap());
        assert_eq!(received, vec![Some(10.0), Some(100.0)]);
    }

    #[test]
    fn failure_keeps_stderr() {
        let _guard = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let job = Arc::new(DownloadJob::new());
        let output = run_with_progress(sh("echo 'ERROR: nope' >&2; exit 3"), Arc::new(|_| {}), &job)
            .unwrap();
        assert!(!output.success && !output.cancelled);
        assert_eq!(output.stderr.last().map(String::as_str), Some("ERROR: nope"));
    }

    #[test]
    fn cancellation_requested_during_preparation_is_not_reset_when_process_starts() {
        let _guard = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let active = begin_active_download().unwrap();
        let job = active.job();

        assert!(cancel_active());
        assert!(job.is_cancelled());

        let output = run_with_progress(sh("echo should-not-run"), Arc::new(|_| {}), &job).unwrap();
        assert!(output.cancelled && !output.success);
        assert!(output.stdout.is_empty());
        drop(active);
        assert!(!cancel_active());
    }

    #[test]
    fn cancellation_stops_a_running_process_quickly() {
        let _guard = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let active = begin_active_download().unwrap();
        let job = active.job();
        let canceller = thread::spawn(|| {
            thread::sleep(Duration::from_millis(400));
            assert!(cancel_active());
        });

        let started = Instant::now();
        let output = run_with_progress(sh("sleep 30"), Arc::new(|_| {}), &job).unwrap();
        canceller.join().unwrap();

        assert!(output.cancelled && !output.success);
        assert!(started.elapsed() < Duration::from_secs(10));
        drop(active);
        assert!(!cancel_active());
    }

    #[test]
    fn only_one_backend_download_can_be_active_at_a_time() {
        let _guard = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let active = begin_active_download().unwrap();
        let error = begin_active_download().err().expect("second download must be rejected");
        assert!(error.contains("already running"));
        drop(active);
        assert!(begin_active_download().is_ok());
    }

    #[test]
    fn cancellation_tokens_are_independent_per_job() {
        let first = Arc::new(DownloadJob::new());
        let second = Arc::new(DownloadJob::new());
        first.cancel();
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        assert_ne!(first.id(), second.id());
    }

    #[test]
    fn temporary_download_directories_are_removed_on_drop() {
        let root = std::env::temp_dir().join(format!("resonance-test-{}", DownloadJob::new().id()));
        let directory = TemporaryDirectory::create(&root, "unit-test").unwrap();
        let path = directory.path().to_path_buf();
        assert!(path.is_dir());
        drop(directory);
        assert!(!path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn spawn_error_is_reported() {
        let _guard = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let job = Arc::new(DownloadJob::new());
        assert!(run_with_progress(Command::new("/definitely/not/a/program"), Arc::new(|_| {}), &job).is_err());
    }
}
