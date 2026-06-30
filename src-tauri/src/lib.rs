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

// Best-effort append to the session log; usable from both the command and from
// Rust-internal callers (e.g. the paste flow) so backend events show up in the
// same ~/.cache/transcriber/transcriber.log the frontend writes to.
fn append_log(line: &str) {
    use std::io::Write;
    if let Some(path) = log_file_path() {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{}", line);
        }
    }
}

#[tauri::command]
fn log_append(line: String) -> Result<(), String> {
    append_log(&line);
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
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    // A missing file is not an error: start from an empty object so the
    // TRANSCRIBER_API_KEY env overlay below still applies.
    let mut value: serde_json::Value =
        serde_yaml::from_str(&text).unwrap_or(serde_json::Value::Null);

    // The deployed app (start_apps.sh → set_env.sh) supplies the key via the
    // TRANSCRIBER_API_KEY env var, kept separate from reshka's OPENROUTER_API_KEY
    // so the two apps use independent OpenRouter accounts. The env var takes
    // precedence over any api_key in config.yaml.
    if let Ok(key) = std::env::var("TRANSCRIBER_API_KEY") {
        if !key.trim().is_empty() {
            if !value.is_object() {
                value = serde_json::Value::Object(serde_json::Map::new());
            }
            if let Some(obj) = value.as_object_mut() {
                obj.insert("api_key".into(), serde_json::Value::String(key));
            }
        }
    }
    Ok(value)
}

// ── auto-paste ───────────────────────────────────────────────────────────────
// Load the transcript onto the clipboard and fire a paste keystroke into
// whatever window has focus. Mirrors reshka's proven Wayland flow: `wl-copy`
// holds the clipboard, then a detached `ydotool` presses the paste key after a
// short delay so focus can return to the previously-focused app first.
//
// Linux/Wayland only for now. Every failure returns a descriptive Err so the UI
// can show the user exactly which tool is missing / what to do.

#[cfg(target_os = "linux")]
fn which(bin: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(bin))
        .find(|p| p.is_file())
}

// Is a process with this exact comm name running? (comm is truncated to 15
// chars by the kernel, so only pass short names like "ydotoold".)
#[cfg(target_os = "linux")]
fn proc_running(name: &str) -> bool {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return false;
    };
    for entry in entries.flatten() {
        if let Ok(comm) = std::fs::read_to_string(entry.path().join("comm")) {
            if comm.trim() == name {
                return true;
            }
        }
    }
    false
}

// Locate the ydotoold control socket so we can pass it to ydotool explicitly
// (its default search path varies by version/distro; being explicit avoids a
// silent "couldn't connect" no-op).
#[cfg(target_os = "linux")]
fn ydotool_socket() -> Option<std::path::PathBuf> {
    if let Ok(s) = std::env::var("YDOTOOL_SOCKET") {
        if !s.is_empty() {
            return Some(s.into());
        }
    }
    if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
        let p = std::path::Path::new(&xdg).join(".ydotool_socket");
        if p.exists() {
            return Some(p);
        }
    }
    let tmp = std::path::PathBuf::from("/tmp/.ydotool_socket");
    if tmp.exists() {
        return Some(tmp);
    }
    None
}

// Whitelist the paste key: names joined by '+', alphanumerics only. The key is
// passed to ydotool as a separate argv (no shell), but we validate anyway so a
// malformed config value fails loudly instead of silently misfiring.
#[cfg(target_os = "linux")]
fn valid_paste_key(k: &str) -> bool {
    !k.is_empty()
        && k.len() <= 64
        && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '+')
}

// Returns Ok(()) when auto-paste can work right now, else a user-facing reason.
#[cfg(target_os = "linux")]
fn linux_paste_check() -> Result<(), String> {
    let wayland = std::env::var("WAYLAND_DISPLAY")
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    if !wayland {
        return Err(
            "Auto-paste currently requires a Wayland session (XDG_SESSION_TYPE=wayland)."
                .into(),
        );
    }
    let mut missing = Vec::new();
    if which("wl-copy").is_none() {
        missing.push("wl-copy (package: wl-clipboard)");
    }
    if which("ydotool").is_none() {
        missing.push("ydotool");
    }
    if !missing.is_empty() {
        return Err(format!(
            "Missing tool(s): {}. Install them (e.g. `sudo apt install wl-clipboard ydotool`), then try again.",
            missing.join(", ")
        ));
    }
    if !proc_running("ydotoold") {
        return Err(
            "ydotoold is not running. Start it (`systemctl --user start ydotool` or run `ydotoold &`), then try again."
                .into(),
        );
    }
    Ok(())
}

// Report whether auto-paste is usable, with a message describing why not. Called
// at startup so the UI can warn before the user relies on it.
#[tauri::command]
fn paste_diagnostics() -> serde_json::Value {
    #[cfg(target_os = "linux")]
    {
        match linux_paste_check() {
            Ok(()) => serde_json::json!({ "available": true, "message": "" }),
            Err(e) => serde_json::json!({ "available": false, "message": e }),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        serde_json::json!({
            "available": false,
            "message": "Auto-paste is only implemented on Linux for now."
        })
    }
}

#[tauri::command]
fn paste_transcript(
    text: String,
    paste_key: String,
    delay_ms: Option<u64>,
) -> Result<(), String> {
    // Defensive guard: never fire the paste shortcut for empty content. The
    // frontend already trims + skips empty, but enforce it here too so the
    // ydotool keystroke can never land on a stale clipboard. Use the trimmed
    // text for the clipboard so trailing whitespace is stripped at the source.
    let text = text.trim();
    if text.is_empty() {
        append_log("[paste] skipped: empty transcript (no shortcut fired)");
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::{Command, Stdio};

        linux_paste_check()?;
        if !valid_paste_key(&paste_key) {
            return Err(format!(
                "Invalid paste_key '{paste_key}'. Use names joined by '+', e.g. ctrl+v or ctrl+shift+v."
            ));
        }
        let delay = delay_ms.unwrap_or(800).min(10_000);
        let socket = ydotool_socket();
        append_log(&format!(
            "[paste] begin: {} chars, key={}, delay={}ms, socket={:?}",
            text.len(),
            paste_key,
            delay,
            socket
        ));

        // 1. Load the clipboard. wl-copy forks a daemon that keeps serving the
        //    data after we exit, so waiting here just confirms it's loaded.
        let status = Command::new("wl-copy")
            .arg("--")
            .arg(&text)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| {
                append_log(&format!("[paste] wl-copy spawn failed: {e}"));
                format!("failed to run wl-copy: {e}")
            })?;
        if !status.success() {
            append_log("[paste] wl-copy exited non-zero");
            return Err("wl-copy failed to set the clipboard.".into());
        }
        append_log("[paste] clipboard loaded");

        // 2. Fire the paste keystroke in a NEW SESSION (setsid) so it fully
        //    outlives this app — the window closes right after, and the keystroke
        //    must still fire ~delay ms later. ydotool's own --delay does the
        //    waiting (giving focus time to return to the previous window), and
        //    YDOTOOL_SOCKET is set explicitly so it always finds ydotoold.
        let mut cmd = Command::new("setsid");
        cmd.arg("ydotool")
            .arg("key")
            .arg("--delay")
            .arg(delay.to_string())
            .arg(&paste_key)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(s) = &socket {
            cmd.env("YDOTOOL_SOCKET", s);
        }
        cmd.spawn().map_err(|e| {
            append_log(&format!("[paste] ydotool spawn failed: {e}"));
            format!("failed to run ydotool: {e}")
        })?;
        append_log("[paste] ydotool spawned (setsid, detached)");
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (text, paste_key, delay_ms);
        Err("Auto-paste is only implemented on Linux for now.".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be the FIRST plugin. When a second `transcriber` is launched
        // (e.g. the GNOME shortcut fires again), this callback runs in the
        // already-running instance and the second process exits. We reveal the
        // window here and emit "wake" so the frontend clears + re-acquires the
        // mic and starts recording.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::{Emitter, Manager};
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.emit("wake", ());
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            dump_wav,
            log_init,
            log_append,
            load_config,
            paste_diagnostics,
            paste_transcript
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
