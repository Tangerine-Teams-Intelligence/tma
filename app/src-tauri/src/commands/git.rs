//! Git operations for the v1.6.0 team memory sync.
//!
//! Design notes:
//!   - We shell out to the user's `git` CLI rather than embedding libgit2.
//!     Most developers already have git; bundling libgit2 would add ~50MB to
//!     the installer for a feature most teams will only set up once.
//!   - `git_check` runs at app launch — the React side renders an "install
//!     git" link if it's missing rather than letting clone/pull errors leak
//!     out as opaque "git: not found" toasts.
//!   - Token auth: when the caller passes an OAuth token we set the
//!     `GIT_ASKPASS` env to a tiny helper script that prints the token. This
//!     is portable across Windows / macOS / Linux and avoids embedding the
//!     token in the URL (which would land in `git config remote.origin.url`
//!     and leak across clones). Implementation: we write a small `.cmd` /
//!     `.sh` askpass into the OS temp dir and clean it up afterwards.
//!   - All commands are async; we use `tokio::process::Command` so the UI
//!     thread is never blocked by network I/O.
//!   - Paths with spaces (the test machine sits at `C:\Users\daizhe zo\…`)
//!     are passed via `Command::arg()` rather than string concat so quoting
//!     stays correct.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use super::AppError;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Locate `git` on PATH. Mirrors `which_first` in external.rs but kept local
/// here so this module can be moved into its own crate later without dragging
/// the wider commands surface along.
fn which_git() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let exts: Vec<&str> = if cfg!(windows) {
        vec!["", ".exe", ".cmd", ".bat"]
    } else {
        vec![""]
    };
    for dir in std::env::split_paths(&path_var) {
        for ext in &exts {
            let p = dir.join(format!("git{}", ext));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Result of `git_check`. The frontend renders an install-link UI when
/// `available` is false.
#[derive(Debug, Serialize)]
pub struct GitCheckResult {
    pub available: bool,
    pub path: Option<PathBuf>,
    pub version: Option<String>,
    /// Best-effort install hint URL the UI can link to. Always populated so
    /// the React side doesn't need to know per-OS install URLs.
    pub install_url: String,
}

#[tauri::command]
pub async fn git_check() -> Result<GitCheckResult, AppError> {
    let install_url = "https://git-scm.com/downloads".to_string();
    let path = match which_git() {
        Some(p) => p,
        None => {
            return Ok(GitCheckResult {
                available: false,
                path: None,
                version: None,
                install_url,
            });
        }
    };
    let out = oneshot(&path, &["--version"], None).await;
    let version = match out {
        Ok((s, stdout, _)) if s.success() => stdout.lines().next().map(|s| s.trim().to_string()),
        _ => None,
    };
    Ok(GitCheckResult {
        available: true,
        path: Some(path),
        version,
        install_url,
    })
}

#[derive(Debug, Deserialize)]
pub struct GitCloneArgs {
    pub url: String,
    pub dest: PathBuf,
    /// Optional GitHub OAuth token for private repos. Passed via GIT_ASKPASS
    /// so it never lands in `remote.origin.url`.
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GitCloneResult {
    pub dest: PathBuf,
    pub branch: String,
}

#[tauri::command]
pub async fn git_clone(args: GitCloneArgs) -> Result<GitCloneResult, AppError> {
    let git = require_git()?;
    if let Some(parent) = args.dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("mkdir_parent", e.to_string()))?;
    }

    // Inject token via askpass so it doesn't end up in the remote URL.
    let askpass = if let Some(tok) = &args.token {
        Some(write_askpass(tok)?)
    } else {
        None
    };

    let dest_str = args
        .dest
        .to_str()
        .ok_or_else(|| AppError::internal("non_utf8_path", format!("{:?}", args.dest)))?;
    let cli_args = vec!["clone", "--depth", "50", &args.url, dest_str];
    let env = askpass_env(askpass.as_ref());

    let (status, _stdout, stderr) = oneshot_env(&git, &cli_args, None, &env).await?;
    cleanup_askpass(askpass.as_ref());
    if !status.success() {
        return Err(AppError::Git {
            code: "clone_failed".into(),
            detail: humanize_git_error(&stderr),
        });
    }
    let branch = current_branch(&args.dest).await.unwrap_or_else(|| "main".into());
    Ok(GitCloneResult {
        dest: args.dest,
        branch,
    })
}

#[derive(Debug, Deserialize)]
pub struct GitRepoArgs {
    pub repo: PathBuf,
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GitOpResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn git_pull(args: GitRepoArgs) -> Result<GitOpResult, AppError> {
    let git = require_git()?;
    let askpass = match &args.token {
        Some(t) => Some(write_askpass(t)?),
        None => None,
    };
    let env = askpass_env(askpass.as_ref());
    // `--rebase` keeps our local commits on top so we never produce merge
    // commits the user didn't ask for. `--autostash` covers the rare case
    // where the user is mid-edit when the timer fires.
    let (status, _stdout, stderr) = oneshot_env(
        &git,
        &["pull", "--rebase", "--autostash", "origin"],
        Some(&args.repo),
        &env,
    )
    .await?;
    cleanup_askpass(askpass.as_ref());
    if !status.success() {
        // Detect the conflict path so the React side can route to the
        // resolution UI. v1.6.0 surfaces this as a toast; v1.6.1 ships the
        // diff resolver.
        if stderr.contains("CONFLICT") || stderr.contains("conflict") {
            return Err(AppError::Git {
                code: "pull_conflict".into(),
                detail: stderr.trim().to_string(),
            });
        }
        return Err(AppError::Git {
            code: "pull_failed".into(),
            detail: humanize_git_error(&stderr),
        });
    }
    Ok(GitOpResult {
        ok: true,
        message: "pulled".into(),
    })
}

#[tauri::command]
pub async fn git_push(args: GitRepoArgs) -> Result<GitOpResult, AppError> {
    let git = require_git()?;
    let askpass = match &args.token {
        Some(t) => Some(write_askpass(t)?),
        None => None,
    };
    let env = askpass_env(askpass.as_ref());
    let (status, _stdout, stderr) =
        oneshot_env(&git, &["push", "origin", "HEAD"], Some(&args.repo), &env).await?;
    cleanup_askpass(askpass.as_ref());
    if !status.success() {
        if stderr.contains("rejected") || stderr.contains("non-fast-forward") {
            return Err(AppError::Git {
                code: "push_rejected".into(),
                detail: stderr.trim().to_string(),
            });
        }
        return Err(AppError::Git {
            code: "push_failed".into(),
            detail: humanize_git_error(&stderr),
        });
    }
    Ok(GitOpResult {
        ok: true,
        message: "pushed".into(),
    })
}

#[derive(Debug, Deserialize)]
pub struct GitStatusArgs {
    pub repo: PathBuf,
}

#[derive(Debug, Serialize)]
pub struct GitStatusResult {
    pub clean: bool,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    /// Names of files in any non-clean state (modified, untracked, staged).
    pub changed: Vec<String>,
}

#[tauri::command]
pub async fn git_status(args: GitStatusArgs) -> Result<GitStatusResult, AppError> {
    let git = require_git()?;
    let (status, stdout, stderr) = oneshot(
        &git,
        &["status", "--porcelain=v2", "--branch", "--untracked-files=all"],
        Some(&args.repo),
    )
    .await?;
    if !status.success() {
        return Err(AppError::Git {
            code: "status_failed".into(),
            detail: humanize_git_error(&stderr),
        });
    }
    let mut branch = String::from("main");
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut changed: Vec<String> = Vec::new();
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            branch = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // Format: "+<ahead> -<behind>"
            for tok in rest.split_whitespace() {
                if let Some(n) = tok.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = tok.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
        } else if line.starts_with('1') || line.starts_with('2') || line.starts_with('?') || line.starts_with('u') {
            // Last whitespace-separated token is the path.
            if let Some(p) = line.rsplit_once(' ') {
                changed.push(p.1.to_string());
            }
        }
    }
    let clean = changed.is_empty();
    Ok(GitStatusResult {
        clean,
        branch,
        ahead,
        behind,
        changed,
    })
}

#[derive(Debug, Deserialize)]
pub struct GitCommitArgs {
    pub repo: PathBuf,
    pub message: String,
    /// Restrict the staging to a subdirectory (e.g. `memory/`) so we don't
    /// accidentally pick up user changes outside the synced tree.
    #[serde(default)]
    pub path_spec: Option<String>,
}

#[tauri::command]
pub async fn git_commit_all(args: GitCommitArgs) -> Result<GitOpResult, AppError> {
    let git = require_git()?;
    let path_spec = args.path_spec.as_deref().unwrap_or(".");
    let (status, _stdout, stderr) =
        oneshot(&git, &["add", "--", path_spec], Some(&args.repo)).await?;
    if !status.success() {
        return Err(AppError::Git {
            code: "add_failed".into(),
            detail: humanize_git_error(&stderr),
        });
    }
    // No-op safety: skip commit when nothing is staged. `git diff --cached
    // --quiet` exits 0 when staged tree matches HEAD, 1 when there are
    // staged changes. We take the inverse.
    let (clean_status, _o, _e) =
        oneshot(&git, &["diff", "--cached", "--quiet"], Some(&args.repo)).await?;
    if clean_status.success() {
        return Ok(GitOpResult {
            ok: true,
            message: "no_changes".into(),
        });
    }
    // We deliberately don't override author here — the user's global
    // git config wins, which is what they expect.
    let (status, _stdout, stderr) = oneshot(
        &git,
        &["commit", "-m", &args.message],
        Some(&args.repo),
    )
    .await?;
    if !status.success() {
        return Err(AppError::Git {
            code: "commit_failed".into(),
            detail: humanize_git_error(&stderr),
        });
    }
    Ok(GitOpResult {
        ok: true,
        message: "committed".into(),
    })
}

#[derive(Debug, Deserialize)]
pub struct GitInitArgs {
    pub repo: PathBuf,
    pub remote_url: String,
    #[serde(default)]
    pub token: Option<String>,
}

/// Initialize a fresh local clone, set the remote, push the initial commit.
/// Used by the "create new repo" champion-onboarding path after `octocrab`
/// has created the empty repo on GitHub.
#[tauri::command]
pub async fn git_init_and_push(args: GitInitArgs) -> Result<GitOpResult, AppError> {
    let git = require_git()?;
    std::fs::create_dir_all(&args.repo)
        .map_err(|e| AppError::internal("mkdir", e.to_string()))?;
    // mkdir memory/ + .gitkeep so the first commit is non-empty.
    let memory_dir = args.repo.join("memory");
    std::fs::create_dir_all(&memory_dir)
        .map_err(|e| AppError::internal("mkdir_memory", e.to_string()))?;
    let gitkeep = memory_dir.join(".gitkeep");
    if !gitkeep.exists() {
        std::fs::write(&gitkeep, b"")
            .map_err(|e| AppError::internal("write_gitkeep", e.to_string()))?;
    }
    let readme = args.repo.join("README.md");
    if !readme.exists() {
        std::fs::write(
            &readme,
            "# Tangerine team memory\n\nThis repo is auto-managed by Tangerine AI Teams. Don't edit by hand.\n",
        )
        .map_err(|e| AppError::internal("write_readme", e.to_string()))?;
    }
    // git init -b main + add + commit + remote add + push.
    let (s, _o, e) = oneshot(&git, &["init", "-b", "main"], Some(&args.repo)).await?;
    if !s.success() {
        return Err(AppError::Git {
            code: "init_failed".into(),
            detail: humanize_git_error(&e),
        });
    }
    let (s, _o, e) = oneshot(&git, &["add", "."], Some(&args.repo)).await?;
    if !s.success() {
        return Err(AppError::Git {
            code: "add_failed".into(),
            detail: humanize_git_error(&e),
        });
    }
    let (s, _o, e) = oneshot(
        &git,
        &["commit", "-m", "Initialize Tangerine team memory"],
        Some(&args.repo),
    )
    .await?;
    if !s.success() {
        return Err(AppError::Git {
            code: "commit_failed".into(),
            detail: humanize_git_error(&e),
        });
    }
    let (s, _o, e) = oneshot(
        &git,
        &["remote", "add", "origin", &args.remote_url],
        Some(&args.repo),
    )
    .await?;
    if !s.success() {
        return Err(AppError::Git {
            code: "remote_add_failed".into(),
            detail: humanize_git_error(&e),
        });
    }
    let askpass = match &args.token {
        Some(t) => Some(write_askpass(t)?),
        None => None,
    };
    let env = askpass_env(askpass.as_ref());
    let (s, _o, e) = oneshot_env(
        &git,
        &["push", "-u", "origin", "main"],
        Some(&args.repo),
        &env,
    )
    .await?;
    cleanup_askpass(askpass.as_ref());
    if !s.success() {
        return Err(AppError::Git {
            code: "push_failed".into(),
            detail: humanize_git_error(&e),
        });
    }
    Ok(GitOpResult {
        ok: true,
        message: "initialized_and_pushed".into(),
    })
}

// --- helpers ----------------------------------------------------------------

fn require_git() -> Result<PathBuf, AppError> {
    which_git().ok_or_else(|| AppError::external(
        "git_missing",
        "git is required for team memory sync but isn't installed. Visit https://git-scm.com/downloads.",
    ))
}

async fn oneshot(
    program: &Path,
    args: &[&str],
    cwd: Option<&Path>,
) -> Result<(std::process::ExitStatus, String, String), AppError> {
    oneshot_env(program, args, cwd, &[]).await
}

async fn oneshot_env(
    program: &Path,
    args: &[&str],
    cwd: Option<&Path>,
    env: &[(String, String)],
) -> Result<(std::process::ExitStatus, String, String), AppError> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(windows)]
    {
        // The compiler flags this as unused because trait-extension method
        // dispatch isn't tracked through the use-statement, but removing
        // it makes `creation_flags` an unknown method on Command. Same
        // pattern already in runner.rs::oneshot.
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().await.map_err(|e| {
        AppError::internal("git_spawn", format!("failed to run git: {}", e))
    })?;
    Ok((
        out.status,
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

async fn current_branch(repo: &Path) -> Option<String> {
    let git = which_git()?;
    let (status, stdout, _) = oneshot(&git, &["rev-parse", "--abbrev-ref", "HEAD"], Some(repo))
        .await
        .ok()?;
    if !status.success() {
        return None;
    }
    Some(stdout.trim().to_string())
}

/// Translate the noisier git stderr lines into something a non-git user can
/// read. If we don't recognise the pattern we just return the trimmed stderr.
fn humanize_git_error(stderr: &str) -> String {
    let s = stderr.trim();
    if s.contains("Authentication failed") || s.contains("could not read Username") {
        return "GitHub login expired. Sign in again from Settings.".into();
    }
    if s.contains("Could not resolve host") {
        return "No network connection to GitHub. Check your internet and try again.".into();
    }
    if s.contains("repository not found") || s.contains("Repository not found") {
        return "GitHub repo not found. Make sure you have access.".into();
    }
    if s.contains("Permission denied") {
        return "Permission denied. The team owner needs to add you to the repo.".into();
    }
    s.to_string()
}

/// Write a one-shot askpass helper to the OS temp dir. Returns the path so
/// the caller can clean it up. The script prints the OAuth token and exits;
/// git uses it for both the username and password prompt because the token
/// alone is sufficient for HTTPS auth on github.com.
fn write_askpass(token: &str) -> Result<PathBuf, AppError> {
    let mut p = std::env::temp_dir();
    let id = uuid::Uuid::new_v4().to_string();
    #[cfg(windows)]
    {
        p.push(format!("tangerine-askpass-{}.cmd", id));
        // CRLF on Windows so cmd.exe parses it cleanly. We deliberately
        // only echo the token — no quoting, no env-expansion.
        let body = format!("@echo off\r\necho {}\r\n", token);
        std::fs::write(&p, body)
            .map_err(|e| AppError::internal("askpass_write", e.to_string()))?;
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        p.push(format!("tangerine-askpass-{}.sh", id));
        let body = format!("#!/bin/sh\necho \"{}\"\n", token);
        std::fs::write(&p, body)
            .map_err(|e| AppError::internal("askpass_write", e.to_string()))?;
        let mut perms = std::fs::metadata(&p)
            .map_err(|e| AppError::internal("askpass_meta", e.to_string()))?
            .permissions();
        perms.set_mode(0o700);
        std::fs::set_permissions(&p, perms)
            .map_err(|e| AppError::internal("askpass_perm", e.to_string()))?;
    }
    Ok(p)
}

fn askpass_env(askpass: Option<&PathBuf>) -> Vec<(String, String)> {
    match askpass {
        Some(p) => {
            let s = p.to_string_lossy().to_string();
            vec![
                ("GIT_ASKPASS".into(), s.clone()),
                // Belt-and-braces: also disable the credential helper so we
                // don't accidentally cache the token in the OS keychain via
                // libsecret / wincred.
                ("GIT_TERMINAL_PROMPT".into(), "0".into()),
                ("GCM_INTERACTIVE".into(), "Never".into()),
                ("SSH_ASKPASS".into(), s),
            ]
        }
        None => Vec::new(),
    }
}

fn cleanup_askpass(askpass: Option<&PathBuf>) {
    if let Some(p) = askpass {
        let _ = std::fs::remove_file(p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn humanize_known_errors() {
        assert!(humanize_git_error("fatal: Authentication failed for ...")
            .contains("GitHub login expired"));
        assert!(humanize_git_error("ssh: Could not resolve hostname github.com")
            .contains("No network"));
        assert!(humanize_git_error("remote: Repository not found.")
            .contains("repo not found"));
        assert!(humanize_git_error("ERROR: Permission denied (publickey).")
            .contains("Permission denied"));
        assert_eq!(
            humanize_git_error("totally unknown error"),
            "totally unknown error".to_string()
        );
    }

    #[test]
    fn askpass_writes_executable_file() {
        let p = write_askpass("ghp_FAKE_TOKEN_xxx").unwrap();
        let meta = std::fs::metadata(&p).expect("askpass file must exist");
        assert!(meta.is_file());
        let body = std::fs::read_to_string(&p).expect("askpass body");
        assert!(body.contains("ghp_FAKE_TOKEN_xxx"));
        cleanup_askpass(Some(&p));
        assert!(!p.exists());
    }

    #[test]
    fn askpass_env_is_empty_without_token() {
        let env = askpass_env(None);
        assert!(env.is_empty());
    }

    #[test]
    fn askpass_env_sets_required_vars() {
        let dummy = PathBuf::from("/tmp/x");
        let env = askpass_env(Some(&dummy));
        let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"GIT_ASKPASS"));
        assert!(keys.contains(&"GIT_TERMINAL_PROMPT"));
    }
}
