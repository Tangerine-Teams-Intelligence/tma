use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Mirrors INTERFACES.md exit-code taxonomy.
#[derive(Debug, Error, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AppError {
    #[error("user error [{code}]: {detail}")]
    User { code: String, detail: String },
    #[error("config error [{code}]: {detail}")]
    Config { code: String, detail: String },
    #[error("external error [{code}]: {detail}")]
    External { code: String, detail: String },
    #[error("git error [{code}]: {detail}")]
    Git { code: String, detail: String },
    #[error("internal error [{code}]: {detail}")]
    Internal { code: String, detail: String },
}

impl AppError {
    pub fn user(code: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::User { code: code.into(), detail: detail.into() }
    }
    pub fn config(code: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::Config { code: code.into(), detail: detail.into() }
    }
    pub fn external(code: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::External { code: code.into(), detail: detail.into() }
    }
    pub fn internal(code: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::Internal { code: code.into(), detail: detail.into() }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::internal("io", e.to_string())
    }
}

impl From<serde_yaml::Error> for AppError {
    fn from(e: serde_yaml::Error) -> Self {
        AppError::config("yaml_parse", e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::config("json_parse", e.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::external("http", e.to_string())
    }
}

impl From<notify::Error> for AppError {
    fn from(e: notify::Error) -> Self {
        AppError::internal("fs_watch", e.to_string())
    }
}
