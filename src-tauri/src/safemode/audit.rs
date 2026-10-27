use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

pub const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuditEvent {
    pub seq: u64,
    pub ts_ms: u64,
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub prev_hash: String,
    pub hash: String,
}

#[derive(Debug, Clone, Default)]
pub struct AuditFields {
    pub tool: Option<String>,
    pub port: Option<String>,
    pub hex: Option<String>,
    pub reason: Option<String>,
    pub decision: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug)]
pub struct AuditLog {
    path: PathBuf,
    seq: u64,
    last_hash: String,
}

impl AuditLog {
    pub fn bootstrap(path: PathBuf) -> Result<Self, String> {
        if !path.exists() {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            return Ok(Self {
                path,
                seq: 0,
                last_hash: GENESIS_HASH.to_string(),
            });
        }
        let (seq, last_hash) = tail_state_from_file(&path)?;
        Ok(Self {
            path,
            seq,
            last_hash,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn append(
        &mut self,
        ts_ms: u64,
        event: &str,
        fields: AuditFields,
    ) -> Result<AuditEvent, String> {
        let seq = self.seq + 1;
        let prev_hash = self.last_hash.clone();
        let hash = hash_event(seq, ts_ms, event, &fields, &prev_hash);
        let record = AuditEvent {
            seq,
            ts_ms,
            event: event.to_string(),
            tool: fields.tool,
            port: fields.port,
            hex: fields.hex,
            reason: fields.reason,
            decision: fields.decision,
            detail: fields.detail,
            prev_hash,
            hash,
        };
        let line = serde_json::to_string(&record).map_err(|e| e.to_string())?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|e| e.to_string())?;
        file.write_all(line.as_bytes())
            .and_then(|_| file.write_all(b"\n"))
            .map_err(|e| e.to_string())?;
        self.seq = seq;
        self.last_hash = record.hash.clone();
        Ok(record)
    }
}

fn hash_event(seq: u64, ts_ms: u64, event: &str, fields: &AuditFields, prev_hash: &str) -> String {
    let payload = serde_json::json!({
        "seq": seq,
        "ts_ms": ts_ms,
        "event": event,
        "tool": fields.tool,
        "port": fields.port,
        "hex": fields.hex,
        "reason": fields.reason,
        "decision": fields.decision,
        "detail": fields.detail,
        "prev_hash": prev_hash,
    });
    let bytes = serde_json::to_vec(&payload).expect("audit hash payload serializes");
    let digest = Sha256::digest(bytes);
    hex_encode(&digest)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn tail_state_from_file(path: &Path) -> Result<(u64, String), String> {
    verify_file(path)?;
    let file = File::open(path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut last: Option<AuditEvent> = None;
    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let ev: AuditEvent = serde_json::from_str(trimmed).map_err(|e| e.to_string())?;
        last = Some(ev);
    }
    match last {
        None => Ok((0, GENESIS_HASH.to_string())),
        Some(ev) => Ok((ev.seq, ev.hash)),
    }
}

pub fn verify_file(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let file = File::open(path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut expected_prev = GENESIS_HASH.to_string();
    let mut saw_line = false;
    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        saw_line = true;
        let ev: AuditEvent = serde_json::from_str(trimmed).map_err(|e| e.to_string())?;
        if ev.prev_hash != expected_prev {
            return Err(format!(
                "audit chain break at seq {}: prev_hash mismatch",
                ev.seq
            ));
        }
        let recomputed = hash_event(
            ev.seq,
            ev.ts_ms,
            &ev.event,
            &AuditFields {
                tool: ev.tool.clone(),
                port: ev.port.clone(),
                hex: ev.hex.clone(),
                reason: ev.reason.clone(),
                decision: ev.decision.clone(),
                detail: ev.detail.clone(),
            },
            &ev.prev_hash,
        );
        if recomputed != ev.hash {
            return Err(format!("audit hash mismatch at seq {}", ev.seq));
        }
        expected_prev = ev.hash.clone();
    }
    if !saw_line {
        return Ok(());
    }
    Ok(())
}

pub fn read_events(path: &Path, limit: usize, offset: usize) -> Result<Vec<AuditEvent>, String> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let file = File::open(path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut all = Vec::new();
    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let ev: AuditEvent = serde_json::from_str(trimmed).map_err(|e| e.to_string())?;
        all.push(ev);
    }
    let start = offset.min(all.len());
    let end = (start + limit).min(all.len());
    Ok(all[start..end].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_audit_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("omnibridge-audit-{}-{}", name, std::process::id()))
    }

    #[test]
    fn each_append_writes_one_line() {
        let path = temp_audit_path("one-line");
        let _ = fs::remove_file(&path);
        let mut log = AuditLog::bootstrap(path.clone()).unwrap();
        log.append(1, "policy_loaded", AuditFields::default())
            .unwrap();
        log.append(2, "tool_authorized", AuditFields::default())
            .unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let lines: Vec<_> = text.lines().filter(|l| !l.is_empty()).collect();
        assert_eq!(lines.len(), 2);
        verify_file(&path).unwrap();
    }

    #[test]
    fn tampered_line_breaks_verify() {
        let path = temp_audit_path("tamper");
        let _ = fs::remove_file(&path);
        let mut log = AuditLog::bootstrap(path.clone()).unwrap();
        log.append(100, "write_ok", AuditFields::default()).unwrap();
        let mut lines: Vec<String> = fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|s| s.to_string())
            .collect();
        lines[0] = lines[0].replace("\"write_ok\"", "\"write_ok_tampered\"");
        fs::write(&path, lines.join("\n") + "\n").unwrap();
        assert!(verify_file(&path).is_err());
    }

    #[test]
    fn reopen_continues_chain_without_truncate() {
        let path = temp_audit_path("append-only");
        let _ = fs::remove_file(&path);
        let mut log = AuditLog::bootstrap(path.clone()).unwrap();
        log.append(1, "a", AuditFields::default()).unwrap();
        let len1 = fs::metadata(&path).unwrap().len();
        let mut log2 = AuditLog::bootstrap(path.clone()).unwrap();
        log2.append(2, "b", AuditFields::default()).unwrap();
        let len2 = fs::metadata(&path).unwrap().len();
        assert!(len2 > len1);
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().filter(|l| !l.is_empty()).count(), 2);
        verify_file(&path).unwrap();
    }

    #[test]
    fn read_events_respects_limit_offset() {
        let path = temp_audit_path("read");
        let _ = fs::remove_file(&path);
        let mut log = AuditLog::bootstrap(path.clone()).unwrap();
        for i in 0..5 {
            log.append(i as u64, "e", AuditFields::default()).unwrap();
        }
        let slice = read_events(&path, 2, 1).unwrap();
        assert_eq!(slice.len(), 2);
        assert_eq!(slice[0].seq, 2);
    }
}
