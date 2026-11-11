// Translates sentences on the computer with small ONNX translation models, run by
// transformers.js and ONNX Runtime's WebAssembly build (vendor/transformers/). The
// background worker creates this document and passes it { to: 'offscreen', type, lang }
// messages; it's the only extension page that's always there and can run WebAssembly.
//
// The models are downloaded from Hugging Face once, when the popup's Download button asks
// for them, and kept in the browser's cache for this extension:
//   Chinese (zh, zh-Hant): Helsinki-NLP opus-mt-en-zh (Apache-2.0), ONNX by Xenova.
//   Japanese (ja): FuguMT en-ja by staka (CC BY-SA 4.0), ONNX by Kadonox.
import { pipeline, env } from '../../vendor/transformers/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/transformers/');
// Several threads need SharedArrayBuffer, so the manifest makes extension pages
// cross-origin isolated.
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

// Pinned revisions, so an update upstream can't change what's downloaded. size: the
// quantized files in MB, to show download progress before every file's size is known.
const MODELS = {
  'opus-mt-en-zh': { id: 'Xenova/opus-mt-en-zh', revision: '046f55aec303cdee3e0318604406d4df20f1e8ea', size: 119 },
  'fugumt-en-ja': { id: 'Kadonox/fugumt-en-ja-onnx', revision: '0997e6ce157c3e784fcfc9917bf57ab4c74dbadc', size: 148 },
};
// The model for each target language; opus-mt-en-zh picks its script from a tag.
const TARGETS = {
  zh: { model: 'opus-mt-en-zh', prefix: '>>cmn_Hans<< ' },
  'zh-Hant': { model: 'opus-mt-en-zh', prefix: '>>cmn_Hant<< ' },
  ja: { model: 'fugumt-en-ja', prefix: '' },
};

const pipelines = new Map(); // model -> Promise<pipeline>
const progress = new Map(); // model -> Map(file -> { loaded, total }) while downloading
const errors = new Map(); // model -> message of the last failed download

// Downloaded models are noted in localStorage (offscreen documents have no chrome.storage).
const isDownloaded = (key) => localStorage.getItem(`model:${key}`) === MODELS[key].revision;

function load(key) {
  if (!pipelines.has(key)) {
    const { id, revision } = MODELS[key];
    const files = new Map();
    progress.set(key, files);
    errors.delete(key);
    const loading = pipeline('translation', id, {
      revision,
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (e) => {
        if (e.status === 'progress' && e.file) files.set(e.file, { loaded: e.loaded || 0, total: e.total || 0 });
      },
    }).then((pipe) => {
      progress.delete(key);
      const first = !isDownloaded(key);
      localStorage.setItem(`model:${key}`, revision);
      if (first) chrome.runtime.sendMessage({ type: 'rc-model-ready', model: key }).catch(() => {});
      return pipe;
    }, (e) => {
      progress.delete(key);
      pipelines.delete(key);
      errors.set(key, String(e?.message || e));
      throw e;
    });
    pipelines.set(key, loading);
  }
  return pipelines.get(key);
}

// { state, loaded?, total?, error? } for the model a language needs: 'ready' once
// downloaded, 'downloading' with MB so far, 'error' after a failed download, else
// 'downloadable'.
function status(key) {
  const size = MODELS[key].size;
  if (progress.has(key)) {
    let loaded = 0;
    let total = 0;
    for (const f of progress.get(key).values()) {
      loaded += f.loaded;
      total += f.total;
    }
    return { state: 'downloading', loaded: loaded / 1e6, total: Math.max(total / 1e6, size) };
  }
  if (isDownloaded(key)) return { state: 'ready', total: size };
  if (errors.has(key)) return { state: 'error', error: errors.get(key), total: size };
  return { state: 'downloadable', total: size };
}

// The models run one sentence at a time.
let queue = Promise.resolve();
function translate(lang, text) {
  const { model, prefix } = TARGETS[lang];
  const job = queue.then(async () => {
    const pipe = await load(model);
    const [out] = await pipe(prefix + text);
    return out.translation_text;
  });
  queue = job.catch(() => {});
  return job;
}

async function handle(msg) {
  const target = TARGETS[msg.lang];
  if (!target) return { ok: false, state: 'error', error: `no model for ${msg.lang}` };
  const key = target.model;
  switch (msg.type) {
    case 'rc-translator': // a page asks whether it can translate
      if (!isDownloaded(key)) return { ok: false, ...status(key) };
      await load(key);
      return { ok: true, state: 'ready' };
    case 'rc-translate':
      if (!isDownloaded(key)) return { ok: false, ...status(key) };
      return { ok: true, text: await translate(msg.lang, String(msg.text)) };
    case 'rc-model-status':
      return { ok: true, ...status(key) };
    case 'rc-model-download':
      load(key).catch(() => {}); // the popup follows it with rc-model-status
      return { ok: true, ...status(key) };
    default:
      return { ok: false, state: 'error' };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.to !== 'offscreen') return;
  handle(msg).then(sendResponse, (e) => sendResponse({ ok: false, state: 'error', error: String(e?.message || e) }));
  return true;
});
