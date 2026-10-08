use crate::safemode::approval::{wait_for_approval, ApprovalOutcome, ApprovalStore};
use crate::safemode::policy::{payload_to_spaced_hex, Decision};
use crate::safemode::PolicyEngine;
use crate::write_to_port;
use crate::MonitorRegistry;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Debug, PartialEq)]
pub(crate) enum AgentSendPlan {
    Blocked(AgentSendBytesResponse),
    NeedsApproval { is_demo: bool },
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
    approvals: ApprovalStore,
    #[allow(dead_code)]
    enabled: bool,
}

impl SafeModeState {
    pub fn new(policy_path: PathBuf) -> Self {
        Self {
            inner: Mutex::new(SafeModeInner {
                engine: PolicyEngine::load_from_path(&policy_path),
                approvals: ApprovalStore::default(),
                enabled: true,
            }),
        }
    }

    #[cfg(test)]
    pub fn with_engine(engine: PolicyEngine) -> Self {
        Self {
            inner: Mutex::new(SafeModeInner {
                engine,
                approvals: ApprovalStore::default(),
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

fn bytes_to_ascii_display(data: &[u8]) -> String {
    data.iter()
        .map(|b| {
            if (0x20..=0x7e).contains(b) {
                char::from(*b)
            } else {
                '·'
            }
        })
        .collect()
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

fn denied_by_user_response() -> AgentSendBytesResponse {
    AgentSendBytesResponse {
        ok: false,
        blocked: Some(true),
        simulated: None,
        bytes_sent: None,
        reason: Some("denied_by_user".into()),
        retry: Some("do_not_retry".into()),
        message: Some(
            "The human operator denied this write. Do not call send_bytes again in this investigation; continue with read-only tools."
                .into(),
        ),
    }
}

fn timeout_response() -> AgentSendBytesResponse {
    AgentSendBytesResponse {
        ok: false,
        blocked: Some(true),
        simulated: None,
        bytes_sent: None,
        reason: Some("timeout".into()),
        retry: Some("do_not_retry".into()),
        message: Some(agent_blocked_message("timeout")),
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
        Decision::NeedsApproval => AgentSendPlan::NeedsApproval { is_demo: false },
        Decision::Allow => AgentSendPlan::WriteRealPort,
    }
}

fn plan_agent_send_demo(engine: &mut PolicyEngine, data: &[u8], now_ms: u64) -> AgentSendPlan {
    match engine.evaluate("send_bytes", data, now_ms) {
        Decision::Deny { rule } => {
            engine.record_denied();
            AgentSendPlan::Blocked(blocked_send_response(&format!("policy_denied:{rule}")))
        }
        Decision::NeedsApproval => AgentSendPlan::NeedsApproval { is_demo: true },
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
        AgentSendPlan::NeedsApproval { .. } => blocked_send_response("needs_approval"),
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

#[cfg(test)]
pub(crate) fn finish_after_approval(
    outcome: ApprovalOutcome,
    engine: &mut PolicyEngine,
    registry: &MonitorRegistry,
    port: &str,
    data: &[u8],
    is_demo: bool,
) -> AgentSendBytesResponse {
    match outcome {
        ApprovalOutcome::Approved if is_demo => simulated_send_response(data.len()),
        ApprovalOutcome::Approved => match write_to_port(registry, port, data.to_vec()) {
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
        ApprovalOutcome::Denied => {
            engine.record_denied();
            denied_by_user_response()
        }
        ApprovalOutcome::Timeout => {
            engine.record_denied();
            timeout_response()
        }
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

#[tauri::command]
pub fn safemode_resolve_approval(
    state: tauri::State<'_, SafeModeState>,
    id: String,
    approve: bool,
) -> Result<(), String> {
    let sender = {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.approvals.take(&id)
    };
    if let Some(tx) = sender {
        let _ = tx.send(approve);
    }
    Ok(())
}

#[allow(private_interfaces)]
#[tauri::command]
pub async fn safemode_agent_send_bytes(
    app: AppHandle,
    registry: tauri::State<'_, MonitorRegistry>,
    state: tauri::State<'_, SafeModeState>,
    port: String,
    data: Vec<u8>,
    reason: String,
    tool_use_id: String,
) -> Result<AgentSendBytesResponse, String> {
    let reg = registry.inner().clone();

    let plan = {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        plan_agent_send_bytes(&mut inner.engine, &port, &data, now_ms())
    };

    match plan {
        AgentSendPlan::Blocked(resp) => Ok(resp),
        AgentSendPlan::WriteRealPort => Ok(execute_agent_send_plan(
            AgentSendPlan::WriteRealPort,
            &reg,
            &port,
            &data,
        )),
        AgentSendPlan::SimulatedDemo => Ok(simulated_send_response(data.len())),
        AgentSendPlan::NeedsApproval { is_demo } => {
            let (event, rx, timeout_ms, approval_id) = {
                let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
                let timeout_secs = inner.engine.approval_timeout_secs();
                let timeout_ms = timeout_secs * 1000;
                let expires_at = now_ms() + timeout_ms;
                let hex = payload_to_spaced_hex(&data);
                let ascii = bytes_to_ascii_display(&data);
                let (event, rx) = inner.approvals.register(
                    port.clone(),
                    hex,
                    ascii,
                    reason.clone(),
                    tool_use_id.clone(),
                    expires_at,
                );
                let approval_id = event.id.clone();
                (event, rx, timeout_ms, approval_id)
            };

            if let Err(e) = app.emit("safemode:approval_requested", &event) {
                let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
                inner.approvals.cancel(&approval_id);
                return Err(e.to_string());
            }

            let outcome = wait_for_approval(rx, timeout_ms).await?;

            if outcome == ApprovalOutcome::Timeout {
                let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
                inner.approvals.cancel(&approval_id);
            }

            let response = match outcome {
                ApprovalOutcome::Approved if is_demo => simulated_send_response(data.len()),
                ApprovalOutcome::Approved => match write_to_port(&reg, &port, data.to_vec()) {
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
                ApprovalOutcome::Denied => {
                    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
                    inner.engine.record_denied();
                    denied_by_user_response()
                }
                ApprovalOutcome::Timeout => {
                    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
                    inner.engine.record_denied();
                    timeout_response()
                }
            };

            Ok(response)
        }
    }
}

pub fn init_state(policy_path: &Path) -> SafeModeState {
    SafeModeState::new(policy_path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::safemode::policy::parse_policy_json;
    use std::collections::HashMap;
    use std::sync::mpsc::channel;

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
    fn needs_approval_plan_without_write() {
        let mut engine = engine_send_bytes_needs_approval();
        let plan = plan_agent_send_bytes(&mut engine, "/dev/ttyUSB0", &[0x1B, 0x54], 0);
        assert_eq!(plan, AgentSendPlan::NeedsApproval { is_demo: false });
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
    }

    #[test]
    fn approved_finish_writes_once_to_channel() {
        let registry: MonitorRegistry = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        let (write_tx, write_rx) = channel::<Vec<u8>>();
        registry.lock().unwrap().insert(
            "ttyTEST".into(),
            crate::PortRegistration {
                active: true,
                write_tx,
            },
        );
        let mut engine = engine_send_bytes_needs_approval();
        let resp = finish_after_approval(
            ApprovalOutcome::Approved,
            &mut engine,
            &registry,
            "ttyTEST",
            &[0x1B, 0x54],
            false,
        );
        assert!(resp.ok);
        assert_eq!(write_rx.recv().unwrap(), vec![0x1B, 0x54]);
        assert!(write_rx.try_recv().is_err());
    }

    #[test]
    fn denied_finish_skips_writer() {
        let registry: MonitorRegistry = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        let mut engine = engine_send_bytes_needs_approval();
        let resp = finish_after_approval(
            ApprovalOutcome::Denied,
            &mut engine,
            &registry,
            "ttyTEST",
            &[0x1B],
            false,
        );
        assert_eq!(resp.reason.as_deref(), Some("denied_by_user"));
        assert_eq!(resp.retry.as_deref(), Some("do_not_retry"));
    }

    fn registry_with_write_channel() -> (MonitorRegistry, std::sync::mpsc::Receiver<Vec<u8>>) {
        let registry: MonitorRegistry = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        let (write_tx, write_rx) = channel::<Vec<u8>>();
        registry.lock().unwrap().insert(
            "ttyTEST".into(),
            crate::PortRegistration {
                active: true,
                write_tx,
            },
        );
        (registry, write_rx)
    }

    #[test]
    fn timeout_finish_skips_writer() {
        let (registry, write_rx) = registry_with_write_channel();
        let mut engine = engine_send_bytes_needs_approval();
        let resp = finish_after_approval(
            ApprovalOutcome::Timeout,
            &mut engine,
            &registry,
            "ttyTEST",
            &[0x1B, 0x54],
            false,
        );
        assert_eq!(resp.reason.as_deref(), Some("timeout"));
        assert!(write_rx.try_recv().is_err());
    }

    #[test]
    fn late_take_after_cancel_does_not_write() {
        use crate::safemode::approval::ApprovalStore;

        let mut store = ApprovalStore::default();
        let (event, _rx) = store.register(
            "ttyTEST".into(),
            "1B 54".into(),
            "·T".into(),
            "r".into(),
            "tu1".into(),
            0,
        );
        store.cancel(&event.id);
        assert!(store.take(&event.id).is_none());

        let (registry, write_rx) = registry_with_write_channel();
        let mut engine = engine_send_bytes_needs_approval();
        let resp = finish_after_approval(
            ApprovalOutcome::Timeout,
            &mut engine,
            &registry,
            "ttyTEST",
            &[0x1B, 0x54],
            false,
        );
        assert_eq!(resp.reason.as_deref(), Some("timeout"));
        assert!(write_rx.try_recv().is_err());
    }

    #[test]
    fn double_take_allows_single_writer() {
        use crate::safemode::approval::ApprovalStore;
        use std::time::Duration as StdDuration;

        let mut store = ApprovalStore::default();
        let (event, rx) = store.register(
            "ttyTEST".into(),
            "1B 54".into(),
            "·T".into(),
            "r".into(),
            "tu1".into(),
            0,
        );
        let tx = store.take(&event.id).expect("first take");
        assert!(store.take(&event.id).is_none());
        tx.send(true).unwrap();
        assert_eq!(rx.recv_timeout(StdDuration::from_millis(50)), Ok(true));

        let (registry, write_rx) = registry_with_write_channel();
        let mut engine = engine_send_bytes_needs_approval();
        let resp = finish_after_approval(
            ApprovalOutcome::Approved,
            &mut engine,
            &registry,
            "ttyTEST",
            &[0x1B, 0x54],
            false,
        );
        assert!(resp.ok);
        assert_eq!(write_rx.recv().unwrap(), vec![0x1B, 0x54]);
        assert!(write_rx.try_recv().is_err());
    }
}
