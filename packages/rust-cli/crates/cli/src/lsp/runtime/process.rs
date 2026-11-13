//! Fork: one language-server child process (specs/fork-rust-lsp.md "Pool" Start), Node adapters
//! `lsp/server-process.ts`. The pool sees it through [`Launcher`] so tests drive a fake over in-memory pipes.

use std::io;
use std::process::Stdio;

use async_trait::async_trait;
use rust_cli_proc::ledger::{Containment, Isolation, Ledger, Purpose, Tracked};
use rust_cli_proc::tree::Shutdown;
use tokio::io::{AsyncRead, AsyncWrite};

/// What to run, already resolved: the env is the whole child environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Launch {
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) cwd: String,
    pub(crate) env: Vec<(String, String)>,
}

/// Node's spawn `error` event: `ENOENT` is a missing command, anything else a failed start with its code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LaunchError {
    NotFound,
    Other(String),
}

/// The running child: its exit and its termination.
#[async_trait]
pub(crate) trait Process: Send {
    /// Waits for the exit and describes it (`exited (code 1, signal none)`). Cancel-safe.
    async fn wait(&mut self) -> String;
    /// Ends the whole tree and reaps the root.
    async fn terminate(&mut self);
}

pub(crate) struct Launched {
    pub(crate) stdin: Box<dyn AsyncWrite + Send + Unpin>,
    pub(crate) stdout: Box<dyn AsyncRead + Send + Unpin>,
    pub(crate) stderr: Box<dyn AsyncRead + Send + Unpin>,
    pub(crate) pid: u32,
    pub(crate) process: Box<dyn Process>,
}

#[async_trait]
pub(crate) trait Launcher: Send + Sync {
    async fn launch(&self, launch: Launch) -> Result<Launched, LaunchError>;
}

/// The real launcher: its own process group, recorded in the ledger as `lsp`, the process Job on Windows (as an MCP
/// stdio server).
pub(crate) struct LedgerLauncher {
    ledger: Ledger,
}

impl LedgerLauncher {
    pub(crate) fn new(ledger: Ledger) -> Self {
        Self { ledger }
    }
}

/// Node's errno code for a spawn failure other than a missing command.
fn spawn_code(error: &io::Error) -> String {
    match error.kind() {
        io::ErrorKind::PermissionDenied => "EACCES".to_owned(),
        io::ErrorKind::InvalidInput => "EINVAL".to_owned(),
        io::ErrorKind::NotADirectory => "ENOTDIR".to_owned(),
        _ => "unknown error".to_owned(),
    }
}

#[async_trait]
impl Launcher for LedgerLauncher {
    async fn launch(&self, launch: Launch) -> Result<Launched, LaunchError> {
        let mut command = rust_cli_proc::command(&launch.command);
        command
            .args(&launch.args)
            .current_dir(&launch.cwd)
            .env_clear()
            .envs(launch.env.iter().map(|(key, value)| (key, value)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut tracked = self
            .ledger
            .spawn(
                &mut command,
                Purpose::Lsp,
                Isolation::Group,
                Containment::ProcessJob,
            )
            .await
            .map_err(|error| match error.kind() {
                io::ErrorKind::NotFound => LaunchError::NotFound,
                _ => LaunchError::Other(spawn_code(&error)),
            })?;
        let child = tracked.child();
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            let _ = tracked.terminate(Shutdown::Immediate).await;
            return Err(LaunchError::Other("unknown error".to_owned()));
        };
        let pid = tracked.pid();
        Ok(Launched {
            stdin: Box::new(stdin),
            stdout: Box::new(stdout),
            stderr: Box::new(stderr),
            pid,
            process: Box::new(Child { tracked }),
        })
    }
}

struct Child {
    tracked: Tracked,
}

#[async_trait]
impl Process for Child {
    async fn wait(&mut self) -> String {
        match self.tracked.child().wait().await {
            Ok(status) => exit_detail(status.code(), signal_of(&status)),
            Err(_) => exit_detail(None, None),
        }
    }

    async fn terminate(&mut self) {
        if let Err(error) = self.tracked.terminate(Shutdown::Graceful).await {
            tracing::warn!(event = "adapters.lsp.kill_failed", pid = self.tracked.pid(), %error, "LSP process tree kill failed");
        }
    }
}

/// Node `exited (code ${code ?? "none"}, signal ${signal ?? "none"})`.
pub(crate) fn exit_detail(code: Option<i32>, signal: Option<&'static str>) -> String {
    let code = code.map_or_else(|| "none".to_owned(), |code| code.to_string());
    format!("exited (code {code}, signal {})", signal.unwrap_or("none"))
}

#[cfg(unix)]
fn signal_of(status: &std::process::ExitStatus) -> Option<&'static str> {
    use std::os::unix::process::ExitStatusExt;
    let number = status.signal()?;
    let names = [
        (libc::SIGHUP, "SIGHUP"),
        (libc::SIGINT, "SIGINT"),
        (libc::SIGQUIT, "SIGQUIT"),
        (libc::SIGILL, "SIGILL"),
        (libc::SIGTRAP, "SIGTRAP"),
        (libc::SIGABRT, "SIGABRT"),
        (libc::SIGBUS, "SIGBUS"),
        (libc::SIGFPE, "SIGFPE"),
        (libc::SIGKILL, "SIGKILL"),
        (libc::SIGUSR1, "SIGUSR1"),
        (libc::SIGSEGV, "SIGSEGV"),
        (libc::SIGUSR2, "SIGUSR2"),
        (libc::SIGPIPE, "SIGPIPE"),
        (libc::SIGALRM, "SIGALRM"),
        (libc::SIGTERM, "SIGTERM"),
    ];
    Some(
        names
            .iter()
            .find(|(known, _)| *known == number)
            .map_or("SIGUNKNOWN", |(_, name)| name),
    )
}

#[cfg(not(unix))]
fn signal_of(_: &std::process::ExitStatus) -> Option<&'static str> {
    None
}
