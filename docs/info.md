# transcriber info (dense; keep terse, low formatting)

PURPOSE: Tauri v2 desktop dictation app. Port of older python app "reshka" (alacritty TUI). Audio pipeline runs in web frontend. Rust = window/clipboard/paste/config-load/log only.

## Two apps (compare to debug transcription mismatches)
NEW transcriber: /home/vinay/universe/work/transcriber
OLD reshka (reference "good"): /home/vinay/universe/work/reshka/pyreshka/reshka_tui.py (single 955-line file)

## Pipeline both: mic 16kHz mono -> Silero VAD segments utterance -> WAV 16bit PCM -> base64 -> POST OpenAI-compat chat/completions with input_audio -> text. Both order results by capture-seq (parallel transcribe, flush in spoken order). Both model = mistralai/voxtral-small-24b-2507 (SAME in prod). Endpoint openrouter /api/v1.

## NEW key files/lines (src/app.js ~790 lines, monolithic)
- VAD via @ricky0123/vad-web@0.0.24, Silero v5 ONNX/WASM. MicVAD.new app.js:~480. Warm-swap mic (keep model warm, only stop tracks) acquireMic/releaseMic ~471-528. FRAME_MS=32 (512smp@16k).
- VAD_DEFAULTS app.js:~68. buildVadConfig ms->frames ~85.
- SYSTEM_PROMPT app.js:~53 (plain verbatim, NOT json). buildSystemPrompt ~62 appends config_instructions as "- {i}" under "Config Instructions:" heading. systemPrompt var used in postTranscription messages.
- postTranscription ~360: temperature 0.2, system+user(input_audio wav + USER_PROMPT). Retry loop ~414 exp backoff 1/2/4/8s.
- loadFileConfig ~174 merges ~/.config/transcriber/config.yaml (parsed by Rust load_config) over DEFAULTS. Reads config_instructions array ~196.
- MIC_CONSTRAINTS ~464: echoCancellation+autoGainControl+noiseSuppression ALL TRUE (browser preprocessing — suspect for mismatch). Float32 audio.
- Rust src-tauri/src/lib.rs: load_config (yaml->json) ~63; log_init/log_append; dump_wav; paste_transcript (wl-copy+ydotool); single-instance resident + wake event.
- Logs: ~/.cache/transcriber/transcriber.log (truncated each launch). Already logs speech-end ms/samples/seq, bytes sent, full response per seq. DUMP_AUDIO=true app.js:11 dumps each utterance WAV to ~/.cache/transcriber/dumps/ (throwaway, remove before ship).

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

## Work done (2026-06-29, commit 3553241 + this commit)
MATCHED new->old to remove divergence:
1. config_instructions: added support in app.js (buildSystemPrompt) + copied reshka's full 10-line block into ~/.config/transcriber/config.yaml. Backup at ~/scripts/transcriber-config.yaml.
2. VAD/retry matched: silence_ms 800->700, min_speech 250->300, pre_speech_pad 160->300, negative_threshold 0.35->0.5 (reshka single-threshold), max_retries 3->1. Changed in code DEFAULTS, config.example.yaml, AND prod config.yaml.
Build: `npm run tauri build` -> src-tauri/target/release/transcriber. DEPLOY: copy to ~/scripts/transcriber (what start_apps.sh launches). `npm run build` = frontend only.
Launch: bash ~/scripts/start_apps.sh {reshka|transcriber}.

## Prompt/payload parity (DONE this session)
Made the LLM payload byte-identical to reshka for PROMPT+DATA (audio deferred):
- SYSTEM_PROMPT app.js:~56 now char-for-char copy of reshka _DEFAULT_SYSTEM_PROMPT (JSON envelope: {"response":fixed refusal,"audio_transcription":...}).
- User content app.js:~398 now reshka's 3-part order: text "[Audio]" / input_audio / text "[/Audio] Response(json):". Dropped old USER_PROMPT.
- buildSystemPrompt: bullets UNTRIMMED config_instructions (filter on trimmed-truthy) to match reshka:609-614 exactly.
- parseTranscription app.js (new fn, port of reshka _parse_json :747-755): strip fence, JSON.parse, return audio_transcription ("" if empty/missing/unparseable). postTranscription now calls it instead of returning raw content.
- INTENTIONAL divergences (user override, NOT matched): temperature=0.01 (reshka sends none); `user` field omitted (reshka sends "transcriber_tui").
- context_words: still omitted (disabled in prod both apps).

## Remaining divergences (NOT yet fixed; suspects for residual mismatch)
1. Browser audio preprocessing (AGC/NS/EC=true in MIC_CONSTRAINTS) vs reshka raw int16. Same model, different waveform. <- NEXT TARGET (audio).
2. VAD engine: vad-web Silero v5 vs native pysilero (boundaries differ even at same threshold).
3. int16 conversion rounding (app.js s*0x8000/0x7fff vs numpy cast) — only relevant after 1&2.

## Gotcha
@ricky0123/vad-web bundles OWN nested onnxruntime-web@1.14.0. WASM in public/vad/ MUST come from that nested copy (scripts/copy-vad-assets.mjs handles via prebuild/predev). Version mismatch breaks inference.
