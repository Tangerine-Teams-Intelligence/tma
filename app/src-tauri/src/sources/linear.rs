//! Linear writeback — opens a new "decision recorded" issue on the linked
//! project. Used when an atom-decision is finalised in
//! `~/.tangerine-memory/decisions/*.md` and frontmatter has `source: linear`.
//!
//! Linear API model: a single GraphQL endpoint at `https://api.linear.app/graphql`,
//! authenticated with a personal API key in the `Authorization` header. We
//! pull the key from the existing `.env` allowlist (`LINEAR_API_KEY`) — no
//! new auth flow is added.
//!
//! On success we issue a `issueCreate` mutation:
//!   - title  ← decision frontmatter `title:` (or filename stem)
//!   - description ← full decision body (post-frontmatter)
//!   - stateId ← team's "Done" state UUID, looked up via `team(id) { states { … } }`
//!   - labelIds ← `tangerine-decision` label, lazily created if absent
//!
//! We resolve the team UUID from the captured atom's `external_id`. Linear
//! issue identifiers like `ENG-123` carry the team key prefix, but the
//! mutation needs a UUID. Path:
//!   1. Strip the numeric suffix to get the team key (`ENG-123` → `ENG`).
//!   2. GraphQL `teams(filter:{key:{eq:"ENG"}})` → `id`.
//!
//! For tests we factor everything that isn't HTTP into pure functions
//! (`format_linear_issue_input`, `parse_team_key`) and assert on shape.

use serde::{Deserialize, Serialize};
use std::path::Path;

use super::{SourceProvenance, WritebackOutcome};
use crate::commands::env::load_env_file;
use crate::commands::AppError;

const LINEAR_API: &str = "https://api.linear.app/graphql";
const LABEL_NAME: &str = "tangerine-decision";

/// Shape we POST to Linear's `issueCreate` mutation. Pulled out as a
/// separate struct so the test suite can assert on field names without
/// instantiating an HTTP client.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct LinearIssueInput {
    pub title: String,
    pub description: String,
    pub team_id: String,
    /// Linear's `state` UUID for the team's "Done" workflow column.
    pub state_id: Option<String>,
    pub label_ids: Vec<String>,
}

/// Build the `LinearIssueInput` from a parsed decision provenance and the
/// resolved team / state / label IDs. Keeps the HTTP path testable.
pub fn format_linear_issue_input(
    prov: &SourceProvenance,
    team_id: &str,
    state_id: Option<&str>,
    label_ids: &[String],
) -> LinearIssueInput {
    let title = if prov.title.trim().is_empty() {
        // Fall back to the filename stem so we never POST an empty title.
        prov.filename
            .strip_suffix(".md")
            .unwrap_or(&prov.filename)
            .to_string()
    } else {
        prov.title.clone()
    };
    let description = build_description(prov);
    LinearIssueInput {
        title,
        description,
        team_id: team_id.to_string(),
        state_id: state_id.map(|s| s.to_string()),
        label_ids: label_ids.to_vec(),
    }
}

/// Compose the Linear issue description. We embed the full decision body
/// (which already includes any `## Decision` / `## Context` headings) and
/// append a footer linking back to the source memory file.
fn build_description(prov: &SourceProvenance) -> String {
    let body = prov.body.trim();
    let footer = format!(
        "\n\n---\n_Source: ~/.tangerine-memory/decisions/{}_",
        prov.filename
    );
    let prefix = "🍊 **Tangerine — decision recorded**\n\n";
    if body.is_empty() {
        format!("{}{}{}", prefix, prov.summary, footer)
    } else {
        format!("{}{}{}", prefix, body, footer)
    }
}

/// Pull the team key out of a Linear issue identifier (`ENG-123` → `ENG`).
/// Returns `None` when the format isn't recognisable.
pub fn parse_team_key(external_id: &str) -> Option<String> {
    let s = external_id.trim();
    let dash = s.find('-')?;
    let key = &s[..dash];
    let num = &s[dash + 1..];
    if key.is_empty() || num.is_empty() || !num.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    Some(key.to_string())
}

/// True when `writeback.linear.enabled` is set to `true` in `~/.tmi/config.yaml`.
pub fn writeback_enabled(config_path: &Path) -> bool {
    let yaml = match std::fs::read_to_string(config_path) {
        Ok(y) => y,
        Err(_) => return false,
    };
    let parsed: serde_yaml::Value = match serde_yaml::from_str(&yaml) {
        Ok(p) => p,
        Err(_) => return false,
    };
    parsed
        .get("writeback")
        .and_then(|w| w.get("linear"))
        .and_then(|l| l.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Resolve the Linear API key from the existing user `.env` file. Returns
/// `None` when the key isn't set; the caller surfaces a `Failed` outcome
/// with a "set LINEAR_API_KEY in Settings → Secrets" message.
pub fn resolve_linear_key(env_file: &Path) -> Option<String> {
    let entries = load_env_file(env_file).ok()?;
    entries.into_iter().find_map(|(k, v)| {
        if k == "LINEAR_API_KEY" && !v.is_empty() {
            Some(v)
        } else {
            None
        }
    })
}

// ----------------------------------------------------------------------
// GraphQL plumbing
//
// We hand-roll GraphQL strings rather than pull in a full client (juniper /
// async-graphql / cynic) — the contact surface is three queries and one
// mutation, all string-templated.

#[derive(Debug, Serialize)]
struct GqlBody<'a> {
    query: &'a str,
    variables: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct GqlResponse<T> {
    data: Option<T>,
    #[serde(default)]
    errors: Vec<GqlError>,
}

#[derive(Debug, Deserialize)]
struct GqlError {
    message: String,
}

async fn gql_send<T: for<'de> Deserialize<'de>>(
    http: &reqwest::Client,
    api_key: &str,
    query: &str,
    vars: serde_json::Value,
) -> Result<T, String> {
    let body = GqlBody {
        query,
        variables: vars,
    };
    let res = http
        .post(LINEAR_API)
        .header("Authorization", api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("linear http: {}", e))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("linear body: {}", e))?;
    if !status.is_success() {
        return Err(format!("linear {} : {}", status.as_u16(), trim(&text, 200)));
    }
    let parsed: GqlResponse<T> = serde_json::from_str(&text)
        .map_err(|e| format!("linear parse: {} (raw: {})", e, trim(&text, 200)))?;
    if !parsed.errors.is_empty() {
        return Err(format!(
            "linear graphql: {}",
            parsed
                .errors
                .into_iter()
                .map(|e| e.message)
                .collect::<Vec<_>>()
                .join("; ")
        ));
    }
    parsed.data.ok_or_else(|| "linear: no data field".into())
}

#[derive(Debug, Deserialize)]
struct TeamLookup {
    teams: TeamConnection,
}
#[derive(Debug, Deserialize)]
struct TeamConnection {
    nodes: Vec<TeamNode>,
}
#[derive(Debug, Deserialize)]
struct TeamNode {
    id: String,
    states: StateConnection,
    labels: LabelConnection,
}
#[derive(Debug, Deserialize)]
struct StateConnection {
    nodes: Vec<StateNode>,
}
#[derive(Debug, Deserialize)]
struct StateNode {
    id: String,
    name: String,
    #[serde(default)]
    #[allow(dead_code)]
    type_: String,
}
#[derive(Debug, Deserialize)]
struct LabelConnection {
    nodes: Vec<LabelNode>,
}
#[derive(Debug, Deserialize)]
struct LabelNode {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct LabelCreateResult {
    #[serde(rename = "issueLabelCreate")]
    issue_label_create: IssueLabelCreateBody,
}
#[derive(Debug, Deserialize)]
struct IssueLabelCreateBody {
    #[serde(rename = "issueLabel")]
    issue_label: LabelNode,
}

#[derive(Debug, Deserialize)]
struct IssueCreateResult {
    #[serde(rename = "issueCreate")]
    issue_create: IssueCreateBody,
}
#[derive(Debug, Deserialize)]
struct IssueCreateBody {
    success: bool,
    issue: Option<IssueNode>,
}
#[derive(Debug, Deserialize)]
struct IssueNode {
    #[allow(dead_code)]
    id: String,
    url: String,
}

const QUERY_TEAM_BY_KEY: &str = r#"
query TeamByKey($key: String!) {
  teams(filter: { key: { eq: $key } }) {
    nodes {
      id
      states {
        nodes { id name type_:type }
      }
      labels {
        nodes { id name }
      }
    }
  }
}
"#;

const MUTATION_LABEL_CREATE: &str = r#"
mutation CreateLabel($name: String!, $teamId: String!) {
  issueLabelCreate(input: { name: $name, teamId: $teamId }) {
    issueLabel { id name }
  }
}
"#;

const MUTATION_ISSUE_CREATE: &str = r#"
mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id url }
  }
}
"#;

/// Look up the `tangerine-decision` label, creating it when absent.
async fn ensure_label(
    http: &reqwest::Client,
    api_key: &str,
    team_id: &str,
    existing: &[LabelNode],
) -> Result<String, String> {
    if let Some(found) = existing.iter().find(|l| l.name == LABEL_NAME) {
        return Ok(found.id.clone());
    }
    let res: LabelCreateResult = gql_send(
        http,
        api_key,
        MUTATION_LABEL_CREATE,
        serde_json::json!({ "name": LABEL_NAME, "teamId": team_id }),
    )
    .await?;
    Ok(res.issue_label_create.issue_label.id)
}

/// Public entry point: post a fresh "decision recorded" issue. See module
/// docstring for the full flow.
pub async fn writeback_decision(
    http: &reqwest::Client,
    config_path: &Path,
    env_file: &Path,
    prov: &SourceProvenance,
) -> Result<WritebackOutcome, AppError> {
    if !writeback_enabled(config_path) {
        return Ok(WritebackOutcome::Disabled);
    }
    let team_key = match parse_team_key(&prov.external_id) {
        Some(k) => k,
        None => {
            return Ok(WritebackOutcome::NotApplicable {
                reason: format!(
                    "decision frontmatter source_id='{}' is not a Linear issue id",
                    prov.external_id
                ),
            });
        }
    };
    let api_key = match resolve_linear_key(env_file) {
        Some(k) => k,
        None => {
            return Ok(WritebackOutcome::Failed {
                error: "LINEAR_API_KEY is not set in the user .env. Set it via Settings → Secrets and try again.".into(),
            });
        }
    };

    // 1. Resolve team UUID + states + labels in one round-trip.
    let team_resp: TeamLookup = match gql_send(
        http,
        &api_key,
        QUERY_TEAM_BY_KEY,
        serde_json::json!({ "key": team_key }),
    )
    .await
    {
        Ok(r) => r,
        Err(e) => return Ok(WritebackOutcome::Failed { error: e }),
    };
    let team = match team_resp.teams.nodes.into_iter().next() {
        Some(t) => t,
        None => {
            return Ok(WritebackOutcome::Failed {
                error: format!("Linear team key '{}' not found", team_key),
            })
        }
    };
    // 2. Find the Done state — case-insensitive match on state name.
    let state_id = team
        .states
        .nodes
        .iter()
        .find(|s| s.name.eq_ignore_ascii_case("Done"))
        .map(|s| s.id.clone());
    // 3. Ensure the `tangerine-decision` label exists.
    let label_id = match ensure_label(http, &api_key, &team.id, &team.labels.nodes).await {
        Ok(id) => id,
        Err(e) => return Ok(WritebackOutcome::Failed { error: e }),
    };
    let input = format_linear_issue_input(prov, &team.id, state_id.as_deref(), &[label_id]);
    let issue_resp: IssueCreateResult = match gql_send(
        http,
        &api_key,
        MUTATION_ISSUE_CREATE,
        serde_json::json!({
            "input": {
                "title": input.title,
                "description": input.description,
                "teamId": input.team_id,
                "stateId": input.state_id,
                "labelIds": input.label_ids,
            }
        }),
    )
    .await
    {
        Ok(r) => r,
        Err(e) => return Ok(WritebackOutcome::Failed { error: e }),
    };
    let body = issue_resp.issue_create;
    if !body.success || body.issue.is_none() {
        return Ok(WritebackOutcome::Failed {
            error: "Linear issueCreate returned success=false".into(),
        });
    }
    let url = body.issue.unwrap().url;
    Ok(WritebackOutcome::Posted {
        external_url: url,
        kind: "linear_issue".into(),
    })
}

fn trim(s: &str, max: usize) -> String {
    let mut out: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_prov() -> SourceProvenance {
        SourceProvenance {
            source: "linear".into(),
            external_id: "ENG-456".into(),
            title: "Ship Q2 OKRs by Friday".into(),
            summary: "Ship the OKRs.".into(),
            body: "## Decision\n\nShip the OKRs.\n\n## Context\n\nQ1 set the bar.".into(),
            filename: "ship-okrs.md".into(),
        }
    }

    #[test]
    fn test_writeback_format_linear_issue() {
        // The prompt's spec contract: title + body shape.
        let prov = sample_prov();
        let input = format_linear_issue_input(&prov, "team-uuid-123", Some("state-done"), &["lbl-tg".into()]);
        // Title comes from frontmatter.
        assert_eq!(input.title, "Ship Q2 OKRs by Friday");
        // Description embeds the body and has the source footer.
        assert!(input.description.contains("Ship the OKRs"));
        assert!(input.description.contains("## Context"));
        assert!(input.description.contains("~/.tangerine-memory/decisions/ship-okrs.md"));
        assert!(input.description.contains("🍊"));
        // Team + state + label propagate.
        assert_eq!(input.team_id, "team-uuid-123");
        assert_eq!(input.state_id.as_deref(), Some("state-done"));
        assert_eq!(input.label_ids, vec!["lbl-tg".to_string()]);
    }

    #[test]
    fn empty_title_falls_back_to_filename_stem() {
        let mut prov = sample_prov();
        prov.title = String::new();
        let input = format_linear_issue_input(&prov, "tid", None, &[]);
        assert_eq!(input.title, "ship-okrs");
    }

    #[test]
    fn empty_body_uses_summary() {
        let mut prov = sample_prov();
        prov.body = String::new();
        let input = format_linear_issue_input(&prov, "tid", None, &[]);
        assert!(input.description.contains("Ship the OKRs."));
    }

    #[test]
    fn parse_team_key_works() {
        assert_eq!(parse_team_key("ENG-123"), Some("ENG".to_string()));
        assert_eq!(parse_team_key("DESIGN-7"), Some("DESIGN".to_string()));
        assert_eq!(parse_team_key("eng-123"), Some("eng".to_string()));
    }

    #[test]
    fn parse_team_key_rejects_garbage() {
        assert_eq!(parse_team_key("not-an-id"), None);
        assert_eq!(parse_team_key("ENG"), None);
        assert_eq!(parse_team_key("-123"), None);
        assert_eq!(parse_team_key("ENG-"), None);
        assert_eq!(parse_team_key("ENG-abc"), None);
    }

    #[test]
    fn resolve_linear_key_reads_env_file() {
        let dir = std::env::temp_dir().join(format!("ti-linear-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let env_path = dir.join(".env");
        std::fs::write(&env_path, "LINEAR_API_KEY=\"lin_api_test123\"\nOPENAI_API_KEY=\"sk-x\"\n").unwrap();
        assert_eq!(resolve_linear_key(&env_path), Some("lin_api_test123".to_string()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn resolve_linear_key_returns_none_when_missing() {
        let dir = std::env::temp_dir().join(format!("ti-linear-noenv-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let env_path = dir.join(".env");
        std::fs::write(&env_path, "OPENAI_API_KEY=\"sk-x\"\n").unwrap();
        assert!(resolve_linear_key(&env_path).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn writeback_enabled_default_false() {
        let dir = std::env::temp_dir().join(format!("ti-linear-cfg-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("config.yaml");
        assert!(!writeback_enabled(&cfg));
        std::fs::write(&cfg, "writeback:\n  linear:\n    enabled: true\n").unwrap();
        assert!(writeback_enabled(&cfg));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn trim_truncates() {
        let s = "x".repeat(500);
        let r = trim(&s, 100);
        assert!(r.chars().count() <= 101);
        assert!(r.ends_with('…'));
    }
}
