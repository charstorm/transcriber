# transcriber info (dense; keep terse, low formatting)

PURPOSE: Tauri v2 desktop dictation app. Port of older python app "reshka" (alacritty TUI). Audio pipeline runs in web frontend. Rust = window/clipboard/paste/config-load/log only.

## Two apps (compare to debug transcription mismatches)
NEW transcriber: /home/vinay/universe/work/transcriber
OLD reshka (reference "good"): /home/vinay/universe/work/reshka/pyreshka/reshka_tui.py (single 955-line file)

## Pipeline both: mic 16kHz mono -> Silero VAD segments utterance -> WAV 16bit PCM -> base64 -> POST OpenAI-compat chat/completions with input_audio -> text. Both order results by capture-seq (parallel transcribe, flush in spoken order). Both model = mistralai/voxtral-small-24b-2507 (SAME in prod). Endpoint openrouter /api/v1.

## NEW key files/lines (src/app.js ~820 lines, monolithic; line nums approx)
- VAD via @ricky0123/vad-web@0.0.24, Silero v5 ONNX/WASM. MicVAD.new (model:"v5") acquireMic. Warm-swap mic (keep model warm, only stop tracks). FRAME_MS=32 (512smp@16k). v5 frame defaults = frameSamples 512 (we rely on lib v5 default, don't pass frameSamples).
- VAD_DEFAULTS app.js:~95. buildVadConfig ms->frames. CURRENT: pos/neg threshold 0.5/0.5, silenceMs 980, minSpeechMs 300, preSpeechPadMs 700 (pad+silence raised over reshka to offset v5's later onset / eager clause cutting; see session log below).
- getUserMedia MONKEY-PATCH near top (forceRawAudio, after log fn): strips EC/AGC/NS off EVERY capture incl vad-web's own hardcoded-true first-init call (lib spreads caller constraints BEFORE its hardcoded true, so options API can't override). => raw audio like reshka.
- SYSTEM_PROMPT app.js:~63 = char-for-char reshka JSON-envelope prompt. buildSystemPrompt appends UNTRIMMED config_instructions as "- {i}" under "Config Instructions:". parseTranscription (port of reshka _parse_json): strip fence, JSON.parse, return audio_transcription field.
- postTranscription ~400: temperature 0.01, NO user field. messages = system + user 3-part [text "[Audio]", input_audio wav, text "[/Audio] Response(json):"]. Retry loop exp backoff 1/2/4/8s, maxRetries 1.
- loadFileConfig merges ~/.config/transcriber/config.yaml (parsed by Rust load_config) over DEFAULTS. file.api_key -> config.apiKey. vad block in config OVERRIDES code defaults (so VAD changes must hit BOTH code + config.yaml).
- MIC_CONSTRAINTS: echoCancellation+autoGainControl+noiseSuppression ALL FALSE (raw audio; also enforced by the getUserMedia patch). Float32 audio.
- transcript font #transcript styles.css:~217 = 18px (was 14px).
- Rust src-tauri/src/lib.rs: load_config (yaml->json) ~63, NOW overlays TRANSCRIBER_API_KEY env as api_key (env wins over file, applied even if file missing); log_init/log_append; dump_wav; paste_transcript (wl-copy+ydotool); single-instance resident + wake event.
- Logs: ~/.cache/transcriber/transcriber.log (truncated each launch). Logs speech-end ms/samples/seq, bytes sent, full response per seq, "[init] getUserMedia patched" line. DUMP_AUDIO=true app.js:~11 dumps each utterance WAV to ~/.cache/transcriber/dumps/ (throwaway, remove before ship).
- API KEY: app gets key from TRANSCRIBER_API_KEY env (NOT OPENROUTER_API_KEY — that's reshka's). start_apps.sh sources ~/scripts/set_env.sh (SCRIPT_DIR-relative, set -a) before launching transcriber. set_env.sh holds TRANSCRIBER_API_KEY=... 402 Payment Required = that key's account is out of credits.

## OLD reshka key facts (reshka_tui.py)
- sounddevice InputStream raw int16, blocksize=512 (~632). NO browser preprocessing (raw mic).
- VAD = pysilero-vad (native Silero), SINGLE threshold 0.5 (is_speech = prob>=0.5). Hardcoded consts line122-126: VAD_THRESHOLD 0.5, MIN_SPEECH 300ms, MIN_SILENCE 700ms, SPEECH_PAD 300ms, MAX_SPEECH 300s. These NOT in its yaml.
- Ring buffer pre-speech pad (deque). Speech seg logic ~338-368.
- SYSTEM_PROMPT line128: JSON format, expects {"response":..., "audio_transcription":"..."}, parses audio_transcription field. Differs from new (new = plain text).
- config_instructions appended ~608-615: system_prompt + "\n\nConfig Instructions:\n" + "- {i}" per line. context_words optional (last 300 words as <context_words> hints; disabled in prod).
- 2 attempts total (range(2)) ~256 = 1 retry.
- Logs ~/.cache/reshka/debug_tui.log (overwrite each run). Does NOT log seg durations/audio. Session txt to ~/.cache/reshka/sessions/.
- config ~/.config/reshka/config.yaml: model/endpoint/config_instructions/context_words only.

## Prod configs (live, outside repo)
NEW: ~/.config/transcriber/config.yaml. OLD: ~/.config/reshka/config.yaml (dir is "reshka" NOT "pyreshka"). repo template = config.example.yaml.

## Build / deploy / launch
Build: `npm run tauri build` -> src-tauri/target/release/transcriber. DEPLOY: copy to ~/scripts/transcriber (what start_apps.sh launches). If "Text file busy" (app running): cp to transcriber.new then `mv -f` over (rename swaps dir entry, running inode untouched). `npm run build` = frontend only. Launch: bash ~/scripts/start_apps.sh {reshka|transcriber}.

## Work done 2026-06-29 session 1 (commit 3553241): MATCHED new->old: config_instructions support+block; VAD/retry silence 800->700, min_speech 250->300, pre_speech_pad 160->300, neg_threshold 0.35->0.5, max_retries 3->1. (pad+silence later re-tuned in session 2.)

## Work done 2026-06-29 session 2 (commits ec5313e, f2df92e, 211c8c9, a80b7ba, + prompt-parity 7c142d7)
A/B tested old-vs-new live (paste both, compare). Verdict: new now daily-usable, JSON envelope holds (no assistant-style leakage), first-word clipping greatly reduced.
1. Prompt/payload byte-identical to reshka (see NEW section). temp 0.01, no user field = intentional overrides.
2. API key via TRANSCRIBER_API_KEY env (was failing 402 — new app used empty in-app key).
3. Raw audio: getUserMedia patch + MIC_CONSTRAINTS false. Fixed aggressive splitting from NS gating inter-word pauses to silence.
4. VAD: preSpeechPadMs 300->700 (recover clipped first word; v5 onset later than pysilero), silenceMs 700->980 (+40%, fewer mid-sentence cuts). Cost: ~0.3s later finalize.
5. Transcript font 14->18px.

## Work done 2026-06-29 session 3 (desktop icon + paste delay; NO repo code change)
1. Dock icon fix (Linux/GNOME Wayland). Was generic gear: NO .desktop file matched the window. GNOME Wayland matches dock icon by Wayland app_id == .desktop filename basename (and StartupWMClass). KEY GOTCHA: window app_id is "transcriber" (productName/binary name), NOT the Tauri identifier "com.medrenova.transcriber". Confirmed via `WAYLAND_DEBUG=1 transcriber 2>&1 | grep set_app_id` -> set_app_id("transcriber"). (GNOME introspection — Shell.Eval, Introspect.GetWindows — is access-denied, can't query app_id that way; use WAYLAND_DEBUG or Looking Glass `lg`.)
   FIX (all OUTSIDE repo, in ~/.local/share, not committed): icons installed as ~/.local/share/icons/hicolor/{32x32,128x128,256x256}/apps/transcriber.png (from src-tauri/icons/*.png); ~/.local/share/applications/transcriber.desktop with Icon=transcriber, StartupWMClass=transcriber, Exec=bash ~/scripts/start_apps.sh transcriber. Then update-desktop-database + gtk-update-icon-cache. App restart (not shell) picks it up. Icon currently = default Tauri logo; custom icon = future task (replace src-tauri/icons + re-install).
2. Paste delay: prod ~/.config/transcriber/config.yaml paste_delay_ms 800->300 (user edited live; no rebuild — it's a config value passed to ydotool --delay). Code DEFAULT still 800 (app.js:~74) + config.example.yaml still 800 — left as-is per user.

## Remaining / next session
1. Cutting STILL a bit aggressive occasionally (user-observed) even after VAD tune — vad-web Silero v5 vs native pysilero boundary diff is the root; may need further pad/silence tuning or a custom end-of-speech heuristic.
2. int16 conversion rounding (app.js s*0x8000/0x7fff vs numpy cast) — minor, likely negligible.
3. UX deferred (user explicitly "another time"): (a) "dock falling from top" open animation instead of normal app window; (b) color scheme improvement (current dark grayscale ok but not great); (c) custom app icon (currently default Tauri logo — replace src-tauri/icons/*.png then re-run the ~/.local/share icon+desktop install from session 3).

## Gotcha
@ricky0123/vad-web bundles OWN nested onnxruntime-web@1.14.0. WASM in public/vad/ MUST come from that nested copy (scripts/copy-vad-assets.mjs handles via prebuild/predev). Version mismatch breaks inference.
