// TEMP (see tmp/next.md): write an utterance WAV to ~/.cache/transcriber/dumps/
// for manual audio-quality inspection. Throwaway — fold into proper logging.
#[tauri::command]
fn dump_wav(filename: String, b64: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let bytes = STANDARD.decode(b64.as_bytes()).map_err(|e| e.to_string())?;
    let mut dir = dirs::cache_dir().ok_or("no cache dir")?;
    dir.push("transcriber");
    dir.push("dumps");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // strip any path separators from the caller-supplied name
    let safe = filename.replace(['/', '\\'], "_");
    dir.push(safe);
    std::fs::write(&dir, &bytes).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

// ── persistent session log at ~/.cache/transcriber/transcriber.log ───────────
fn log_file_path() -> Option<std::path::PathBuf> {
    let mut dir = dirs::cache_dir()?;
    dir.push("transcriber");
    std::fs::create_dir_all(&dir).ok()?;
    dir.push("transcriber.log");
    Some(dir)
}

// truncate the log at the start of each session (start fresh, never append)
#[tauri::command]
fn log_init() -> Result<String, String> {
    let path = log_file_path().ok_or("no cache dir")?;
    std::fs::write(&path, b"").map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn log_append(line: String) -> Result<(), String> {
    use std::io::Write;
    let path = log_file_path().ok_or("no cache dir")?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{}", line).map_err(|e| e.to_string())?;
    Ok(())
}

// ── user config at ~/.config/transcriber/config.yaml ─────────────────────────
fn config_file_path() -> Option<std::path::PathBuf> {
    let mut dir = dirs::config_dir()?;
    dir.push("transcriber");
    dir.push("config.yaml");
    Some(dir)
}

// Read and parse the YAML config into a JSON value for the frontend. A missing
// file is not an error — the frontend falls back to its built-in defaults.
#[tauri::command]
fn load_config() -> Result<serde_json::Value, String> {
    let path = match config_file_path() {
        Some(p) => p,
        None => return Ok(serde_json::Value::Null),
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Ok(serde_json::Value::Null),
    };
    serde_yaml::from_str(&text).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            dump_wav,
            log_init,
            log_append,
            load_config
        ])
        .setup(|app| {
            // On Linux, WebKitGTK denies getUserMedia (microphone) by default.
            // The transcriber is useless without the mic, so auto-grant the
            // webview's permission requests.
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.with_webview(|webview| {
                        use webkit2gtk::{PermissionRequestExt, WebViewExt};
                        webview.inner().connect_permission_request(|_wv, req| {
                            req.allow();
                            true
                        });
                    });
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
