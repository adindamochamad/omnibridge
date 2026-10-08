use crate::safemode::policy::Decision;
use crate::safemode::PolicyEngine;
use crate::write_to_port;
use crate::MonitorRegistry;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, PartialEq)]
pub(crate) enum AgentSendPlan {
    Blocked(AgentSendBytesResponse),
    WriteRealPort,
    SimulatedDemo,
}

#[derive(Debug)]
pub struct SafeModeState {
    inner: Mutex<SafeModeInner>,
}

#[derive(Debug)]
struct SafeModeInner {
    engine: PolicyEngine,
    #[allow(dead_code)]
    enabled: bool,
}

impl SafeModeState {
    pub fn new(policy_path: PathBuf) -> Self {
        Self {
            inner: Mutex::new(SafeModeInner {
                engine: PolicyEngine::load_from_path(&policy_path),
                enabled: true,
            }),
        }
    }

    #[cfg(test)]
    pub fn with_engine(engine: PolicyEngine) -> Self {
        Self {
            inner: Mutex::new(SafeModeInner {
                engine,
                enabled: true,
            }),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthorizeToolResponse {
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AgentSendBytesResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub simulated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_sent: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

fn blocked_tool_response(reason: &str) -> AuthorizeToolResponse {
    AuthorizeToolResponse {
        allowed: false,
        blocked: Some(true),
        reason: Some(reason.to_string()),
        retry: Some("do_not_retry".to_string()),
        message: Some(agent_blocked_message(reason)),
    }
}

fn agent_blocked_message(reason: &str) -> String {
    format!(
        "Safe Mode blocked this action ({reason}). Do not call send_bytes again in this investigation; continue with read-only tools."
    )
}

fn blocked_send_response(reason: &str) -> AgentSendBytesResponse {
    AgentSendBytesResponse {
        ok: false,
        blocked: Some(true),
        simulated: None,
        bytes_sent: None,
        reason: Some(reason.to_string()),
        retry: Some("do_not_retry".to_string()),
        message: Some(agent_blocked_message(reason)),
    }
}

pub fn authorize_tool_inner(
    engine: &mut PolicyEngine,
    tool_name: &str,
    now_ms: u64,
) -> AuthorizeToolResponse {
    if tool_name == "send_bytes" {
        if engine.is_policy_invalid() {
            return blocked_tool_response("safe_mode_policy_invalid");
        }
        return AuthorizeToolResponse {
            allowed: true,
            blocked: None,
            reason: None,
            retry: None,
            message: None,
        };
    }

    match engine.evaluate(tool_name, &[], now_ms) {
        Decision::Allow => AuthorizeToolResponse {
            allowed: true,
            blocked: None,
            reason: None,
            retry: None,
            message: None,
        },
        Decision::NeedsApproval => blocked_tool_response("needs_approval"),
        Decision::Deny { rule } => blocked_tool_response(&format!("policy_denied:{rule}")),
    }
}

pub(crate) fn plan_agent_send_bytes(
    engine: &mut PolicyEngine,
    port: &str,
    data: &[u8],
    now_ms: u64,
) -> AgentSendPlan {
    if port.starts_with("demo://") {
        return plan_agent_send_demo(engine, data, now_ms);
    }

    match engine.evaluate("send_bytes", data, now_ms) {
        Decision::Deny { rule } => {
            engine.record_denied();
            AgentSendPlan::Blocked(blocked_send_response(&format!("policy_denied:{rule}")))
        }
        Decision::NeedsApproval => {
            // M2: approval UI not wired — treat as deny (no write).
            engine.record_denied();
            AgentSendPlan::Blocked(blocked_send_response("needs_approval"))
        }
        Decision::Allow => AgentSendPlan::WriteRealPort,
    }
}

fn plan_agent_send_demo(engine: &mut PolicyEngine, data: &[u8], now_ms: u64) -> AgentSendPlan {
    match engine.evaluate("send_bytes", data, now_ms) {
        Decision::Deny { rule } => {
            engine.record_denied();
            AgentSendPlan::Blocked(blocked_send_response(&format!("policy_denied:{rule}")))
        }
        Decision::NeedsApproval => {
            engine.record_denied();
            AgentSendPlan::Blocked(blocked_send_response("needs_approval"))
        }
        Decision::Allow => AgentSendPlan::SimulatedDemo,
    }
}

fn success_send_response(byte_count: usize) -> AgentSendBytesResponse {
    AgentSendBytesResponse {
        ok: true,
        blocked: None,
        simulated: None,
        bytes_sent: Some(byte_count as u32),
        reason: None,
        retry: None,
        message: None,
    }
}

fn simulated_send_response(byte_count: usize) -> AgentSendBytesResponse {
    AgentSendBytesResponse {
        ok: false,
        blocked: Some(false),
        simulated: Some(true),
        bytes_sent: Some(byte_count as u32),
        reason: None,
        retry: None,
        message: None,
    }
}

pub(crate) fn execute_agent_send_plan(
    plan: AgentSendPlan,
    registry: &MonitorRegistry,
    port: &str,
    data: &[u8],
) -> AgentSendBytesResponse {
    match plan {
        AgentSendPlan::Blocked(resp) => resp,
        AgentSendPlan::SimulatedDemo => simulated_send_response(data.len()),
        AgentSendPlan::WriteRealPort => match write_to_port(registry, port, data.to_vec()) {
            Ok(()) => success_send_response(data.len()),
            Err(e) => AgentSendBytesResponse {
                ok: false,
                blocked: None,
                simulated: None,
                bytes_sent: None,
                reason: Some("write_error".to_string()),
                retry: None,
                message: Some(e),
            },
        },
    }
}

pub fn begin_session_inner(engine: &mut PolicyEngine) {
    engine.begin_session();
}

#[tauri::command]
pub fn safemode_begin_session(state: tauri::State<'_, SafeModeState>) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    begin_session_inner(&mut inner.engine);
    Ok(())
}

#[tauri::command]
pub fn safemode_authorize_tool(
    state: tauri::State<'_, SafeModeState>,
    tool_name: String,
    input_summary: String,
) -> Result<AuthorizeToolResponse, String> {
    let _ = input_summary;
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    Ok(authorize_tool_inner(
        &mut inner.engine,
        &tool_name,
        now_ms(),
    ))
}

#[allow(private_interfaces)]
#[tauri::command]
pub fn safemode_agent_send_bytes(
    registry: tauri::State<'_, MonitorRegistry>,
    state: tauri::State<'_, SafeModeState>,
    port: String,
    data: Vec<u8>,
    reason: String,
    tool_use_id: String,
) -> Result<AgentSendBytesResponse, String> {
    let _ = (reason, tool_use_id);
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    let reg = registry.inner().clone();
    let plan = plan_agent_send_bytes(&mut inner.engine, &port, &data, now_ms());
    Ok(execute_agent_send_plan(plan, &reg, &port, &data))
}

pub fn init_state(policy_path: &Path) -> SafeModeState {
    SafeModeState::new(policy_path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::safemode::policy::parse_policy_json;

    fn engine_send_bytes_needs_approval() -> PolicyEngine {
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
    fn stub_approval_denies_without_writer_call() {
        let mut engine = engine_send_bytes_needs_approval();
        let plan = plan_agent_send_bytes(&mut engine, "/dev/ttyUSB0", &[0x1B, 0x54], 0);
        assert_eq!(
            plan,
            AgentSendPlan::Blocked(blocked_send_response("needs_approval"))
        );
    }

    #[test]
    fn policy_deny_skips_writer() {
        let mut engine = PolicyEngine::from_policy(
            parse_policy_json(
                r#"{
  "version": 1,
  "default": "deny",
  "tools": {
    "send_bytes": {
      "class": "write",
      "require_approval": false,
      "max_payload_bytes": 2,
      "deny_patterns": [],
      "allow_patterns": []
    }
  },
  "approval_timeout_secs": 60,
  "block_session_after_deny": true
}"#,
            )
            .unwrap(),
        );
        let plan = plan_agent_send_bytes(&mut engine, "p", &[1, 2, 3], 0);
        assert!(matches!(plan, AgentSendPlan::Blocked(_)));
        if let AgentSendPlan::Blocked(resp) = plan {
            assert!(resp.reason.unwrap().starts_with("policy_denied:"));
        }
    }
}
