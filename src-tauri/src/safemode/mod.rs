pub mod approval;
pub mod audit;
pub mod gate;
pub mod policy;
pub mod rate_limit;

use policy::{Decision, Policy};
use rate_limit::RateLimiter;
use std::path::Path;

#[derive(Debug)]
pub struct PolicyEngine {
    policy: Option<Policy>,
    policy_invalid: bool,
    rate_limiter: RateLimiter,
    session_blocked: bool,
}

impl PolicyEngine {
    pub fn from_policy(policy: Policy) -> Self {
        Self {
            policy: Some(policy),
            policy_invalid: false,
            rate_limiter: RateLimiter::new(),
            session_blocked: false,
        }
    }

    pub fn fail_closed() -> Self {
        Self {
            policy: None,
            policy_invalid: true,
            rate_limiter: RateLimiter::new(),
            session_blocked: false,
        }
    }

    pub fn load_from_path(path: &Path) -> Self {
        match policy::load_or_create_policy(path) {
            Ok(p) => Self::from_policy(p),
            Err(_) => Self::fail_closed(),
        }
    }

    pub fn is_policy_invalid(&self) -> bool {
        self.policy_invalid
    }

    pub fn approval_timeout_secs(&self) -> u64 {
        self.policy
            .as_ref()
            .map(|p| p.approval_timeout_secs)
            .unwrap_or(60)
    }

    pub fn begin_session(&mut self) {
        self.session_blocked = false;
    }

    pub fn record_denied(&mut self) {
        if let Some(policy) = &self.policy {
            if policy.block_session_after_deny {
                self.session_blocked = true;
            }
        }
    }

    pub fn evaluate(&mut self, tool: &str, payload: &[u8], now_ms: u64) -> Decision {
        if self.policy_invalid {
            if known_read_tool(tool) {
                return Decision::Allow;
            }
            if tool == "send_bytes" {
                return Decision::Deny {
                    rule: "policy_invalid".into(),
                };
            }
            return Decision::Deny {
                rule: "unknown_tool".into(),
            };
        }

        if tool == "send_bytes" && self.session_blocked {
            return Decision::Deny {
                rule: "session_blocked".into(),
            };
        }

        let policy = self
            .policy
            .as_ref()
            .expect("policy present when not invalid");

        let decision = policy::evaluate(policy, tool, payload);
        if matches!(decision, Decision::Deny { .. }) {
            return decision;
        }

        let rule = policy.tools.get(tool);
        if let Some(rule) = rule {
            if let Some(limit) = &rule.rate_limit {
                if !self.rate_limiter.allow(tool, limit, now_ms) {
                    return Decision::Deny {
                        rule: "rate_limited".into(),
                    };
                }
            }
        }

        decision
    }
}

fn known_read_tool(tool: &str) -> bool {
    matches!(
        tool,
        "read_more_lines"
            | "search_pattern"
            | "get_device_metadata"
            | "analyze_binary_structure"
            | "probe_baud_rate"
    )
}

impl Default for PolicyEngine {
    fn default() -> Self {
        Self::from_policy(policy::default_policy_document())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use policy::parse_policy_json;

    fn engine_with_send_bytes() -> PolicyEngine {
        PolicyEngine::from_policy(
            parse_policy_json(
                r#"{
  "version": 1,
  "default": "deny",
  "tools": {
    "send_bytes": {
      "class": "write",
      "require_approval": true,
      "max_payload_bytes": 64,
      "rate_limit": { "max": 2, "per_secs": 60 },
      "deny_patterns": [],
      "allow_patterns": []
    }
  },
  "approval_timeout_secs": 60,
  "block_session_after_deny": true
}"#,
            )
            .unwrap(),
        )
    }

    #[test]
    fn session_block_after_record_denied() {
        let mut engine = engine_with_send_bytes();
        let payload = [0x1B, 0x54];
        assert_eq!(
            engine.evaluate("send_bytes", &payload, 0),
            Decision::NeedsApproval
        );
        engine.record_denied();
        assert_eq!(
            engine.evaluate("send_bytes", &payload, 1),
            Decision::Deny {
                rule: "session_blocked".into()
            }
        );
    }

    #[test]
    fn begin_session_clears_block_not_rate_limit() {
        let mut engine = engine_with_send_bytes();
        let payload = [0x1B, 0x54];
        assert!(matches!(
            engine.evaluate("send_bytes", &payload, 0),
            Decision::NeedsApproval
        ));
        assert!(matches!(
            engine.evaluate("send_bytes", &payload, 1),
            Decision::NeedsApproval
        ));
        assert_eq!(
            engine.evaluate("send_bytes", &payload, 2),
            Decision::Deny {
                rule: "rate_limited".into(),
            }
        );
        engine.record_denied();
        engine.begin_session();
        assert_eq!(
            engine.evaluate("send_bytes", &payload, 3),
            Decision::Deny {
                rule: "rate_limited".into(),
            }
        );
    }

    #[test]
    fn invalid_policy_denies_writes_and_allows_known_reads() {
        let mut engine = PolicyEngine::fail_closed();
        assert_eq!(
            engine.evaluate("send_bytes", &[0x01], 0),
            Decision::Deny {
                rule: "policy_invalid".into()
            }
        );
        assert_eq!(engine.evaluate("read_more_lines", &[], 0), Decision::Allow);
        assert_eq!(
            engine.evaluate("not_a_tool", &[], 0),
            Decision::Deny {
                rule: "unknown_tool".into()
            }
        );
    }

    #[test]
    fn load_invalid_file_is_fail_closed() {
        let dir =
            std::env::temp_dir().join(format!("omnibridge-safemode-engine-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("safemode-policy.json");
        std::fs::write(&path, "not-json").unwrap();
        let mut engine = PolicyEngine::load_from_path(&path);
        assert!(engine.is_policy_invalid());
        assert_eq!(
            engine.evaluate("send_bytes", &[0x01], 0),
            Decision::Deny {
                rule: "policy_invalid".into()
            }
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
