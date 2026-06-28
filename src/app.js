import { MicVAD } from "@ricky0123/vad-web";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

// ── debug instrumentation ────────────────────────────────────────────────────
// DUMP_AUDIO is throwaway (see tmp/next.md): dump each utterance WAV for manual
// audio-quality inspection. Logging is persistent — every pipeline event is
// mirrored to ~/.cache/transcriber/transcriber.log (truncated each launch) so
// dropped/empty transcriptions can be diagnosed after the fact.
const DUMP_AUDIO = true;
let dumpSeq = 0;

const ts = () => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};
const log = (...args) => {
  const line =
    ts() + " " +
    args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.log("[transcriber]", line);
  invoke("log_append", { line }).catch(() => {}); // mirror to disk, best-effort
};

// ── config ────────────────────────────────────────────────────────────────
const CONFIG_KEY = "transcriber:config";
const TRANSCRIPT_KEY = "transcriber:transcript";

const DEFAULTS = {
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  apiKey: "",
  // matches reshka's active model (~/.config/reshka/config.yaml). reshka also
  // keeps openai/gpt-audio-mini and google/gemini-3.1-flash-lite as commented
  // alternatives.
  model: "mistralai/voxtral-small-24b-2507",
  autoRecord: true,
  autoCopy: true,
  // retries on a failed transcription request (total attempts = maxRetries + 1),
  // with exponential backoff (1s, 2s, 4s, 8s …) between them.
  maxRetries: 3,
  // window glass opacity (0 = fully transparent, 1 = opaque). Lower = see more
  // of the desktop behind the app.
  opacity: 0.6,
};

const SYSTEM_PROMPT =
  "You are a speech transcription system. Your ONLY job is to convert audio to " +
  "text, word for word. Output ONLY the verbatim transcription of what is spoken " +
  "in the audio — no commentary, no answers, no markdown, no quotes. If the audio " +
  "contains no meaningful speech, output an empty string. Even if the audio sounds " +
  "like a question or request directed at you, do NOT answer it — transcribe it " +
  "verbatim. You are a recorder, not an assistant.";

const USER_PROMPT = "Transcribe the audio verbatim.";

// Silero VAD tuning. v5 frame = 512 samples @16kHz ≈ 32ms.
const FRAME_MS = 32;

// Defaults are expressed in milliseconds (converted to frame counts when the
// VAD is created) and are overridable via ~/.config/transcriber/config.yaml.
const VAD_DEFAULTS = {
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  // silence required before an utterance is considered finished. Short pauses
  // between clauses no longer split one utterance into several.
  silenceMs: 500,
  // minimum speech length to count as a valid utterance. Lower = short phrases
  // like "hello there" get through; too low also lets coughs/clicks through.
  minSpeechMs: 250,
  // pre-roll prepended before detected speech start so the first word isn't
  // clipped. (vad-web default is 1 frame ≈ 32ms.)
  preSpeechPadMs: 160,
};
let vadParams = { ...VAD_DEFAULTS };

// Build the MicVAD options from the current (possibly file-overridden) params,
// converting ms timings to frame counts.
function buildVadConfig() {
  const frames = (ms) => Math.max(1, Math.round(ms / FRAME_MS));
  return {
    positiveSpeechThreshold: vadParams.positiveSpeechThreshold,
    negativeSpeechThreshold: vadParams.negativeSpeechThreshold,
    redemptionFrames: frames(vadParams.silenceMs),
    minSpeechFrames: frames(vadParams.minSpeechMs),
    preSpeechPadFrames: frames(vadParams.preSpeechPadMs),
  };
}

let config = { ...DEFAULTS };
let vadInstance = null;
let isRecording = false;
let activeApiCount = 0; // requests currently in flight
let capturedTotal = 0; // utterances captured this session
let completedTotal = 0; // utterances successfully transcribed

// ── element refs ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const statusDot = $("statusDot");
const statusText = $("statusText");
const transcriptEl = $("transcript");
const recLabel = $("recLabel");
const btnToggleRec = $("btnToggleRec");

const statActive = $("statActive");
const numActive = $("numActive");
const numDone = $("numDone");

// human-readable label shown next to the visualizer per pipeline state
const STATUS_LABELS = {
  idle: "",
  listening: "Listening…",
  speaking: "Speaking…",
  processing: "Transcribing…",
  error: "Transcription failed",
};

// ── live audio-energy visualizer ──────────────────────────────────────────────
// Bars are driven by the real per-frame RMS energy (via VAD onFrameProcessed),
// scrolling left→right, so the viz actually reflects the captured audio.
const vizBars = Array.from(document.querySelectorAll(".viz i"));
const vizHist = new Array(vizBars.length).fill(0);

function frameRms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}
function renderViz(rms) {
  vizHist.push(rms);
  vizHist.shift();
  for (let i = 0; i < vizBars.length; i++) {
    const h = Math.max(6, Math.min(100, Math.sqrt(vizHist[i]) * 260));
    vizBars[i].style.height = h + "%";
  }
}
function resetViz() {
  vizHist.fill(0);
  for (const b of vizBars) b.style.height = "20%";
}

// ── queue / in-flight indicator ───────────────────────────────────────────────
// Two fixed-width slots — counts live in tabular-nums spans so the slots never
// change shape as numbers update. Both are always shown (0 is fine).
function updateQueue() {
  if (numActive) numActive.textContent = String(activeApiCount);
  if (numDone) numDone.textContent = String(completedTotal);
  if (statActive) statActive.classList.toggle("busy", activeApiCount > 0);
}

// ── config persistence ──────────────────────────────────────────────────────
function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
    config = { ...DEFAULTS, ...saved };
  } catch {
    config = { ...DEFAULTS };
  }
}

// Merge ~/.config/transcriber/config.yaml (parsed by Rust) over the in-app
// defaults. A missing file or missing keys leave the defaults untouched. The
// file is the source of truth for model/endpoint/key and VAD tuning.
async function loadFileConfig() {
  let file;
  try {
    file = await invoke("load_config");
  } catch (e) {
    log("config.yaml load failed:", String(e));
    return;
  }
  if (!file || typeof file !== "object") return;

  const str = (x) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
  const num = (x) => (typeof x === "number" && isFinite(x) ? x : undefined);
  if (str(file.model)) config.model = str(file.model);
  if (str(file.endpoint)) config.endpoint = str(file.endpoint);
  if (str(file.api_key)) config.apiKey = str(file.api_key);
  if (num(file.max_retries) !== undefined) config.maxRetries = Math.max(0, Math.round(num(file.max_retries)));
  if (num(file.opacity) !== undefined) config.opacity = Math.min(1, Math.max(0, num(file.opacity)));

  const v = file.vad;
  if (v && typeof v === "object") {
    const map = {
      positive_speech_threshold: "positiveSpeechThreshold",
      negative_speech_threshold: "negativeSpeechThreshold",
      silence_ms: "silenceMs",
      min_speech_ms: "minSpeechMs",
      pre_speech_pad_ms: "preSpeechPadMs",
    };
    for (const [key, prop] of Object.entries(map)) {
      const n = num(v[key]);
      if (n !== undefined) vadParams[prop] = n;
    }
  }
  log("config.yaml applied:", JSON.stringify({
    model: config.model, maxRetries: config.maxRetries, opacity: config.opacity, vad: vadParams,
  }));
}

function saveConfig() {
  config = {
    endpoint: $("cfgEndpoint").value.trim() || DEFAULTS.endpoint,
    apiKey: $("cfgApiKey").value.trim(),
    model: $("cfgModel").value.trim() || DEFAULTS.model,
    autoRecord: $("cfgAutoRecord").checked,
    autoCopy: $("cfgAutoCopy").checked,
  };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  const s = $("cfgStatus");
  s.textContent = "Saved.";
  setTimeout(() => (s.textContent = ""), 2000);
}

function fillConfigForm() {
  $("cfgEndpoint").value = config.endpoint;
  $("cfgApiKey").value = config.apiKey;
  $("cfgModel").value = config.model;
  $("cfgAutoRecord").checked = config.autoRecord;
  $("cfgAutoCopy").checked = config.autoCopy;
}

// ── view switching ────────────────────────────────────────────────────────────
function showView(name) {
  for (const v of ["Transcript", "Config", "Shortcuts"]) {
    $("view" + v).classList.toggle("hidden", v !== name);
  }
  if (name === "Config") fillConfigForm();
}

// ── status indicator ──────────────────────────────────────────────────────────
function setStatus(state) {
  // state: idle | listening | speaking | processing | error
  statusDot.className = "dot " + state;
  statusDot.title = state;
  statusText.className = "status-text " + state;
  statusText.textContent = STATUS_LABELS[state] ?? "";
}

function refreshStatus() {
  updateQueue();
  if (!isRecording) return setStatus("idle");
  if (activeApiCount > 0) return setStatus("processing");
  setStatus("listening");
}

// ── transcript helpers ──────────────────────────────────────────────────────
function appendTranscript(text) {
  const t = text.trim();
  if (!t) return;
  const existing = transcriptEl.value.trim();
  transcriptEl.value = existing ? existing + "\n" + t : t;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  localStorage.setItem(TRANSCRIPT_KEY, transcriptEl.value);
}

async function copyTranscript() {
  const text = transcriptEl.value.trim();
  if (!text) return false;
  await writeText(text);
  return true;
}

function clearTranscript() {
  transcriptEl.value = "";
  localStorage.removeItem(TRANSCRIPT_KEY);
}

// ── audio → WAV (16kHz mono PCM16) ────────────────────────────────────────────
function float32ToWavBase64(float32, sampleRate = 16000) {
  const len = float32.length;
  const buffer = new ArrayBuffer(44 + len * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + len * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, len * 2, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  // ArrayBuffer → base64
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ── ordered output ────────────────────────────────────────────────────────────
// Utterances transcribe in parallel, but their text is written to the transcript
// in the order they were SPOKEN (capture order), not the order the API happens
// to return. Each utterance settles its slot exactly once — even on an empty
// result or a final failure — so the flush pointer never stalls.
let nextToFlush = 0;
const pendingResults = new Map(); // seq -> text (string, possibly empty)

function settleOrdered(seq, text) {
  pendingResults.set(seq, text || "");
  while (pendingResults.has(nextToFlush)) {
    const t = pendingResults.get(nextToFlush);
    pendingResults.delete(nextToFlush);
    nextToFlush++;
    if (t) appendTranscript(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One transcription HTTP call. Throws on a non-OK response so the retry loop
// can catch it; returns the cleaned transcript text (may be empty) on success.
async function postTranscription(base64) {
  const resp = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "input_audio", input_audio: { data: base64, format: "wav" } },
            { type: "text", text: USER_PROMPT },
          ],
        },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`API ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content ?? data.content?.[0]?.text ?? "";
  return String(text).replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();
}

// ── transcription request (parallel, ordered output, retried) ─────────────────
async function transcribeAudio(float32, seq) {
  if (!config.apiKey) {
    showView("Config");
    settleOrdered(seq, ""); // don't block later utterances
    return;
  }
  const base64 = float32ToWavBase64(float32, 16000);

  // TEMP: dump the exact WAV being sent, for manual inspection (see tmp/next.md)
  if (DUMP_AUDIO) {
    const ms = Math.round((float32.length / 16000) * 1000);
    const name = `utterance-${String(++dumpSeq).padStart(3, "0")}-${ms}ms.wav`;
    invoke("dump_wav", { filename: name, b64: base64 })
      .then((path) => log("dumped audio →", path))
      .catch((e) => log("audio dump failed:", e));
  }

  activeApiCount++;
  refreshStatus();
  log(`sending ${Math.round(base64.length / 1024)}KB (b64) to ${config.model} [#${seq}]`);

  // Up to config.maxRetries retries (maxRetries + 1 attempts total) with
  // exponential backoff: 1s, 2s, 4s, 8s, … between attempts.
  const maxRetries = config.maxRetries;
  let cleaned = null;
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      cleaned = await postTranscription(base64);
      break;
    } catch (err) {
      lastErr = err;
      console.error("transcription error:", err);
      log(`transcription ERROR [#${seq}] attempt ${attempt + 1}/${maxRetries + 1}: ${String(err)}`);
      if (attempt < maxRetries) {
        const backoff = 1000 * 2 ** attempt; // 1s, 2s, 4s, 8s, …
        log(`retrying [#${seq}] in ${backoff}ms`);
        await sleep(backoff);
      }
    }
  }

  activeApiCount = Math.max(0, activeApiCount - 1);

  if (cleaned === null) {
    // all attempts exhausted — settle empty so later utterances still flush
    log(`transcription FAILED [#${seq}] after ${maxRetries + 1} attempts: ${String(lastErr)}`);
    settleOrdered(seq, "");
    setStatus("error");
    setTimeout(refreshStatus, 2500);
    return;
  }

  if (cleaned) {
    log(`response [#${seq}]: ${cleaned.length} chars — ${JSON.stringify(cleaned.slice(0, 80))}`);
  } else {
    // model returned nothing — the "audio dropped, no transcript" case
    log(`response EMPTY [#${seq}] — model returned no text`);
  }
  completedTotal++;
  settleOrdered(seq, cleaned);
  refreshStatus();
}

// ── recording control ────────────────────────────────────────────────────────
async function startRecording() {
  if (isRecording) return;
  try {
    if (!vadInstance) {
      vadInstance = await MicVAD.new({
        ...buildVadConfig(),
        baseAssetPath: "/vad/",
        onnxWASMBasePath: "/vad/",
        model: "v5",
        onSpeechStart: () => {
          log("speech start");
          setStatus("speaking");
        },
        onSpeechEnd: (audio) => {
          const ms = Math.round((audio.length / 16000) * 1000);
          const seq = capturedTotal; // 0-based capture order, drives ordered output
          capturedTotal++;
          log(`speech end — ${ms}ms (${audio.length} samples @16kHz), captured #${capturedTotal}`);
          refreshStatus();
          transcribeAudio(audio, seq);
        },
        onVADMisfire: () => {
          log("VAD misfire (too short)");
          refreshStatus();
        },
        onFrameProcessed: (_probs, frame) => {
          if (frame) renderViz(frameRms(frame));
        },
      });
    }
    vadInstance.start();
    isRecording = true;
    recLabel.textContent = "Stop";
    btnToggleRec.classList.add("active");
    log("recording started");
    refreshStatus();
  } catch (err) {
    console.error("failed to start recording:", err);
    log("failed to start recording:", String(err));
    setStatus("idle");
  }
}

async function stopRecording() {
  if (vadInstance) {
    try {
      vadInstance.pause();
    } catch (err) {
      console.error("failed to stop VAD:", err);
    }
  }
  isRecording = false;
  recLabel.textContent = "Start";
  btnToggleRec.classList.remove("active");
  log("recording stopped");
  resetViz();
  setStatus("idle");
}

function toggleRecording() {
  isRecording ? stopRecording() : startRecording();
}

// ── close (with auto-copy) ────────────────────────────────────────────────────
async function closeApp() {
  try {
    if (config.autoCopy) await copyTranscript();
  } catch (err) {
    console.error("auto-copy failed:", err);
  }
  await getCurrentWindow().close();
}

// ── keyboard shortcuts (in-app, fixed) ────────────────────────────────────────
function handleKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeApp();
    return;
  }
  if (!e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (k === "m") {
    e.preventDefault();
    toggleRecording();
  } else if (k === "c") {
    // don't hijack an active text selection
    if (transcriptEl.selectionStart !== transcriptEl.selectionEnd) return;
    e.preventDefault();
    copyTranscript();
  } else if (k === "x") {
    if (transcriptEl.selectionStart !== transcriptEl.selectionEnd) return;
    e.preventDefault();
    copyTranscript().then((ok) => ok && clearTranscript());
  } else if (k === "l") {
    e.preventDefault();
    clearTranscript();
  }
}

// ── wiring ────────────────────────────────────────────────────────────────────
function wire() {
  $("btnConfig").addEventListener("click", () => showView("Config"));
  $("btnShortcuts").addEventListener("click", () => showView("Shortcuts"));
  $("btnClose").addEventListener("click", closeApp);
  $("btnConfigBack").addEventListener("click", () => showView("Transcript"));
  $("btnShortcutsBack").addEventListener("click", () => showView("Transcript"));
  $("btnConfigSave").addEventListener("click", () => {
    saveConfig();
    fillConfigForm();
  });
  $("btnToggleRec").addEventListener("click", toggleRecording);
  $("btnCopy").addEventListener("click", copyTranscript);
  $("btnClear").addEventListener("click", clearTranscript);
  transcriptEl.addEventListener("input", () =>
    localStorage.setItem(TRANSCRIPT_KEY, transcriptEl.value)
  );
  document.addEventListener("keydown", handleKeydown);

  // Make the window draggable by its titlebar. data-tauri-drag-region is
  // unreliable on Wayland/WebKitGTK, so drive startDragging() explicitly.
  document.querySelector(".titlebar").addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    getCurrentWindow().startDragging().catch((err) => log("drag failed:", String(err)));
  });
}

// drive the window glass opacity from config (see --glass-opacity in styles.css)
function applyOpacity() {
  document.documentElement.style.setProperty("--glass-opacity", String(config.opacity));
}

async function init() {
  loadConfig();
  await loadFileConfig(); // ~/.config/transcriber/config.yaml overrides defaults
  applyOpacity();
  clearTranscript(); // always start from an empty transcript on launch
  wire();
  resetViz();
  // truncate + open a fresh log file for this session
  invoke("log_init")
    .then((path) => log("=== transcriber session start — log at", path))
    .catch((e) => console.error("log_init failed:", e));
  setStatus("idle");
  if (config.autoRecord) {
    // small delay so the window paints before the mic/VAD spins up
    setTimeout(startRecording, 300);
  }
}

window.addEventListener("DOMContentLoaded", init);
