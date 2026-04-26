//! Invite link codec for v1.6.0 team memory sync.
//!
//! Format: `tangerine://join?repo=<urlenc clone url>&token=<short-lived signed token>`.
//!
//! The token is a self-describing payload — there is no server side here.
//! Anyone with a valid clone URL + a working GitHub token of their own can
//! already join, so the "invite token" is really just a short, copy-paste-
//! friendly thing the inviter gives the invitee. We sign it with a per-app
//! HMAC secret so the URI handler can detect tampered tokens (not because
//! we expect attackers, but because it lets the React side warn "this link
//! looks broken" instead of silently failing on a bad clone URL).
//!
//! Threat model is intentionally light:
//!   - The signing secret lives in `<app_data>/sync/invite.key`. If a
//!     teammate copies their secret to another machine, that's fine — they
//!     own the team.
//!   - Tokens are valid for 7 days; anything older is considered stale.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use sha2::Digest;
use tauri::State;

use super::{AppError, AppState};

const INVITE_TTL_SECS: u64 = 7 * 24 * 60 * 60;
const SECRET_FILE: &str = "invite.key";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InvitePayload {
    pub repo_url: String,
    /// Issued-at epoch seconds.
    pub iat: u64,
    /// 4-byte nonce so two back-to-back invites for the same repo differ.
    pub nonce: String,
}

/// Output of `generate_invite`. The frontend renders the `uri` and provides
/// a copy button.
#[derive(Debug, Serialize)]
pub struct InviteOut {
    pub uri: String,
    pub repo_url: String,
    pub expires_at: u64,
}

#[derive(Debug, Deserialize)]
pub struct GenerateInviteArgs {
    pub repo_url: String,
}

#[tauri::command]
pub async fn generate_invite(
    _state: State<'_, AppState>,
    args: GenerateInviteArgs,
) -> Result<InviteOut, AppError> {
    if args.repo_url.trim().is_empty() {
        return Err(AppError::user(
            "missing_repo_url",
            "Repo URL is required to generate an invite.",
        ));
    }
    let now = now_secs();
    let payload = InvitePayload {
        repo_url: args.repo_url.clone(),
        iat: now,
        nonce: random_nonce(),
    };
    let token = encode_token(&payload)?;
    let uri = format!(
        "tangerine://join?repo={}&token={}",
        urlencoding::encode(&args.repo_url),
        urlencoding::encode(&token)
    );
    Ok(InviteOut {
        uri,
        repo_url: args.repo_url,
        expires_at: now + INVITE_TTL_SECS,
    })
}

#[derive(Debug, Deserialize)]
pub struct ParseInviteArgs {
    pub uri: String,
}

#[derive(Debug, Serialize)]
pub struct ParseInviteOut {
    pub valid: bool,
    pub repo_url: Option<String>,
    pub expired: bool,
    pub reason: Option<String>,
}

#[tauri::command]
pub async fn parse_invite(
    _state: State<'_, AppState>,
    args: ParseInviteArgs,
) -> Result<ParseInviteOut, AppError> {
    let parsed = parse_invite_uri(&args.uri);
    match parsed {
        Ok((repo, payload)) => {
            let expired = now_secs().saturating_sub(payload.iat) > INVITE_TTL_SECS;
            Ok(ParseInviteOut {
                valid: !expired,
                repo_url: Some(repo),
                expired,
                reason: if expired {
                    Some("This invite link expired (older than 7 days). Ask the team for a fresh one.".into())
                } else {
                    None
                },
            })
        }
        Err(e) => Ok(ParseInviteOut {
            valid: false,
            repo_url: None,
            expired: false,
            reason: Some(format_err(&e)),
        }),
    }
}

/// Pure parse helper — extracted so the test suite can hit it without the
/// Tauri State indirection.
pub fn parse_invite_uri(uri: &str) -> Result<(String, InvitePayload), AppError> {
    let s = uri.trim();
    let body = s
        .strip_prefix("tangerine://join?")
        .or_else(|| s.strip_prefix("tangerine://join/?"))
        .ok_or_else(|| AppError::user("bad_invite_scheme", "Not a tangerine:// invite link."))?;
    let mut repo: Option<String> = None;
    let mut token: Option<String> = None;
    for kv in body.split('&') {
        let mut split = kv.splitn(2, '=');
        let k = split.next().unwrap_or("");
        let v = split.next().unwrap_or("");
        let v_dec = urlencoding::decode(v)
            .map_err(|e| AppError::user("bad_invite_encoding", e.to_string()))?
            .into_owned();
        match k {
            "repo" => repo = Some(v_dec),
            "token" => token = Some(v_dec),
            _ => {}
        }
    }
    let repo =
        repo.ok_or_else(|| AppError::user("missing_repo", "Invite link is missing the repo URL."))?;
    let token = token
        .ok_or_else(|| AppError::user("missing_token", "Invite link is missing the token."))?;
    let payload = decode_token(&token)?;
    if payload.repo_url != repo {
        return Err(AppError::user(
            "tampered_invite",
            "Invite link looks tampered with — repo doesn't match the signed token.",
        ));
    }
    Ok((repo, payload))
}

fn encode_token(p: &InvitePayload) -> Result<String, AppError> {
    let secret = load_or_init_secret()?;
    encode_token_with(p, &secret)
}

fn decode_token(t: &str) -> Result<InvitePayload, AppError> {
    let secret = load_or_init_secret()?;
    decode_token_with(t, &secret)
}

/// Pure-function variant for unit tests — caller supplies the HMAC secret so
/// the test isn't racing against the real on-disk key file. Production code
/// goes through `encode_token` / `decode_token` instead.
fn encode_token_with(p: &InvitePayload, secret: &[u8]) -> Result<String, AppError> {
    let body = serde_json::to_vec(p)
        .map_err(|e| AppError::internal("invite_encode", e.to_string()))?;
    let body_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&body);
    let sig = sign_with(secret, &body);
    let sig_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&sig);
    Ok(format!("{}.{}", body_b64, sig_b64))
}

fn decode_token_with(t: &str, secret: &[u8]) -> Result<InvitePayload, AppError> {
    let mut parts = t.splitn(2, '.');
    let body_b64 = parts.next().ok_or_else(|| AppError::user("invite_format", "Token is malformed."))?;
    let sig_b64 = parts.next().ok_or_else(|| AppError::user("invite_format", "Token is missing the signature."))?;
    let body = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(body_b64.as_bytes())
        .map_err(|e| AppError::user("invite_b64", e.to_string()))?;
    let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(sig_b64.as_bytes())
        .map_err(|e| AppError::user("invite_b64", e.to_string()))?;
    let expected = sign_with(secret, &body);
    if !constant_time_eq(&sig, &expected) {
        return Err(AppError::user(
            "invite_signature",
            "Invite link signature didn't match. Ask the team for a fresh one.",
        ));
    }
    let payload: InvitePayload = serde_json::from_slice(&body)
        .map_err(|e| AppError::user("invite_payload", e.to_string()))?;
    Ok(payload)
}

fn sign_with(secret: &[u8], body: &[u8]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(secret);
    hasher.update(body);
    hasher.finalize().to_vec()
}

fn load_or_init_secret() -> Result<Vec<u8>, AppError> {
    let path = secret_path()?;
    if let Ok(bytes) = std::fs::read(&path) {
        if !bytes.is_empty() {
            return Ok(bytes);
        }
    }
    use rand::RngCore;
    let mut buf = vec![0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::internal("secret_dir", e.to_string()))?;
    }
    std::fs::write(&path, &buf)
        .map_err(|e| AppError::internal("secret_write", e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path)
            .map_err(|e| AppError::internal("secret_meta", e.to_string()))?
            .permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&path, perms)
            .map_err(|e| AppError::internal("secret_perm", e.to_string()))?;
    }
    Ok(buf)
}

fn secret_path() -> Result<PathBuf, AppError> {
    #[cfg(windows)]
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")));
    #[cfg(not(windows))]
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    Ok(base.join("TangerineMeeting").join("sync").join(SECRET_FILE))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn random_nonce() -> String {
    use rand::Rng;
    const ALPHA: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..8).map(|_| ALPHA[rng.gen_range(0..ALPHA.len())] as char).collect()
}

/// Constant-time byte comparison so a timing side channel can't leak the
/// HMAC byte-by-byte. Length-mismatch is treated as inequality up front.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut acc = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        acc |= x ^ y;
    }
    acc == 0
}

fn format_err(e: &AppError) -> String {
    match e {
        AppError::User { detail, .. }
        | AppError::Config { detail, .. }
        | AppError::External { detail, .. }
        | AppError::Git { detail, .. }
        | AppError::Internal { detail, .. } => detail.clone(),
    }
}

/// Pure-function variant of `parse_invite_uri` for tests — caller supplies
/// the HMAC secret so test threads don't race on the on-disk key file.
#[cfg(test)]
fn parse_invite_uri_with(uri: &str, secret: &[u8]) -> Result<(String, InvitePayload), AppError> {
    let s = uri.trim();
    let body = s
        .strip_prefix("tangerine://join?")
        .or_else(|| s.strip_prefix("tangerine://join/?"))
        .ok_or_else(|| AppError::user("bad_invite_scheme", "Not a tangerine:// invite link."))?;
    let mut repo: Option<String> = None;
    let mut token: Option<String> = None;
    for kv in body.split('&') {
        let mut split = kv.splitn(2, '=');
        let k = split.next().unwrap_or("");
        let v = split.next().unwrap_or("");
        let v_dec = urlencoding::decode(v)
            .map_err(|e| AppError::user("bad_invite_encoding", e.to_string()))?
            .into_owned();
        match k {
            "repo" => repo = Some(v_dec),
            "token" => token = Some(v_dec),
            _ => {}
        }
    }
    let repo =
        repo.ok_or_else(|| AppError::user("missing_repo", "Invite link is missing the repo URL."))?;
    let token = token
        .ok_or_else(|| AppError::user("missing_token", "Invite link is missing the token."))?;
    let payload = decode_token_with(&token, secret)?;
    if payload.repo_url != repo {
        return Err(AppError::user(
            "tampered_invite",
            "Invite link looks tampered with — repo doesn't match the signed token.",
        ));
    }
    Ok((repo, payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Per-test secret — avoids races on the on-disk key file when cargo
    /// runs tests concurrently in the same process.
    const TEST_SECRET: &[u8] = b"unit-test-secret-32-bytes-padded";

    #[test]
    fn roundtrip_invite() {
        let payload = InvitePayload {
            repo_url: "https://github.com/team/tangerine-memory-abcd.git".into(),
            iat: now_secs(),
            nonce: random_nonce(),
        };
        let tok = encode_token_with(&payload, TEST_SECRET).unwrap();
        let got = decode_token_with(&tok, TEST_SECRET).unwrap();
        assert_eq!(got.repo_url, payload.repo_url);
        assert_eq!(got.nonce, payload.nonce);
    }

    #[test]
    fn parse_invite_uri_roundtrip() {
        let payload = InvitePayload {
            repo_url: "https://github.com/team/tangerine-memory-abcd.git".into(),
            iat: now_secs(),
            nonce: random_nonce(),
        };
        let tok = encode_token_with(&payload, TEST_SECRET).unwrap();
        let uri = format!(
            "tangerine://join?repo={}&token={}",
            urlencoding::encode(&payload.repo_url),
            urlencoding::encode(&tok)
        );
        let (repo, parsed) = parse_invite_uri_with(&uri, TEST_SECRET).unwrap();
        assert_eq!(repo, payload.repo_url);
        assert_eq!(parsed.repo_url, payload.repo_url);
    }

    #[test]
    fn parse_invite_rejects_wrong_scheme() {
        let res = parse_invite_uri_with("https://example.com/?repo=x&token=y", TEST_SECRET);
        assert!(res.is_err());
    }

    #[test]
    fn parse_invite_rejects_tampered_repo() {
        let payload = InvitePayload {
            repo_url: "https://github.com/team/realrepo.git".into(),
            iat: now_secs(),
            nonce: random_nonce(),
        };
        let tok = encode_token_with(&payload, TEST_SECRET).unwrap();
        let uri = format!(
            "tangerine://join?repo={}&token={}",
            urlencoding::encode("https://github.com/attacker/evil.git"),
            urlencoding::encode(&tok)
        );
        let err = parse_invite_uri_with(&uri, TEST_SECRET).unwrap_err();
        match err {
            AppError::User { code, .. } => assert_eq!(code, "tampered_invite"),
            _ => panic!("expected tampered_invite, got {:?}", err),
        }
    }

    #[test]
    fn ttl_check_via_payload() {
        let payload = InvitePayload {
            repo_url: "https://github.com/team/repo.git".into(),
            iat: now_secs() - INVITE_TTL_SECS - 1,
            nonce: random_nonce(),
        };
        let tok = encode_token_with(&payload, TEST_SECRET).unwrap();
        let uri = format!(
            "tangerine://join?repo={}&token={}",
            urlencoding::encode(&payload.repo_url),
            urlencoding::encode(&tok)
        );
        // Pure parse should succeed; expiry is enforced at the command layer.
        let (_, p) = parse_invite_uri_with(&uri, TEST_SECRET).unwrap();
        assert!(now_secs().saturating_sub(p.iat) > INVITE_TTL_SECS);
    }

    #[test]
    fn signature_mismatch_rejected() {
        let payload = InvitePayload {
            repo_url: "https://github.com/team/repo.git".into(),
            iat: now_secs(),
            nonce: random_nonce(),
        };
        let tok = encode_token_with(&payload, b"key-A").unwrap();
        let err = decode_token_with(&tok, b"key-B").unwrap_err();
        match err {
            AppError::User { code, .. } => assert_eq!(code, "invite_signature"),
            _ => panic!("expected invite_signature error"),
        }
    }

    #[test]
    fn constant_time_eq_basic() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }
}
