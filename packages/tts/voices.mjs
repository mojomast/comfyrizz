// Selectable presets use only controls implemented by the production adapters.
export const KOKORO_VOICES = [
  ...['alloy', 'aoede', 'bella', 'heart', 'jessica', 'kore', 'nicole', 'nova', 'river', 'sarah', 'sky'].map(name => ({ id: `af_${name}`, label: `${name} · US female`, language: 'en-us' })),
  ...['adam', 'echo', 'eric', 'fenrir', 'liam', 'michael', 'onyx', 'puck', 'santa'].map(name => ({ id: `am_${name}`, label: `${name} · US male`, language: 'en-us' })),
  ...['alice', 'emma', 'isabella', 'lily'].map(name => ({ id: `bf_${name}`, label: `${name} · British female`, language: 'en-gb' })),
  ...['daniel', 'fable', 'george', 'lewis'].map(name => ({ id: `bm_${name}`, label: `${name} · British male`, language: 'en-gb' })),
  { id: 'ff_siwis', label: 'Siwis · French female', language: 'fr-fr' },
];
export const QWEN_SPEAKERS = ['Ryan', 'Aiden', 'Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric', 'Ono_Anna', 'Sohee'];
const kokoro = { enabled: true, engine: 'kokoro', language: 'en-us', speed: 0.98 };
const qwen = { enabled: true, engine: 'qwen3-tts', speed: 1, language: 'en-us', strict: true };
export const VOICE_PRESETS = [
  { id: 'michael-sentence', label: 'Michael · original sentence delivery', voice: { ...kokoro, voice: 'am_michael', chunking: 'sentence' } },
  { id: 'michael-context', label: 'Michael · connected paragraph', voice: { ...kokoro, voice: 'am_michael', chunking: 'paragraph' } },
  { id: 'michael-relaxed', label: 'Michael · relaxed paragraph', voice: { ...kokoro, voice: 'am_michael', chunking: 'paragraph', speed: 0.93 } },
  { id: 'michael-fenrir', label: 'Michael / Fenrir · 70 / 30 blend', voice: { ...kokoro, voice: 'am_michael', chunking: 'paragraph', blend: [{ voice: 'am_michael', weight: 0.7 }, { voice: 'am_fenrir', weight: 0.3 }] } },
  { id: 'heart', label: 'Heart · warm female', voice: { ...kokoro, voice: 'af_heart', chunking: 'paragraph' } },
  { id: 'bella', label: 'Bella · female narrator', voice: { ...kokoro, voice: 'af_bella', chunking: 'paragraph' } },
  { id: 'ryan-curious', label: 'Qwen Ryan · curious and conversational', voice: { ...qwen, voice: 'Ryan', qwen_mode: 'custom', non_streaming: true, delivery: 'Warm, curious, conversational American English. Speak as if talking to one person. Use varied intonation and gentle emphasis on the important ideas.' } },
  { id: 'ryan-thoughtful', label: 'Qwen Ryan · thoughtful storyteller', voice: { ...qwen, voice: 'Ryan', qwen_mode: 'custom', non_streaming: true, delivery: 'Thoughtful and intimate, like sharing something you learned with a friend. Begin gently, let the realization brighten the middle, and finish with quiet confidence. Natural American English and unhurried phrasing.' } },
  { id: 'aiden', label: 'Qwen Aiden · clear American narrator', voice: { ...qwen, voice: 'Aiden', qwen_mode: 'custom', non_streaming: true, delivery: 'Warm, clear and conversational. Explain the idea with relaxed confidence and natural pauses.' } },
  { id: 'designed-conversational', label: 'Qwen designed female · conversational', voice: { ...qwen, voice: 'conversational-narrator', qwen_mode: 'design', non_streaming: false, persona: 'An adult female narrator with a warm low-mid register and clear neutral American English. Curious, friendly and conversational, as if sharing a discovery with one person. Varied intonation, relaxed breath pauses and gentle emphasis on what changed and why it matters. Clean close-microphone studio sound.' } },
];
