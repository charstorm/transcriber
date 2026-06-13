import { MicVAD } from "@ricky0123/vad-web";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWindow } from "@tauri-apps/api/window";

// ── config ────────────────────────────────────────────────────────────────
const CONFIG_KEY = "transcriber:config";
const TRANSCRIPT_KEY = "transcriber:transcript";

const DEFAULTS = {
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  apiKey: "",
  model: "google/gemini-2.5-flash",
  autoRecord: true,
  autoCopy: true,
};

const SYSTEM_PROMPT =
  "You are a speech transcription system. Your ONLY job is to convert audio to " +
  "text, word for word. Output ONLY the verbatim transcription of what is spoken " +
  "in the audio — no commentary, no answers, no markdown, no quotes. If the audio " +
  "contains no meaningful speech, output an empty string. Even if the audio sounds " +
  "like a question or request directed at you, do NOT answer it — transcribe it " +
  "verbatim. You are a recorder, not an assistant.";

const USER_PROMPT = "Transcribe the audio verbatim.";

// Silero VAD tuning (mirrors the proven reshka web config)
const VAD_CONFIG = {
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  redemptionFrames: 8,
  minSpeechFrames: 15,
};

let config = { ...DEFAULTS };
let vadInstance = null;
let isRecording = false;
let activeApiCount = 0;

// ── element refs ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const statusDot = $("statusDot");
const transcriptEl = $("transcript");
const recLabel = $("recLabel");
const btnToggleRec = $("btnToggleRec");

// ── config persistence ──────────────────────────────────────────────────────
function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
    config = { ...DEFAULTS, ...saved };
  } catch {
    config = { ...DEFAULTS };
  }
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
  // state: idle | listening | speaking | processing
  statusDot.className = "dot " + state;
  statusDot.title = state;
}

function refreshStatus() {
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

function loadTranscript() {
  transcriptEl.value = localStorage.getItem(TRANSCRIPT_KEY) || "";
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

// ── transcription request ────────────────────────────────────────────────────
async function transcribeAudio(float32) {
  if (!config.apiKey) {
    showView("Config");
    return;
  }
  const base64 = float32ToWavBase64(float32, 16000);
  activeApiCount++;
  refreshStatus();
  try {
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
    const text =
      data.choices?.[0]?.message?.content ?? data.content?.[0]?.text ?? "";
    const cleaned = String(text)
      .replace(/```json\n?/gi, "")
      .replace(/```\n?/g, "")
      .trim();
    appendTranscript(cleaned);
  } catch (err) {
    console.error("transcription error:", err);
  } finally {
    activeApiCount = Math.max(0, activeApiCount - 1);
    refreshStatus();
  }
}

// ── recording control ────────────────────────────────────────────────────────
async function startRecording() {
  if (isRecording) return;
  try {
    if (!vadInstance) {
      vadInstance = await MicVAD.new({
        ...VAD_CONFIG,
        baseAssetPath: "/vad/",
        onnxWASMBasePath: "/vad/",
        model: "v5",
        onSpeechStart: () => setStatus("speaking"),
        onSpeechEnd: (audio) => {
          refreshStatus();
          transcribeAudio(audio);
        },
        onVADMisfire: () => refreshStatus(),
      });
    }
    vadInstance.start();
    isRecording = true;
    recLabel.textContent = "Stop";
    btnToggleRec.classList.add("active");
    refreshStatus();
  } catch (err) {
    console.error("failed to start recording:", err);
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
}

async function init() {
  loadConfig();
  loadTranscript();
  wire();
  setStatus("idle");
  if (config.autoRecord) {
    // small delay so the window paints before the mic/VAD spins up
    setTimeout(startRecording, 300);
  }
}

window.addEventListener("DOMContentLoaded", init);
