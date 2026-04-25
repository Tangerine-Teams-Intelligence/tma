//! `list_meetings`, `read_meeting`, `read_meeting_file` — pure FS reads of the
//! `meetings_repo/meetings/<id>/` directory tree (schema per INTERFACES.md §2).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::{AppError, AppState, IntentInfo, MeetingListItem, MeetingState};

#[derive(Debug, Deserialize, Default)]
pub struct ListMeetingsArgs {
    #[serde(default)]
    pub state_filter: Option<String>,
    #[serde(default)]
    pub since: Option<String>,
}

#[tauri::command]
pub async fn list_meetings(
    state: State<'_, AppState>,
    args: ListMeetingsArgs,
) -> Result<Vec<MeetingListItem>, AppError> {
    let dir = state.paths.meetings_repo.join("meetings");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        let meeting_path = entry.path().join("meeting.yaml");
        let status_path = entry.path().join("status.yaml");

        let meeting_v: serde_yaml::Value = if meeting_path.is_file() {
            serde_yaml::from_str(&std::fs::read_to_string(&meeting_path)?)?
        } else {
            serde_yaml::Value::Null
        };
        let status_v: serde_yaml::Value = if status_path.is_file() {
            serde_yaml::from_str(&std::fs::read_to_string(&status_path)?)?
        } else {
            serde_yaml::Value::Null
        };

        let title = meeting_v
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("(untitled)")
            .to_string();
        let st = status_v
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("created")
            .to_string();
        if let Some(filter) = &args.state_filter {
            if &st != filter {
                continue;
            }
        }
        let created_at = meeting_v
            .get("created_at")
            .and_then(|v| v.as_str())
            .map(String::from);
        let participants: Vec<String> = meeting_v
            .get("participants")
            .and_then(|v| v.as_sequence())
            .map(|s| {
                s.iter()
                    .filter_map(|p| p.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let transcript_lines = count_lines(&entry.path().join("transcript.md")).unwrap_or(0);

        out.push(MeetingListItem {
            id,
            title,
            state: st,
            created_at,
            participants,
            transcript_lines,
        });
    }
    // Newest first.
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

#[derive(Debug, Deserialize)]
pub struct ReadMeetingArgs {
    pub meeting_id: String,
}

#[tauri::command]
pub async fn read_meeting(
    state: State<'_, AppState>,
    args: ReadMeetingArgs,
) -> Result<MeetingState, AppError> {
    let dir = state.paths.meetings_repo.join("meetings").join(&args.meeting_id);
    if !dir.is_dir() {
        return Err(AppError::user(
            "meeting_not_found",
            format!("{:?}", dir),
        ));
    }

    let meeting_v: serde_yaml::Value = serde_yaml::from_str(
        &std::fs::read_to_string(dir.join("meeting.yaml"))?
    )?;
    let status_v: serde_yaml::Value = if dir.join("status.yaml").is_file() {
        serde_yaml::from_str(&std::fs::read_to_string(dir.join("status.yaml"))?)?
    } else {
        serde_yaml::Value::Null
    };

    let intents_dir = dir.join("intents");
    let mut intents = Vec::new();
    if intents_dir.is_dir() {
        for entry in std::fs::read_dir(&intents_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            let alias = path.file_stem().unwrap().to_string_lossy().into_owned();
            let meta = entry.metadata()?;
            let body = std::fs::read_to_string(&path).unwrap_or_default();
            let locked = body.contains("locked: true") || body.contains("status: locked");
            intents.push(IntentInfo {
                alias,
                path,
                locked,
                size_bytes: meta.len(),
            });
        }
    }

    Ok(MeetingState {
        id: args.meeting_id.clone(),
        dir: dir.clone(),
        meeting: serde_json::to_value(meeting_v)?,
        status: serde_json::to_value(status_v)?,
        intents,
        transcript_lines: count_lines(&dir.join("transcript.md")).unwrap_or(0),
        observations_lines: count_lines(&dir.join("observations.md")).unwrap_or(0),
    })
}

#[derive(Debug, Deserialize)]
pub struct ReadMeetingFileArgs {
    pub meeting_id: String,
    pub file: String,
    #[serde(default)]
    pub offset: Option<u64>,
    #[serde(default)]
    pub limit: Option<u64>,
}

#[tauri::command]
pub async fn read_meeting_file(
    state: State<'_, AppState>,
    args: ReadMeetingFileArgs,
) -> Result<String, AppError> {
    let allowed = ["transcript", "observations", "summary", "knowledge-diff"];
    if !allowed.contains(&args.file.as_str()) {
        return Err(AppError::user(
            "file_not_allowed",
            format!("'{}' not in {:?}", args.file, allowed),
        ));
    }
    let path: PathBuf = state
        .paths
        .meetings_repo
        .join("meetings")
        .join(&args.meeting_id)
        .join(format!("{}.md", args.file));
    if !path.is_file() {
        return Ok(String::new());
    }
    let content = std::fs::read_to_string(&path)?;
    if let (Some(off), Some(lim)) = (args.offset, args.limit) {
        // Line-based slicing — matches what the UI wants for tail/scroll.
        let mut out = String::new();
        for line in content.lines().skip(off as usize).take(lim as usize) {
            out.push_str(line);
            out.push('\n');
        }
        Ok(out)
    } else {
        Ok(content)
    }
}

fn count_lines(p: &std::path::Path) -> Result<u64, AppError> {
    if !p.is_file() {
        return Ok(0);
    }
    let s = std::fs::read_to_string(p)?;
    Ok(s.lines().count() as u64)
}
