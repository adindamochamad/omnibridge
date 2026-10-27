use crate::safemode::approval::{
    wait_for_approval, ApprovalOutcome, ApprovalRequestedEvent, ApprovalStore,
};
use crate::safemode::audit::{AuditEvent, AuditFields, AuditLog};
use crate::safemode::policy::{payload_to_spaced_hex, Decision};
use crate::safemode::PolicyEngine;
use crate::write_to_port;
use crate::MonitorRegistry;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const DISABLE_CONFIRM_TEXT: &str = "MATIKAN";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SafeModeEnabledFile {
    enabled: bool,
}

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
    enabled: bool,
    enabled_path: PathBuf,
    audit: AuditLog,
}

impl SafeModeState {
    pub fn new(
        policy_path: PathBuf,
        audit_path: PathBuf,
        enabled_path: PathBuf,
    ) -> Result<Self, String> {
        let engine = PolicyEngine::load_from_path(&policy_path);
        let audit = AuditLog::bootstrap(audit_path)?;
        let enabled = load_enabled_flag(&enabled_path)?;
        let mut inner = SafeModeInner {
            engine,
            approvals: ApprovalStore::default(),
            enabled,
            enabled_path,
            audit,
        };
        let ts = now_ms();
        if inner.engine.is_policy_invalid() {
            inner.audit_append(
                ts,
                "policy_invalid",
                AuditFields {
                    detail: Some("policy file missing or invalid".into()),
                    ..Default::default()
                },
            )?;
        } else {
            inner.audit_append(
                ts,
                "policy_loaded",
                AuditFields {
                    detail: Some("ok".into()),
                    ..Default::default()
                },
            )?;
        }
        Ok(Self {
            inner: Mutex::new(inner),
        })
    }

    pub fn record_human_write(&self, port: &str, data: &[u8]) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let hex = payload_to_spaced_hex(data);
        inner.audit_append(
            now_ms(),
            "human_write",
            AuditFields {
                port: Some(port.to_string()),
                hex: Some(hex),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn with_engine_and_audit(
        engine: PolicyEngine,
        audit_path: PathBuf,
        enabled_path: PathBuf,
    ) -> Result<Self, String> {
        let audit = AuditLog::bootstrap(audit_path)?;
        Ok(Self {
            inner: Mutex::new(SafeModeInner {
                engine,
                approvals: ApprovalStore::default(),
                enabled: true,
                enabled_path,
                audit,
            }),
        })
    }
}

impl SafeModeInner {
    fn audit_append(&mut self, ts_ms: u64, event: &str, fields: AuditFields) -> Result<(), String> {
        self.audit
            .append(ts_ms, event, fields)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn set_enabled(&mut self, enabled: bool, confirm_text: Option<&str>) -> Result<(), String> {
        if !enabled && confirm_text != Some(DISABLE_CONFIRM_TEXT) {
            return Err(format!(
                "Confirmation text must be {} to disable Safe Mode",
                DISABLE_CONFIRM_TEXT
            ));
        }
        self.enabled = enabled;
        save_enabled_flag(&self.enabled_path, enabled)?;
        self.audit_append(
            now_ms(),
            "safemode_toggled",
            AuditFields {
                detail: Some(if enabled { "enabled" } else { "disabled" }.into()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    fn plan_logged_send(
        &mut self,
        port: &str,
        data: &[u8],
        reason: &str,
        tool_use_id: &str,
        ts: u64,
        hex: &str,
    ) -> Result<AgentSendPlan, String> {
        self.audit_append(
            ts,
            "write_requested",
            AuditFields {
                tool: Some("send_bytes".into()),
                port: Some(port.to_string()),
                hex: Some(hex.to_string()),
                reason: Some(reason.to_string()),
                detail: Some(tool_use_id.to_string()),
                ..Default::default()
            },
        )?;
        let raw_plan = plan_agent_send_bytes(&mut self.engine, port, data, ts);
        let decision = policy_decision_label(&raw_plan);
        self.audit_append(
            ts,
            "policy_decision",
            AuditFields {
                tool: Some("send_bytes".into()),
                port: Some(port.to_string()),
                decision: Some(decision),
                ..Default::default()
            },
        )?;
        let needs_approval = matches!(raw_plan, AgentSendPlan::NeedsApproval { .. });
        let plan = apply_enabled_to_plan(raw_plan, self.enabled);
        if !self.enabled && needs_approval {
            self.audit_append(
                ts,
                "policy_decision",
                AuditFields {
                    tool: Some("send_bytes".into()),
                    port: Some(port.to_string()),
                    decision: Some("needs_approval_skipped".into()),
                    detail: Some("safemode_disabled".into()),
                    ..Default::default()
                },
            )?;
        }
        Ok(plan)
    }

    fn log_approval_shown(
        &mut self,
        ts: u64,
        port: &str,
        hex: &str,
        reason: &str,
        approval_id: &str,
    ) -> Result<(), String> {
        self.audit_append(
            ts,
            "approval_shown",
            AuditFields {
                port: Some(port.to_string()),
                hex: Some(hex.to_string()),
                reason: Some(reason.to_string()),
                detail: Some(approval_id.to_string()),
                ..Default::default()
            },
        )
    }
}

fn load_enabled_flag(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(true);
    }
    let json = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let file: SafeModeEnabledFile = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    Ok(file.enabled)
}

fn save_enabled_flag(path: &Path, enabled: bool) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&SafeModeEnabledFile { enabled })
        .map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(())
}

fn apply_enabled_to_plan(plan: AgentSendPlan, enabled: bool) -> AgentSendPlan {
    if enabled {
        return plan;
    }
    match plan {
        AgentSendPlan::NeedsApproval { is_demo } => {
            if is_demo {
                AgentSendPlan::SimulatedDemo
            } else {
                AgentSendPlan::WriteRealPort
            }
        }
        other => other,
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

fn agent_facing_deny_reason(rule: &str) -> String {
    match rule {
        "rate_limited" => "rate_limited".into(),
        "session_blocked" => "session_blocked".into(),
        "policy_invalid" => "safe_mode_policy_invalid".into(),
        other => format!("policy_denied:{other}"),
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
        Decision::Deny { rule } => blocked_tool_response(&agent_facing_deny_reason(&rule)),
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
            AgentSendPlan::Blocked(blocked_send_response(&agent_facing_deny_reason(&rule)))
        }
        Decision::NeedsApproval => AgentSendPlan::NeedsApproval { is_demo: false },
        Decision::Allow => AgentSendPlan::WriteRealPort,
    }
}

fn plan_agent_send_demo(engine: &mut PolicyEngine, data: &[u8], now_ms: u64) -> AgentSendPlan {
    match engine.evaluate("send_bytes", data, now_ms) {
        Decision::Deny { rule } => {
            engine.record_denied();
            AgentSendPlan::Blocked(blocked_send_response(&agent_facing_deny_reason(&rule)))
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

fn response_after_approval(
    outcome: ApprovalOutcome,
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
        ApprovalOutcome::Denied => denied_by_user_response(),
        ApprovalOutcome::Timeout => timeout_response(),
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
    if matches!(outcome, ApprovalOutcome::Denied | ApprovalOutcome::Timeout) {
        engine.record_denied();
    }
    response_after_approval(outcome, registry, port, data, is_demo)
}

struct ApprovalSettleRequest<'a> {
    port: &'a str,
    data: &'a [u8],
    reason: &'a str,
    tool_use_id: &'a str,
    hex: &'a str,
    is_demo: bool,
}

/// Register the pending approval, emit, wait, then write. The state mutex is not
/// held across `emit` or `wait_for_approval`, and the serial write runs outside it.
async fn settle_needs_approval<E>(
    state: &SafeModeState,
    registry: &MonitorRegistry,
    request: ApprovalSettleRequest<'_>,
    emit: E,
) -> Result<AgentSendBytesResponse, String>
where
    E: FnOnce(&ApprovalRequestedEvent) -> Result<(), String>,
{
    let ApprovalSettleRequest {
        port,
        data,
        reason,
        tool_use_id,
        hex,
        is_demo,
    } = request;
    let (event, rx, timeout_ms, approval_id) = {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        let timeout_ms = inner.engine.approval_timeout_secs().saturating_mul(1000);
        let expires_at = now_ms().saturating_add(timeout_ms);
        let ascii = bytes_to_ascii_display(data);
        let (event, rx) = inner.approvals.register(
            port.to_string(),
            hex.to_string(),
            ascii,
            reason.to_string(),
            tool_use_id.to_string(),
            expires_at,
        );
        let approval_id = event.id.clone();
        inner.log_approval_shown(now_ms(), port, hex, reason, &approval_id)?;
        (event, rx, timeout_ms, approval_id)
    };

    if let Err(e) = emit(&event) {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.approvals.cancel(&approval_id);
        return Err(e);
    }

    let outcome = wait_for_approval(rx, timeout_ms).await?;

    if matches!(outcome, ApprovalOutcome::Denied | ApprovalOutcome::Timeout) {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        if outcome == ApprovalOutcome::Timeout {
            inner.approvals.cancel(&approval_id);
        }
        inner.engine.record_denied();
    }

    let response = response_after_approval(outcome, registry, port, data, is_demo);

    {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        audit_approval_outcome(&mut inner, outcome, port, hex, &response, is_demo)?;
    }

    Ok(response)
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
    let ts = now_ms();
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    let response = authorize_tool_inner(&mut inner.engine, &tool_name, ts);
    let decision = if response.allowed {
        "allow".to_string()
    } else {
        response
            .reason
            .clone()
            .unwrap_or_else(|| "deny".to_string())
    };
    inner.audit_append(
        ts,
        "tool_authorized",
        AuditFields {
            tool: Some(tool_name),
            decision: Some(decision),
            ..Default::default()
        },
    )?;
    Ok(response)
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

fn policy_decision_label(plan: &AgentSendPlan) -> String {
    match plan {
        AgentSendPlan::Blocked(resp) => resp.reason.clone().unwrap_or_else(|| "deny".to_string()),
        AgentSendPlan::NeedsApproval { .. } => "needs_approval".into(),
        AgentSendPlan::WriteRealPort => "allow".into(),
        AgentSendPlan::SimulatedDemo => "allow_simulated".into(),
    }
}

fn log_agent_write_outcome(
    inner: &mut SafeModeInner,
    ts: u64,
    port: &str,
    hex: &str,
    response: &AgentSendBytesResponse,
    is_demo: bool,
) -> Result<(), String> {
    if response.ok || response.simulated == Some(true) || is_demo {
        inner.audit_append(
            ts,
            "write_ok",
            AuditFields {
                port: Some(port.to_string()),
                hex: Some(hex.to_string()),
                detail: if is_demo || response.simulated == Some(true) {
                    Some("simulated".into())
                } else {
                    None
                },
                ..Default::default()
            },
        )?;
    } else if response.reason.as_deref() == Some("write_error") {
        inner.audit_append(
            ts,
            "write_error",
            AuditFields {
                port: Some(port.to_string()),
                hex: Some(hex.to_string()),
                detail: response.message.clone(),
                ..Default::default()
            },
        )?;
    }
    Ok(())
}

fn audit_approval_outcome(
    inner: &mut SafeModeInner,
    outcome: ApprovalOutcome,
    port: &str,
    hex: &str,
    response: &AgentSendBytesResponse,
    is_demo: bool,
) -> Result<(), String> {
    match outcome {
        ApprovalOutcome::Approved => {
            inner.audit_append(
                now_ms(),
                "approved",
                AuditFields {
                    port: Some(port.to_string()),
                    hex: Some(hex.to_string()),
                    ..Default::default()
                },
            )?;
            log_agent_write_outcome(inner, now_ms(), port, hex, response, is_demo)?;
        }
        ApprovalOutcome::Denied => {
            inner.audit_append(
                now_ms(),
                "denied",
                AuditFields {
                    port: Some(port.to_string()),
                    hex: Some(hex.to_string()),
                    ..Default::default()
                },
            )?;
        }
        ApprovalOutcome::Timeout => {
            inner.audit_append(
                now_ms(),
                "timeout",
                AuditFields {
                    port: Some(port.to_string()),
                    hex: Some(hex.to_string()),
                    ..Default::default()
                },
            )?;
        }
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
    let ts = now_ms();
    let hex = payload_to_spaced_hex(&data);

    let plan = {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.plan_logged_send(&port, &data, &reason, &tool_use_id, ts, &hex)?
    };

    match plan {
        AgentSendPlan::Blocked(resp) => Ok(resp),
        AgentSendPlan::WriteRealPort => {
            let response =
                execute_agent_send_plan(AgentSendPlan::WriteRealPort, &reg, &port, &data);
            let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
            log_agent_write_outcome(&mut inner, now_ms(), &port, &hex, &response, false)?;
            Ok(response)
        }
        AgentSendPlan::SimulatedDemo => {
            let response = simulated_send_response(data.len());
            let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
            log_agent_write_outcome(&mut inner, now_ms(), &port, &hex, &response, true)?;
            Ok(response)
        }
        AgentSendPlan::NeedsApproval { is_demo } => {
            settle_needs_approval(
                &state,
                &reg,
                ApprovalSettleRequest {
                    port: &port,
                    data: &data,
                    reason: &reason,
                    tool_use_id: &tool_use_id,
                    hex: &hex,
                    is_demo,
                },
                |event| {
                    app.emit("safemode:approval_requested", event)
                        .map_err(|e| e.to_string())
                },
            )
            .await
        }
    }
}

#[tauri::command]
pub fn safemode_get_enabled(state: tauri::State<'_, SafeModeState>) -> Result<bool, String> {
    let inner = state.inner.lock().map_err(|e| e.to_string())?;
    Ok(inner.enabled)
}

#[tauri::command]
pub fn safemode_set_enabled(
    state: tauri::State<'_, SafeModeState>,
    enabled: bool,
    confirm_text: Option<String>,
) -> Result<bool, String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.set_enabled(enabled, confirm_text.as_deref())?;
    Ok(inner.enabled)
}

#[derive(Debug, Clone, Serialize)]
pub struct ReadAuditResponse {
    pub events: Vec<AuditEvent>,
    pub total: usize,
}

#[tauri::command]
pub fn safemode_read_audit(
    state: tauri::State<'_, SafeModeState>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<ReadAuditResponse, String> {
    let inner = state.inner.lock().map_err(|e| e.to_string())?;
    let path = inner.audit.path().to_path_buf();
    let limit = limit.unwrap_or(200).min(500) as usize;
    let offset = offset.unwrap_or(0) as usize;
    let all = crate::safemode::audit::read_events(&path, usize::MAX, 0)?;
    let total = all.len();
    let events = crate::safemode::audit::read_events(path.as_path(), limit, offset)?;
    Ok(ReadAuditResponse { events, total })
}

pub fn init_state(
    policy_path: &Path,
    audit_path: PathBuf,
    enabled_path: PathBuf,
) -> Result<SafeModeState, String> {
    SafeModeState::new(policy_path.to_path_buf(), audit_path, enabled_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::safemode::policy::parse_policy_json;
    use std::collections::HashMap;
    use std::sync::mpsc::channel;
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

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

    #[test]
    fn disable_requires_matican_confirm() {
        let dir =
            std::env::temp_dir().join(format!("omnibridge-gate-enabled-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let audit_path = dir.join("audit.jsonl");
        let enabled_path = dir.join("enabled.json");
        let state = SafeModeState::with_engine_and_audit(
            engine_send_bytes_needs_approval(),
            audit_path.clone(),
            enabled_path.clone(),
        )
        .unwrap();
        {
            let mut inner = state.inner.lock().unwrap();
            assert!(inner.set_enabled(false, Some("wrong")).is_err());
            assert!(inner.enabled);
            inner
                .set_enabled(false, Some(DISABLE_CONFIRM_TEXT))
                .unwrap();
            assert!(!inner.enabled);
        }
        assert!(!load_enabled_flag(&enabled_path).unwrap());
        let events = crate::safemode::audit::read_events(&audit_path, 10, 0).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "safemode_toggled");
        assert_eq!(events[0].detail.as_deref(), Some("disabled"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_enabled_file_defaults_on() {
        let path =
            std::env::temp_dir().join(format!("omnibridge-enabled-missing-{}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        assert!(load_enabled_flag(&path).unwrap());
    }

    fn engine_short_approval() -> PolicyEngine {
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
  "approval_timeout_secs": 1,
  "block_session_after_deny": true
}"#,
            )
            .unwrap(),
        )
    }

    #[test]
    fn request_approve_write_audit_sequence() {
        use crate::safemode::audit::{read_events, verify_file};

        let dir =
            std::env::temp_dir().join(format!("omnibridge-gate-audit-seq-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let audit_path = dir.join("audit.jsonl");
        let enabled_path = dir.join("enabled.json");
        let state = Arc::new(
            SafeModeState::with_engine_and_audit(
                engine_short_approval(),
                audit_path.clone(),
                enabled_path,
            )
            .unwrap(),
        );
        let (registry, write_rx) = registry_with_write_channel();
        let data = [0x1B, 0x54];
        let hex = payload_to_spaced_hex(&data);
        let plan = {
            let mut inner = state.inner.lock().unwrap();
            inner
                .plan_logged_send("ttyTEST", &data, "test", "tu1", 1, &hex)
                .unwrap()
        };
        assert_eq!(plan, AgentSendPlan::NeedsApproval { is_demo: false });

        let (emit_tx, emit_rx) = channel::<ApprovalRequestedEvent>();
        let resolver_state = Arc::clone(&state);
        let resolver = thread::spawn(move || {
            let event = emit_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("approval event emitted");
            let started = Instant::now();
            let sender = loop {
                if let Ok(mut inner) = resolver_state.inner.try_lock() {
                    break inner.approvals.take(&event.id);
                }
                if started.elapsed() > Duration::from_millis(500) {
                    panic!("SafeModeState mutex held during approval wait");
                }
                thread::sleep(Duration::from_millis(5));
            };
            let sender = sender.expect("pending approval");
            sender.send(true).expect("approve send");
            event
        });

        let response = tauri::async_runtime::block_on(settle_needs_approval(
            &state,
            &registry,
            ApprovalSettleRequest {
                port: "ttyTEST",
                data: &data,
                reason: "test",
                tool_use_id: "tu1",
                hex: &hex,
                is_demo: false,
            },
            |event| {
                emit_tx.send(event.clone()).map_err(|e| e.to_string())?;
                Ok(())
            },
        ))
        .unwrap();

        let event = resolver.join().expect("resolver");
        assert_eq!(event.port, "ttyTEST");
        assert_eq!(event.hex, hex);
        assert_eq!(event.reason, "test");
        assert_eq!(event.tool_use_id, "tu1");
        assert!(response.ok);
        assert_eq!(response.bytes_sent, Some(2));
        assert_eq!(write_rx.recv().unwrap(), vec![0x1B, 0x54]);
        assert!(write_rx.try_recv().is_err());
        assert!(state
            .inner
            .lock()
            .unwrap()
            .approvals
            .take(&event.id)
            .is_none());
        verify_file(&audit_path).unwrap();
        let events = read_events(&audit_path, 10, 0).unwrap();
        let names: Vec<_> = events.iter().map(|e| e.event.as_str()).collect();
        assert_eq!(
            names,
            [
                "write_requested",
                "policy_decision",
                "approval_shown",
                "approved",
                "write_ok",
            ]
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn emit_failure_cancels_pending_without_write() {
        let dir =
            std::env::temp_dir().join(format!("omnibridge-gate-audit-emit-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let state = SafeModeState::with_engine_and_audit(
            engine_short_approval(),
            dir.join("audit.jsonl"),
            dir.join("enabled.json"),
        )
        .unwrap();
        let (registry, write_rx) = registry_with_write_channel();
        let data = [0x1B, 0x54];
        let hex = payload_to_spaced_hex(&data);
        {
            let mut inner = state.inner.lock().unwrap();
            inner
                .plan_logged_send("ttyTEST", &data, "test", "tu1", 1, &hex)
                .unwrap();
        }
        let err = tauri::async_runtime::block_on(settle_needs_approval(
            &state,
            &registry,
            ApprovalSettleRequest {
                port: "ttyTEST",
                data: &data,
                reason: "test",
                tool_use_id: "tu1",
                hex: &hex,
                is_demo: false,
            },
            |_| Err("emit failed".into()),
        ))
        .unwrap_err();
        assert_eq!(err, "emit failed");
        assert!(write_rx.try_recv().is_err());
        assert_eq!(state.inner.lock().unwrap().approvals.pending_count(), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn write_deny_reasons_match_fr9() {
        let mut limited = PolicyEngine::from_policy(
            parse_policy_json(
                r#"{
  "version": 1,
  "default": "deny",
  "tools": {
    "send_bytes": {
      "class": "write",
      "require_approval": true,
      "max_payload_bytes": 64,
      "rate_limit": { "max": 1, "per_secs": 60 },
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
        assert!(matches!(
            plan_agent_send_bytes(&mut limited, "p", &[0x01], 0),
            AgentSendPlan::NeedsApproval { .. }
        ));
        match plan_agent_send_bytes(&mut limited, "p", &[0x01], 1) {
            AgentSendPlan::Blocked(resp) => {
                assert_eq!(resp.reason.as_deref(), Some("rate_limited"));
            }
            other => panic!("expected blocked, got {other:?}"),
        }

        let mut blocked = engine_send_bytes_needs_approval();
        blocked.record_denied();
        match plan_agent_send_bytes(&mut blocked, "p", &[0x01], 0) {
            AgentSendPlan::Blocked(resp) => {
                assert_eq!(resp.reason.as_deref(), Some("session_blocked"));
            }
            other => panic!("expected blocked, got {other:?}"),
        }

        let mut invalid = PolicyEngine::fail_closed();
        match plan_agent_send_bytes(&mut invalid, "p", &[0x01], 0) {
            AgentSendPlan::Blocked(resp) => {
                assert_eq!(resp.reason.as_deref(), Some("safe_mode_policy_invalid"));
            }
            other => panic!("expected blocked, got {other:?}"),
        }
        let read = authorize_tool_inner(&mut invalid, "read_more_lines", 0);
        assert!(read.allowed);
    }
}
