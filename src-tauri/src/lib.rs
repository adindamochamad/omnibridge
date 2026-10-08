mod discovery;
pub mod safemode;

use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};
use std::collections::HashMap;
use std::io::Write;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PortDataEvent {
    port: String,
    data: Vec<u8>,
    timestamp: u64,
    text: String,
    direction: String, // "rx" (from device) or "tx" (to device)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BaudProbeResult {
    baud: u32,
    score: f32,
    bytes_read: usize,
    printable_count: usize,
    sample_ascii: String,
    error: Option<String>,
}

pub(crate) struct PortRegistration {
    active: bool,
    write_tx: Sender<Vec<u8>>,
}

pub(crate) type MonitorRegistry = Arc<Mutex<HashMap<String, PortRegistration>>>;

pub(crate) fn write_to_port(
    registry: &MonitorRegistry,
    port: &str,
    data: Vec<u8>,
) -> Result<(), String> {
    if data.is_empty() {
        return Err("Cannot send empty payload".into());
    }
    let map = registry.lock().map_err(|e| e.to_string())?;
    let state = map
        .get(port)
        .ok_or_else(|| format!("{} is not being monitored", port))?;
    if !state.active {
        return Err(format!("{} monitor is not active", port));
    }
    state
        .write_tx
        .send(data)
        .map_err(|e| format!("Write channel closed: {}", e))?;
    Ok(())
}

fn is_active(registry: &MonitorRegistry, port: &str) -> bool {
    registry
        .lock()
        .unwrap()
        .get(port)
        .map(|r| r.active)
        .unwrap_or(false)
}

fn kandidat_port_macos(nama_port: &str) -> Vec<String> {
    let mut daftar_port = vec![nama_port.to_string()];
    #[cfg(target_os = "macos")]
    {
        if let Some(akhiran_port) = nama_port.strip_prefix("/dev/cu.") {
            daftar_port.push(format!("/dev/tty.{}", akhiran_port));
        } else if let Some(akhiran_port) = nama_port.strip_prefix("/dev/tty.") {
            daftar_port.push(format!("/dev/cu.{}", akhiran_port));
        }
    }
    daftar_port
}

fn buka_port_dengan_konfigurasi(
    nama_port: &str,
    baud_rate: u32,
) -> Result<Box<dyn SerialPort>, String> {
    let mut daftar_error: Vec<String> = Vec::new();
    for kandidat_port in kandidat_port_macos(nama_port) {
        let hasil_buka = serialport::new(&kandidat_port, baud_rate)
            .data_bits(DataBits::Eight)
            .parity(Parity::None)
            .stop_bits(StopBits::One)
            .flow_control(FlowControl::None)
            .timeout(std::time::Duration::from_millis(100))
            .open();
        match hasil_buka {
            Ok(port_serial) => return Ok(port_serial),
            Err(error_buka) => {
                daftar_error.push(format!("{} => {}", kandidat_port, error_buka));
            }
        }
    }
    Err(daftar_error.join(" | "))
}

#[tauri::command]
fn discover_devices() -> Vec<discovery::DiscoveredDevice> {
    discovery::list_devices()
}

#[tauri::command]
async fn start_port_monitor(
    app: AppHandle,
    registry: tauri::State<'_, MonitorRegistry>,
    port: String,
    baud_rate: u32,
) -> Result<(), String> {
    let registry = registry.inner().clone();

    // Create write channel synchronously so send_bytes_to_port calls race-free
    let (write_tx, write_rx) = channel::<Vec<u8>>();

    {
        let mut map = registry.lock().map_err(|e| e.to_string())?;
        if map.get(&port).map(|r| r.active).unwrap_or(false) {
            return Err(format!("{} is already being monitored", port));
        }
        map.insert(
            port.clone(),
            PortRegistration {
                active: true,
                write_tx,
            },
        );
    }

    let port_name = port.clone();
    let reg = registry.clone();

    std::thread::spawn(move || {
        let mut serial = match buka_port_dengan_konfigurasi(&port_name, baud_rate) {
            Ok(p) => p,
            Err(e) => {
                let _ = app.emit(
                    "port:error",
                    serde_json::json!({ "port": &port_name, "error": e.to_string() }),
                );
                reg.lock().unwrap().remove(&port_name);
                return;
            }
        };

        let mut buf = vec![0u8; 512];

        loop {
            if !is_active(&reg, &port_name) {
                break;
            }

            // Drain any pending writes first (non-blocking)
            while let Ok(data) = write_rx.try_recv() {
                match serial.write_all(&data) {
                    Ok(_) => {
                        let _ = serial.flush();
                        let timestamp = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        let text = String::from_utf8_lossy(&data).into_owned();
                        let _ = app.emit(
                            "port:data",
                            PortDataEvent {
                                port: port_name.clone(),
                                data: data.clone(),
                                timestamp,
                                text,
                                direction: "tx".into(),
                            },
                        );
                    }
                    Err(e) => {
                        let _ = app.emit(
                            "port:error",
                            serde_json::json!({
                                "port": &port_name,
                                "error": format!("Write failed: {}", e),
                            }),
                        );
                    }
                }
            }

            // Read incoming data
            match serial.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    let data = buf[..n].to_vec();
                    let text = String::from_utf8_lossy(&data).into_owned();
                    let timestamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    let _ = app.emit(
                        "port:data",
                        PortDataEvent {
                            port: port_name.clone(),
                            data,
                            timestamp,
                            text,
                            direction: "rx".into(),
                        },
                    );
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => break,
            }
        }

        reg.lock().unwrap().remove(&port_name);
        let _ = app.emit("port:closed", &port_name);
    });

    Ok(())
}

#[tauri::command]
fn send_bytes_to_port(
    registry: tauri::State<'_, MonitorRegistry>,
    port: String,
    data: Vec<u8>,
) -> Result<(), String> {
    write_to_port(registry.inner(), &port, data)
}

fn is_printable_byte(b: u8) -> bool {
    (0x20..=0x7E).contains(&b) || b == b'\n' || b == b'\r' || b == b'\t'
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::mpsc::channel;

    #[test]
    fn is_printable_byte_treats_ascii_space_as_printable() {
        assert!(is_printable_byte(b' '));
        assert!(!is_printable_byte(0x1F));
    }

    #[test]
    fn write_to_port_delivers_bytes_to_channel() {
        let registry: MonitorRegistry = Arc::new(Mutex::new(HashMap::new()));
        let (write_tx, write_rx) = channel::<Vec<u8>>();
        registry.lock().unwrap().insert(
            "ttyTEST".into(),
            PortRegistration {
                active: true,
                write_tx,
            },
        );
        write_to_port(&registry, "ttyTEST", vec![1, 2, 3]).unwrap();
        assert_eq!(write_rx.recv().unwrap(), vec![1, 2, 3]);
    }

    #[test]
    fn write_to_port_errors_unchanged() {
        let registry: MonitorRegistry = Arc::new(Mutex::new(HashMap::new()));
        assert_eq!(
            write_to_port(&registry, "ttyX", vec![]).unwrap_err(),
            "Cannot send empty payload"
        );
        assert_eq!(
            write_to_port(&registry, "ttyX", vec![1]).unwrap_err(),
            "ttyX is not being monitored"
        );
        let (write_tx, _) = channel::<Vec<u8>>();
        registry.lock().unwrap().insert(
            "ttyY".into(),
            PortRegistration {
                active: false,
                write_tx,
            },
        );
        assert_eq!(
            write_to_port(&registry, "ttyY", vec![1]).unwrap_err(),
            "ttyY monitor is not active"
        );
    }
}

fn probe_single_sync(port: &str, baud: u32) -> BaudProbeResult {
    let mut serial = match buka_port_dengan_konfigurasi(port, baud) {
        Ok(p) => p,
        Err(e) => {
            return BaudProbeResult {
                baud,
                score: 0.0,
                bytes_read: 0,
                printable_count: 0,
                sample_ascii: String::new(),
                error: Some(e.to_string()),
            };
        }
    };

    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1000);
    let mut buf = vec![0u8; 1024];
    let mut bytes_read = 0usize;
    let mut printable_count = 0usize;
    let mut sample: Vec<u8> = Vec::with_capacity(80);

    while std::time::Instant::now() < deadline {
        match serial.read(&mut buf) {
            Ok(0) => {}
            Ok(n) => {
                bytes_read += n;
                for &b in &buf[..n] {
                    if is_printable_byte(b) {
                        printable_count += 1;
                    }
                }
                if sample.len() < 80 {
                    let take = std::cmp::min(80 - sample.len(), n);
                    sample.extend_from_slice(&buf[..take]);
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }
    }

    let score = if bytes_read > 0 {
        printable_count as f32 / bytes_read as f32
    } else {
        0.0
    };

    BaudProbeResult {
        baud,
        score,
        bytes_read,
        printable_count,
        sample_ascii: String::from_utf8_lossy(&sample)
            .chars()
            .map(|c| {
                if c.is_control() && c != '\n' && c != '\r' && c != '\t' {
                    '·'
                } else {
                    c
                }
            })
            .collect(),
        error: None,
    }
}

#[tauri::command]
async fn probe_single_baud(
    registry: tauri::State<'_, MonitorRegistry>,
    port: String,
    baud: u32,
) -> Result<BaudProbeResult, String> {
    {
        let map = registry.lock().map_err(|e| e.to_string())?;
        if map.get(&port).map(|r| r.active).unwrap_or(false) {
            return Err(format!(
                "{} is currently being monitored — stop it first",
                port
            ));
        }
    }

    tauri::async_runtime::spawn_blocking(move || probe_single_sync(&port, baud))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn stop_port_monitor(
    registry: tauri::State<'_, MonitorRegistry>,
    port: String,
) -> Result<(), String> {
    let mut map = registry.lock().map_err(|e| e.to_string())?;
    if let Some(reg) = map.get_mut(&port) {
        reg.active = false;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
struct WebhookResponse {
    ok: bool,
    status: u16,
    body_preview: String,
}

/// Forward a webhook from the Rust side so the request is NOT subject to the
/// WebView's CORS policy. Legacy/self-hosted endpoints (e.g. CodeIgniter REST
/// APIs) rarely send Access-Control-* headers, so a browser `fetch()` fails the
/// preflight with "TypeError: Failed to fetch" before the request leaves the
/// app. A native client has no such restriction.
#[tauri::command]
async fn send_webhook_request(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: String,
) -> Result<WebhookResponse, String> {
    let http_method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| format!("Invalid method '{}': {}", method, e))?;

    let client = reqwest::Client::new();
    let mut request = client.request(http_method, &url);
    for (key, value) in headers {
        request = request.header(key, value);
    }
    request = request.body(body);

    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let ok = response.status().is_success();
    let text = response.text().await.unwrap_or_default();
    let body_preview: String = text.chars().take(120).collect();

    Ok(WebhookResponse {
        ok,
        status,
        body_preview,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let registry: MonitorRegistry = Arc::new(Mutex::new(HashMap::new()));

    tauri::Builder::default()
        .manage(registry)
        .setup(|app| {
            let policy_path = app
                .path()
                .app_config_dir()
                .map_err(|e| e.to_string())?
                .join("safemode-policy.json");
            app.manage(safemode::gate::init_state(&policy_path));
            Ok(())
        })
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_serialplugin::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            discover_devices,
            start_port_monitor,
            stop_port_monitor,
            probe_single_baud,
            send_bytes_to_port,
            send_webhook_request,
            safemode::gate::safemode_begin_session,
            safemode::gate::safemode_authorize_tool,
            safemode::gate::safemode_resolve_approval,
            safemode::gate::safemode_agent_send_bytes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
