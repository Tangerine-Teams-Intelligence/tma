//! Handler for the `tangerine://` deep link scheme.
//!
//! Tauri 2's `single-instance` plugin (with the `deep-link` feature) already
//! gives us argv routing: when the user clicks a `tangerine://join?...` URL
//! in Slack/email and Tangerine is already running, the OS spawns a second
//! `tangerine.exe`, the single-instance plugin catches it, and the original
//! process gets the new argv list inside its callback.
//!
//! Our job here is just to (a) extract the URL out of argv (b) emit a
//! `deeplink://join` event so the frontend's join-team route can pick it up.
//! The frontend handles the actual UX (accept / decline + clone).

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Debug, Clone, Serialize)]
pub struct DeepLinkEvent {
    pub uri: String,
}

/// Pull the first `tangerine://` URL out of an argv list. Returns None when
/// the launch was a normal "open the app" rather than a deep-link click.
pub fn extract_uri(argv: &[String]) -> Option<String> {
    argv.iter().find(|a| a.starts_with("tangerine://")).cloned()
}

/// Fire the deep-link event on the main window. Safe to call from the
/// single-instance callback or from the deep-link plugin's onOpen handler.
pub fn emit_deeplink<R: Runtime>(app: &AppHandle<R>, uri: String) {
    if uri.is_empty() {
        return;
    }
    let _ = app.emit("deeplink://join", DeepLinkEvent { uri });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_finds_tangerine_uri() {
        let argv = vec![
            "tangerine.exe".into(),
            "tangerine://join?repo=x&token=y".into(),
        ];
        let uri = extract_uri(&argv).unwrap();
        assert_eq!(uri, "tangerine://join?repo=x&token=y");
    }

    #[test]
    fn extract_returns_none_when_no_link() {
        let argv = vec!["tangerine.exe".into(), "--debug".into()];
        assert!(extract_uri(&argv).is_none());
    }

    #[test]
    fn extract_handles_empty_argv() {
        let argv: Vec<String> = vec![];
        assert!(extract_uri(&argv).is_none());
    }
}
