import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalSpeechInspector } from '../src/local-speech-inspector.mjs';

function fixture(t) {
  const dir = mkdtempSync('/tmp/opencode/local-speech-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const python = join(dir, 'python'), weights = join(dir, 'weights.pt'), file = join(dir, 'film.mp4'), model = join(dir, 'model');
  for (const path of [python, weights, file]) writeFileSync(path, 'fixture');
  mkdirSync(model);
  for (const name of ['config.json', 'tokenizer.json', 'model.bin']) writeFileSync(join(model, name), '{}');
  return { dir, python, weights, file, model,
    env: { COMFYRIZZ_QA_WHISPER_PYTHON: python, COMFYRIZZ_QA_WHISPER_WEIGHTS: weights },
    fasterEnv: { COMFYRIZZ_QA_SPEECH_PROVIDER: 'faster-whisper', COMFYRIZZ_QA_FASTER_WHISPER_PYTHON: python, COMFYRIZZ_QA_FASTER_WHISPER_MODEL_DIR: model } };
}

const evidence = duration => ({ provider: 'fixture/version/hash', uncertaintySeconds: 0.1,
  analyzer: { vadFilter: false, conditionOnPreviousText: false, wordTimestamps: true, downmix: 'mono', timestampCoordinates: 'original_media' },
  segments: [{ start: duration - 2, end: duration - 1, text: 'late speech', words: [{ start: duration - 2, end: duration - 1, word: 'speech', probability: 0.7 }] }],
  coverage: { startSeconds: 0, endSeconds: duration, complete: true } });

test('optional configuration stays unavailable and invalid configuration cannot execute', async t => {
  const ctx = fixture(t);
  assert.equal(createLocalSpeechInspector({ env: {} }), null);
  const execute = () => assert.fail('invalid configuration executed');
  for (const env of [
    { COMFYRIZZ_QA_WHISPER_PYTHON: 'python', COMFYRIZZ_QA_WHISPER_WEIGHTS: 'base.en' },
    { ...ctx.env, COMFYRIZZ_QA_WHISPER_WEIGHTS: ctx.model },
    { ...ctx.env, COMFYRIZZ_QA_WHISPER_PYTHON: join(ctx.dir, 'missing') },
    { COMFYRIZZ_QA_FASTER_WHISPER_MODEL_DIR: ctx.model },
  ]) await assert.rejects(createLocalSpeechInspector({ env, execute })({ file: ctx.file, durationSeconds: 120 }), /no automatic installation\/download/);
  await assert.rejects(createLocalSpeechInspector({ env: { ...ctx.env, COMFYRIZZ_QA_SPEECH_PROVIDER: 'remote' }, execute })({}), /Unknown local ASR provider/);
});

test('120-second inspection passes complete coverage, uncertainty, cancellation and offline CPU configuration', async t => {
  const ctx = fixture(t);
  const signal = new AbortController().signal;
  const observed = evidence(120);
  const inspect = createLocalSpeechInspector({ env: { ...ctx.env, CUDA_VISIBLE_DEVICES: '0', HF_HUB_OFFLINE: '0', OMP_NUM_THREADS: '99' },
    execute: async (python, args, options) => {
      assert.equal(python, ctx.python);
      assert.match(args[0], /inspect-source-speech\.py$/);
      assert.deepEqual(args.slice(1), ['--weights', ctx.weights, '--media', ctx.file, '--duration-seconds', '120']);
      assert.equal(options.signal, signal);
      assert.equal(options.timeout, 90000);
      assert.equal(options.maxBuffer, 1024 * 1024);
      for (const key of ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_DATASETS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY']) assert.equal(options.env[key], '1');
      for (const key of ['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS']) assert.equal(options.env[key], '2');
      assert.equal(options.env.CUDA_VISIBLE_DEVICES, '');
      return { stdout: JSON.stringify(observed) };
    } });
  assert.deepEqual(await inspect({ file: ctx.file, durationSeconds: 120, signal, expectedText: 'never sent' }), observed);
});

test('invalid or unbounded durations and nonlocal media fail before execution', async t => {
  const ctx = fixture(t);
  const inspect = createLocalSpeechInspector({ env: ctx.env, execute: () => assert.fail('invalid request executed') });
  for (const durationSeconds of [undefined, NaN, Infinity, 0, -1, 120.001]) {
    await assert.rejects(inspect({ file: ctx.file, durationSeconds }), /at most 120 seconds/);
  }
  for (const file of ['relative.mp4', 'https://example.com/video.mp4', ctx.model, join(ctx.dir, 'missing')]) {
    await assert.rejects(inspect({ file, durationSeconds: 120 }), /absolute existing media/);
  }
});

test('faster-whisper is deliberately selected and requires all local model files', async t => {
  const ctx = fixture(t);
  let calls = 0;
  const execute = async (python, args) => {
    calls++;
    assert.equal(python, ctx.python);
    assert.match(args[0], /inspect-faster-speech\.py$/);
    assert.deepEqual(args.slice(1), ['--model-dir', ctx.model, '--media', ctx.file, '--duration-seconds', '90', '--vad-filter', 'false']);
    return { stdout: JSON.stringify(evidence(90)) };
  };
  const inspect = createLocalSpeechInspector({ env: ctx.fasterEnv, execute });
  assert.equal((await inspect({ file: ctx.file, durationSeconds: 90 })).coverage.endSeconds, 90);
  for (const name of ['tokenizer.json', 'config.json', 'model.bin']) {
    rmSync(join(ctx.model, name));
    await assert.rejects(inspect({ file: ctx.file, durationSeconds: 90 }), /no automatic installation\/download/);
    writeFileSync(join(ctx.model, name), '{}');
  }
  await assert.rejects(createLocalSpeechInspector({ env: { ...ctx.fasterEnv, COMFYRIZZ_QA_FASTER_WHISPER_MODEL_DIR: 'small' }, execute })({ file: ctx.file, durationSeconds: 90 }), /no automatic installation\/download/);
  assert.equal(calls, 1);
});

test('VAD is explicit, strictly validated and never retried or silently changed', async t => {
  const ctx = fixture(t);
  for (const vad of ['true', 'false']) {
    const inspect = createLocalSpeechInspector({ env: { ...ctx.fasterEnv, COMFYRIZZ_QA_FASTER_WHISPER_VAD: vad }, execute: async (python, args) => {
      assert.deepEqual(args.slice(-2), ['--vad-filter', vad]);
      const result = evidence(90);
      result.analyzer.vadFilter = vad === 'true';
      return { stdout: JSON.stringify(result) };
    } });
    assert.equal((await inspect({ file: ctx.file, durationSeconds: 90 })).analyzer.vadFilter, vad === 'true');
  }
  for (const vad of ['', '1', 'True', 'yes', ' false ']) await assert.rejects(createLocalSpeechInspector({
    env: { ...ctx.fasterEnv, COMFYRIZZ_QA_FASTER_WHISPER_VAD: vad }, execute: () => assert.fail('invalid VAD ran'),
  })({ file: ctx.file, durationSeconds: 90 }), /must be exactly true or false/);
  await assert.rejects(createLocalSpeechInspector({ env: { ...ctx.fasterEnv, COMFYRIZZ_QA_FASTER_WHISPER_VAD: 'true' },
    execute: async () => ({ stdout: JSON.stringify(evidence(90)) }),
  })({ file: ctx.file, durationSeconds: 90 }), /different analyzer settings/);
  let calls = 0;
  await assert.rejects(createLocalSpeechInspector({ env: ctx.fasterEnv, execute: async () => {
    calls++;
    throw new Error('find_alignment: IndexError');
  } })({ file: ctx.file, durationSeconds: 90 }), /IndexError/);
  assert.equal(calls, 1, 'an alignment failure must not trigger a retry in a different mode');
});

test('partial evidence, malformed output and process failures never become complete ASR', async t => {
  const ctx = fixture(t);
  for (const result of [
    { ...evidence(120), coverage: undefined },
    { ...evidence(120), coverage: { ...evidence(120).coverage, complete: false } },
    evidence(60),
    { ...evidence(120), coverage: { ...evidence(120).coverage, startSeconds: 60 } },
    { ...evidence(120), provider: 'x'.repeat(121) },
    { ...evidence(120), uncertaintySeconds: -1 },
  ]) {
    const inspect = createLocalSpeechInspector({ env: ctx.env, execute: async () => ({ stdout: JSON.stringify(result) }) });
    await assert.rejects(inspect({ file: ctx.file, durationSeconds: 120 }), /complete requested|invalid provider/);
  }
  await assert.rejects(createLocalSpeechInspector({ env: ctx.env, execute: async () => ({ stdout: 'broken json' }) })({ file: ctx.file, durationSeconds: 120 }), SyntaxError);
  const cancelled = Object.assign(new Error('cancelled'), { name: 'AbortError' });
  await assert.rejects(createLocalSpeechInspector({ env: ctx.env, execute: async () => { throw cancelled; } })({ file: ctx.file, durationSeconds: 120 }), error => error === cancelled);
});

test('Python adapters probe/decode the full bounded duration and invoke only mocked offline CPU models', t => {
  const ctx = fixture(t);
  const source = fileURLToPath(new URL('../../../scripts/inspect-source-speech.py', import.meta.url));
  const faster = fileURLToPath(new URL('../../../scripts/inspect-faster-speech.py', import.meta.url));
  const program = String.raw`
import contextlib, importlib.util, io, json, os, sys, types
from dataclasses import dataclass
from unittest.mock import Mock, patch

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

source = load('source', sys.argv[1])
faster = load('faster', sys.argv[2])
media, weights, model_dir = sys.argv[3:6]
metadata = {'format': {'duration': '120', 'start_time': '0'}, 'streams': [
    {'codec_type': 'audio', 'duration': '120', 'start_time': '0', 'sample_rate': '48000'},
    {'codec_type': 'video', 'duration': '120', 'start_time': '0'}]}
pcm = bytes(120 * 16000 * 4)

def decode_run(args, **kwargs):
    if args[0] == 'ffprobe':
        return types.SimpleNamespace(stdout=json.dumps(metadata).encode())
    assert args[0] == 'ffmpeg'
    assert args[args.index('-t') + 1] == '121', 'old 60-second truncation returned'
    return types.SimpleNamespace(stdout=pcm)

with patch.object(source.subprocess, 'run', side_effect=decode_run):
    decoded, coverage = source.decode_media(media, 120)
    assert len(decoded) == len(pcm) and coverage['endSeconds'] == 120 and coverage['complete']
    for duration in [121, 0, float('nan')]:
        try: source.decode_media(media, duration)
        except ValueError: pass
        else: raise AssertionError('invalid duration accepted')
    metadata['format']['duration'] = '121'
    try: source.decode_media(media, 120)
    except ValueError: pass
    else: raise AssertionError('actual overlong media accepted')
    metadata['format']['duration'] = '120'
    for entry in [metadata['format'], *metadata['streams']]:
        for start in ['0.001', '-0.001', 'N/A', 'nan']:
            entry['start_time'] = start
            try: source.decode_media(media, 120)
            except ValueError as error: assert 'start_time' in str(error)
            else: raise AssertionError('unsupported timestamp origin accepted')
        entry['start_time'] = str(1 / 48000)
        source.decode_media(media, 120)
        entry['start_time'] = str(1.01 / 48000)
        try: source.decode_media(media, 120)
        except ValueError: pass
        else: raise AssertionError('greater than one native sample accepted')
        del entry['start_time']
        try: source.decode_media(media, 120)
        except ValueError: pass
        else: raise AssertionError('unknown timestamp origin accepted')
        entry['start_time'] = '0'
    pcm = bytes(60 * 16000 * 4)
    try: source.decode_media(media, 120)
    except ValueError: pass
    else: raise AssertionError('partial decode accepted')
    pcm = bytes(121 * 16000 * 4)
    try: source.decode_media(media, 120)
    except ValueError: pass
    else: raise AssertionError('overlong decode accepted')
    pcm = bytes(120 * 16000 * 4)

word = {'start': 118.0, 'end': 119.0, 'word': 'late', 'probability': 0.7}
segment = {'text': 'late speech', 'words': [word], 'avg_logprob': -0.2, 'no_speech_prob': 0.01, 'compression_ratio': 1.0}
array = Mock()
array.copy.return_value = array
numpy = types.SimpleNamespace(frombuffer=Mock(return_value=array), float32='float32')
torch = types.SimpleNamespace(set_num_threads=Mock(), set_num_interop_threads=Mock())
model = types.SimpleNamespace(transcribe=Mock(return_value={'segments': [segment]}))
whisper = types.SimpleNamespace(__version__='test', load_model=Mock(return_value=model))
with patch.dict(sys.modules, {'numpy': numpy, 'torch': torch, 'whisper': whisper}), patch.object(source.subprocess, 'run', side_effect=decode_run), patch.object(sys, 'argv', ['script', '--weights', weights, '--media', media, '--duration-seconds', '120']):
    output = io.StringIO()
    with contextlib.redirect_stdout(output): source.main()
    result = json.loads(output.getvalue())
    assert result['coverage']['endSeconds'] == 120 and result['uncertaintySeconds'] == 0.1
    assert result['segments'][0]['words'][0] == word and len(result['provider']) <= 120
    assert result['analyzer'] == {'vadFilter': False, 'conditionOnPreviousText': False, 'wordTimestamps': True, 'downmix': 'mono', 'timestampCoordinates': 'original_media'}
    whisper.load_model.assert_called_once_with(weights, device='cpu')
    torch.set_num_threads.assert_called_once_with(2)
    assert model.transcribe.call_args.kwargs['initial_prompt'] is None
    assert model.transcribe.call_args.kwargs['condition_on_previous_text'] is False

consumed = []
def segments():
    consumed.append(True)
    yield types.SimpleNamespace(**{**segment, 'words': [types.SimpleNamespace(**word)]})
@dataclass
class VadOptions:
    min_silence_duration_ms: int = 2000
    max_speech_duration_s: float = float('inf')
info = types.SimpleNamespace(vad_options=VadOptions(), duration_after_vad=120)
fast_model = types.SimpleNamespace(transcribe=Mock(return_value=(segments(), info)))
fast_module = types.SimpleNamespace(__version__='test', WhisperModel=Mock(return_value=fast_model))
with patch.dict(sys.modules, {'numpy': numpy, 'faster_whisper': fast_module}), patch.object(source.subprocess, 'run', side_effect=decode_run), patch.object(sys, 'argv', ['script', '--model-dir', model_dir, '--media', media, '--duration-seconds', '120']):
    output = io.StringIO()
    with contextlib.redirect_stdout(output): faster.main()
    result = json.loads(output.getvalue())
    assert consumed and result['segments'][0]['start'] == 118
    assert len(result['provider']) <= 120 and result['coverage']['complete']
    fast_module.WhisperModel.assert_called_once_with(model_dir, device='cpu', compute_type='int8', cpu_threads=2, num_workers=1, local_files_only=True)
    assert fast_model.transcribe.call_args.kwargs['initial_prompt'] is None
    assert fast_model.transcribe.call_args.kwargs['vad_filter'] is False
    assert result['analyzer']['vadFilter'] is False
    assert os.environ['HF_HUB_OFFLINE'] == '1' and os.environ['TRANSFORMERS_OFFLINE'] == '1'
    assert os.environ['CUDA_VISIBLE_DEVICES'] == '' and os.environ['OMP_NUM_THREADS'] == '2'
fast_model.transcribe.reset_mock()
fast_model.transcribe.return_value = (segments(), info)
with patch.dict(sys.modules, {'numpy': numpy, 'faster_whisper': fast_module}), patch.object(source.subprocess, 'run', side_effect=decode_run), patch.object(sys, 'argv', ['script', '--model-dir', model_dir, '--media', media, '--duration-seconds', '120', '--vad-filter', 'true']):
    output = io.StringIO()
    with contextlib.redirect_stdout(output): faster.main()
    result = json.loads(output.getvalue())
    assert fast_model.transcribe.call_args.kwargs['vad_filter'] is True
    assert result['analyzer'] == {'vadFilter': True, 'conditionOnPreviousText': False, 'wordTimestamps': True, 'downmix': 'mono', 'timestampCoordinates': 'original_media'}
    assert result['analyzerSettings']['vadParameters']['min_silence_duration_ms'] == 2000
    assert result['analyzerSettings']['vadParameters']['max_speech_duration_s'] == 'unbounded'
    assert result['segments'][0]['start'] == 118, 'library-restored timestamps must not shift again'
    assert result['segments'][0]['words'][0]['start'] == 118
with patch.object(sys, 'argv', ['script', '--model-dir', model_dir, '--media', media, '--duration-seconds', '120', '--vad-filter', 'yes']), contextlib.redirect_stderr(io.StringIO()):
    try: faster.main()
    except SystemExit as error: assert error.code == 2
    else: raise AssertionError('invalid script VAD accepted')
print('mocked Python adapter checks passed')
`;
  assert.match(execFileSync('python3', ['-B', '-c', program, source, faster, ctx.file, ctx.weights, ctx.model], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  }), /mocked Python adapter checks passed/);
});
