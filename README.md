# transcriber

A lightweight, handsfree speech-transcription desktop app built with
[Tauri](https://tauri.app/). A compact, frameless, always-on-top window that
records the moment it launches, runs voice-activity detection locally, and sends
each speech segment to an OpenAI-compatible chat-completions endpoint for
transcription.

> Name is not final — currently `transcriber`. To rename later, change
> `productName`/`identifier` in `src-tauri/tauri.conf.json`, the `package`/`lib`
> names in `src-tauri/Cargo.toml` (and the `*_lib::run()` call in `main.rs`), and
> the window `title`.

## How it works

The audio pipeline runs entirely in the web frontend:

1. **Capture + VAD** — [`@ricky0123/vad-web`](https://github.com/ricky0123/vad)
   (Silero VAD via onnxruntime-web/WASM) captures the mic and emits speech
   segments.
2. **Encode** — each segment is converted to 16 kHz mono WAV → base64.
3. **Transcribe** — posted as `input_audio` to a configurable
   OpenAI-compatible `chat/completions` endpoint (default: OpenRouter).
4. **Display** — the returned text is appended to the transcript.

Rust (Tauri) provides the native window, the clipboard (auto-copy on close),
and — on Linux — auto-grants the WebKitGTK microphone permission.

### VAD/onnx assets are vendored, not CDN

`scripts/copy-vad-assets.mjs` copies the VAD worklet, Silero model, and the
matching onnxruntime WASM out of `node_modules` into `public/vad/` so the app
works fully offline. It runs automatically before `dev` and `build`.

## Configuration

Open the ⚙ button in the titlebar. Settings persist in `localStorage`:

- **Endpoint URL** — any OpenAI-compatible `chat/completions` URL.
- **API Key** — sent as `Authorization: Bearer …`.
- **Model** — e.g. `google/gemini-2.5-flash`.
- **Auto-record on launch** — start listening as soon as the app opens.
- **Auto-copy on close** — copy the transcript to the clipboard when closing.

## Shortcuts (in-app, fixed for now)

| Key | Action |
| --- | --- |
| `Ctrl+M` | Start / stop recording |
| `Ctrl+C` | Copy transcript |
| `Ctrl+X` | Cut transcript |
| `Ctrl+L` | Clear transcript |
| `Esc` | Copy (if auto-copy on) & quit |

## Develop

```bash
npm install
npm run tauri dev      # launches the app (needs a display)
```

## Build

```bash
npm run tauri build    # produces a bundled binary for the current platform
```

## Platform support / roadmap

- **Linux** — primary target (developed on Wayland).
- **Windows** — planned next; the core is platform-agnostic, only bundling and
  the Linux-only mic-permission hook need adjustment.
- **Global shortcuts** — planned (`tauri-plugin-global-shortcut`); currently
  in-app only.
- **Configurable shortcuts** — planned; currently fixed.
- **Auto-paste** — intentionally deferred (not portable).
