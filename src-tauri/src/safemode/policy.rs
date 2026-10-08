use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DefaultAction {
    Deny,
    Allow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolClass {
    Read,
    ReadIntrusive,
    Write,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RateLimit {
    pub max: u32,
    pub per_secs: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ToolRuleFile {
    pub class: ToolClass,
    #[serde(default)]
    pub require_approval: bool,
    pub max_payload_bytes: Option<usize>,
    pub rate_limit: Option<RateLimit>,
    #[serde(default)]
    pub allow_patterns: Vec<String>,
    #[serde(default)]
    pub deny_patterns: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PolicyFile {
    pub version: u32,
    pub default: DefaultAction,
    pub tools: HashMap<String, ToolRuleFile>,
    pub approval_timeout_secs: u64,
    pub block_session_after_deny: bool,
}

#[derive(Debug, Clone)]
pub struct CompiledToolRule {
    pub class: ToolClass,
    pub require_approval: bool,
    pub max_payload_bytes: Option<usize>,
    pub rate_limit: Option<RateLimit>,
    pub allow_patterns: Vec<Regex>,
    pub deny_patterns: Vec<Regex>,
}

#[derive(Debug, Clone)]
pub struct Policy {
    pub version: u32,
    pub tools: HashMap<String, CompiledToolRule>,
    pub approval_timeout_secs: u64,
    pub block_session_after_deny: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    NeedsApproval,
    Deny { rule: String },
}

#[derive(Debug)]
pub enum PolicyLoadError {
    Io(std::io::Error),
    Parse(String),
    Validation(String),
}

impl fmt::Display for PolicyLoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PolicyLoadError::Io(e) => write!(f, "{}", e),
            PolicyLoadError::Parse(s) | PolicyLoadError::Validation(s) => write!(f, "{}", s),
        }
    }
}

impl std::error::Error for PolicyLoadError {}

pub fn payload_to_spaced_hex(payload: &[u8]) -> String {
    payload
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(" ")
}

fn compile_tool_rule(rule: ToolRuleFile) -> Result<CompiledToolRule, PolicyLoadError> {
    let allow_patterns = rule
        .allow_patterns
        .iter()
        .map(|p| {
            Regex::new(p).map_err(|e| PolicyLoadError::Validation(format!("allow pattern: {}", e)))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let deny_patterns = rule
        .deny_patterns
        .iter()
        .map(|p| {
            Regex::new(p).map_err(|e| PolicyLoadError::Validation(format!("deny pattern: {}", e)))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CompiledToolRule {
        class: rule.class,
        require_approval: rule.require_approval,
        max_payload_bytes: rule.max_payload_bytes,
        rate_limit: rule.rate_limit,
        allow_patterns,
        deny_patterns,
    })
}

pub fn parse_policy_json(json: &str) -> Result<Policy, PolicyLoadError> {
    let file: PolicyFile =
        serde_json::from_str(json).map_err(|e| PolicyLoadError::Parse(e.to_string()))?;
    if file.default != DefaultAction::Deny {
        return Err(PolicyLoadError::Validation(
            "policy default must be deny".into(),
        ));
    }
    let mut tools = HashMap::new();
    for (name, rule) in file.tools {
        tools.insert(name, compile_tool_rule(rule)?);
    }
    Ok(Policy {
        version: file.version,
        tools,
        approval_timeout_secs: file.approval_timeout_secs,
        block_session_after_deny: file.block_session_after_deny,
    })
}

pub fn default_policy_document() -> Policy {
    let json = r#"{
  "version": 1,
  "default": "deny",
  "tools": {
    "read_more_lines": { "class": "read" },
    "search_pattern": { "class": "read" },
    "get_device_metadata": { "class": "read" },
    "analyze_binary_structure": { "class": "read" },
    "probe_baud_rate": { "class": "read_intrusive", "rate_limit": { "max": 3, "per_secs": 60 } },
    "send_bytes": {
      "class": "write",
      "require_approval": true,
      "max_payload_bytes": 64,
      "rate_limit": { "max": 2, "per_secs": 60 },
      "deny_patterns": ["^01 (05|06|0F|10) "],
      "allow_patterns": []
    }
  },
  "approval_timeout_secs": 60,
  "block_session_after_deny": true
}"#;
    parse_policy_json(json).expect("embedded default policy must be valid")
}

pub fn load_policy_from_path(path: &Path) -> Result<Policy, PolicyLoadError> {
    let json = fs::read_to_string(path).map_err(PolicyLoadError::Io)?;
    parse_policy_json(&json)
}

pub fn write_default_policy_file(path: &Path) -> Result<Policy, PolicyLoadError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(PolicyLoadError::Io)?;
    }
    let policy = default_policy_document();
    let json = serde_json::to_string_pretty(&default_policy_serializable())
        .map_err(|e| PolicyLoadError::Parse(e.to_string()))?;
    fs::write(path, json).map_err(PolicyLoadError::Io)?;
    Ok(policy)
}

/// JSON shape for persisting the safe default (matches `default_policy_document`).
fn default_policy_serializable() -> PolicyFile {
    PolicyFile {
        version: 1,
        default: DefaultAction::Deny,
        tools: HashMap::from([
            (
                "read_more_lines".to_string(),
                ToolRuleFile {
                    class: ToolClass::Read,
                    require_approval: false,
                    max_payload_bytes: None,
                    rate_limit: None,
                    allow_patterns: vec![],
                    deny_patterns: vec![],
                },
            ),
            (
                "search_pattern".to_string(),
                ToolRuleFile {
                    class: ToolClass::Read,
                    require_approval: false,
                    max_payload_bytes: None,
                    rate_limit: None,
                    allow_patterns: vec![],
                    deny_patterns: vec![],
                },
            ),
            (
                "get_device_metadata".to_string(),
                ToolRuleFile {
                    class: ToolClass::Read,
                    require_approval: false,
                    max_payload_bytes: None,
                    rate_limit: None,
                    allow_patterns: vec![],
                    deny_patterns: vec![],
                },
            ),
            (
                "analyze_binary_structure".to_string(),
                ToolRuleFile {
                    class: ToolClass::Read,
                    require_approval: false,
                    max_payload_bytes: None,
                    rate_limit: None,
                    allow_patterns: vec![],
                    deny_patterns: vec![],
                },
            ),
            (
                "probe_baud_rate".to_string(),
                ToolRuleFile {
                    class: ToolClass::ReadIntrusive,
                    require_approval: false,
                    max_payload_bytes: None,
                    rate_limit: Some(RateLimit {
                        max: 3,
                        per_secs: 60,
                    }),
                    allow_patterns: vec![],
                    deny_patterns: vec![],
                },
            ),
            (
                "send_bytes".to_string(),
                ToolRuleFile {
                    class: ToolClass::Write,
                    require_approval: true,
                    max_payload_bytes: Some(64),
                    rate_limit: Some(RateLimit {
                        max: 2,
                        per_secs: 60,
                    }),
                    allow_patterns: vec![],
                    deny_patterns: vec!["^01 (05|06|0F|10) ".to_string()],
                },
            ),
        ]),
        approval_timeout_secs: 60,
        block_session_after_deny: true,
    }
}

pub fn load_or_create_policy(path: &Path) -> Result<Policy, PolicyLoadError> {
    if path.exists() {
        load_policy_from_path(path)
    } else {
        write_default_policy_file(path)
    }
}

pub fn evaluate(policy: &Policy, tool: &str, payload: &[u8]) -> Decision {
    let rule = match policy.tools.get(tool) {
        None => {
            return Decision::Deny {
                rule: "unknown_tool".into(),
            };
        }
        Some(r) => r,
    };

    match rule.class {
        ToolClass::Read | ToolClass::ReadIntrusive => Decision::Allow,
        ToolClass::Write => evaluate_write(rule, payload),
    }
}

fn evaluate_write(rule: &CompiledToolRule, payload: &[u8]) -> Decision {
    if payload.is_empty() {
        return Decision::Deny {
            rule: "empty_payload".into(),
        };
    }
    if let Some(max) = rule.max_payload_bytes {
        if payload.len() > max {
            return Decision::Deny {
                rule: "max_payload_bytes".into(),
            };
        }
    }

    let hex = payload_to_spaced_hex(payload);

    for pattern in &rule.deny_patterns {
        if pattern.is_match(&hex) {
            return Decision::Deny {
                rule: "deny_pattern".into(),
            };
        }
    }

    if !rule.allow_patterns.is_empty() {
        let any_allow = rule.allow_patterns.iter().any(|p| p.is_match(&hex));
        if !any_allow {
            return Decision::Deny {
                rule: "allow_pattern".into(),
            };
        }
    }

    if rule.require_approval {
        Decision::NeedsApproval
    } else {
        Decision::Allow
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_policy_json() -> &'static str {
        r#"{
  "version": 1,
  "default": "deny",
  "tools": {
    "read_more_lines": { "class": "read" },
    "send_bytes": {
      "class": "write",
      "require_approval": true,
      "max_payload_bytes": 64,
      "deny_patterns": ["^01 (05|06|0F|10) "],
      "allow_patterns": ["^01 03 "]
    }
  },
  "approval_timeout_secs": 60,
  "block_session_after_deny": true
}"#
    }

    #[test]
    fn loads_valid_policy_file() {
        let policy = parse_policy_json(sample_policy_json()).unwrap();
        assert_eq!(policy.version, 1);
        assert!(policy.tools.contains_key("send_bytes"));
    }

    #[test]
    fn rejects_default_allow() {
        let json = sample_policy_json().replace("\"deny\"", "\"allow\"");
        let err = parse_policy_json(&json).unwrap_err();
        assert!(matches!(err, PolicyLoadError::Validation(_)));
    }

    #[test]
    fn rejects_unknown_top_level_key() {
        let json = sample_policy_json().replace(
            "\"block_session_after_deny\": true",
            "\"block_session_after_deny\": true, \"extra\": true",
        );
        assert!(parse_policy_json(&json).is_err());
    }

    #[test]
    fn rejects_invalid_regex() {
        let json = sample_policy_json().replace("^01 03 ", "[invalid");
        assert!(parse_policy_json(&json).is_err());
    }

    #[test]
    fn unknown_tool_denied() {
        let policy = parse_policy_json(sample_policy_json()).unwrap();
        assert_eq!(
            evaluate(&policy, "nonexistent_tool", &[]),
            Decision::Deny {
                rule: "unknown_tool".into()
            }
        );
    }

    #[test]
    fn read_tool_allowed() {
        let policy = parse_policy_json(sample_policy_json()).unwrap();
        assert_eq!(evaluate(&policy, "read_more_lines", &[]), Decision::Allow);
    }

    #[test]
    fn send_bytes_needs_approval_when_allowed() {
        let policy = parse_policy_json(sample_policy_json()).unwrap();
        let payload = [0x01, 0x03, 0x00];
        assert_eq!(
            evaluate(&policy, "send_bytes", &payload),
            Decision::NeedsApproval
        );
    }

    #[test]
    fn oversize_payload_denied() {
        let policy = parse_policy_json(sample_policy_json()).unwrap();
        let payload = vec![0u8; 65];
        assert_eq!(
            evaluate(&policy, "send_bytes", &payload),
            Decision::Deny {
                rule: "max_payload_bytes".into()
            }
        );
    }

    #[test]
    fn deny_pattern_beats_allow() {
        let policy = parse_policy_json(sample_policy_json()).unwrap();
        let payload = [0x01, 0x05, 0x00];
        assert_eq!(
            evaluate(&policy, "send_bytes", &payload),
            Decision::Deny {
                rule: "deny_pattern".into()
            }
        );
    }

    #[test]
    fn nonempty_allow_list_requires_match() {
        let policy = parse_policy_json(sample_policy_json()).unwrap();
        let payload = [0x1B, 0x54, 0x0D, 0x0A];
        assert_eq!(
            evaluate(&policy, "send_bytes", &payload),
            Decision::Deny {
                rule: "allow_pattern".into()
            }
        );
    }

    #[test]
    fn empty_allow_list_does_not_deny_by_allow() {
        let policy = default_policy_document();
        let payload = [0x1B, 0x54, 0x0D, 0x0A];
        assert_eq!(
            evaluate(&policy, "send_bytes", &payload),
            Decision::NeedsApproval
        );
    }

    #[test]
    fn empty_payload_denied_for_write() {
        let policy = parse_policy_json(sample_policy_json()).unwrap();
        assert_eq!(
            evaluate(&policy, "send_bytes", &[]),
            Decision::Deny {
                rule: "empty_payload".into()
            }
        );
    }

    #[test]
    fn corrupt_file_fail_closed_on_load() {
        let dir = std::env::temp_dir().join(format!("omnibridge-safemode-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("safemode-policy.json");
        fs::write(&path, "{ not json").unwrap();
        assert!(load_policy_from_path(&path).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn load_or_create_writes_default_when_missing() {
        let dir =
            std::env::temp_dir().join(format!("omnibridge-safemode-create-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("safemode-policy.json");
        let _ = fs::remove_file(&path);
        let policy = load_or_create_policy(&path).unwrap();
        assert!(path.exists());
        assert!(policy.tools["send_bytes"].allow_patterns.is_empty());
        let _ = fs::remove_dir_all(dir);
    }
}
