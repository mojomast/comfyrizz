"""Production boundaries: blend math, caption continuity, and real Qwen API routing."""
import types

import numpy as np
import pytest

import qwen
from narrate_qwen import narrate_qwen
from synth import resolve_kokoro_style
from test_qwen_engine import FakeTts, package


def test_blend_uses_normalized_style_vectors_and_rejects_cross_language():
    class Voices:
        def get_voice_style(self, name):
            return {'am_michael': np.ones((3, 4)), 'am_fenrir': np.zeros((3, 4))}[name]
    cfg = {'blend': [{'voice': 'am_michael', 'weight': .7}, {'voice': 'am_fenrir', 'weight': .3}]}
    assert np.allclose(resolve_kokoro_style(Voices(), cfg, 'am_michael'), .7)
    cfg['blend'][0]['weight'] = float('nan')
    with pytest.raises(ValueError, match='finite'):
        resolve_kokoro_style(Voices(), cfg, 'am_michael')
    cfg['blend'][0] = {'voice': 'bf_emma', 'weight': .7}
    with pytest.raises(ValueError, match='language'):
        resolve_kokoro_style(Voices(), cfg, 'am_michael')


def test_customvoice_routes_to_custom_model_and_performance_api(monkeypatch, tmp_path):
    calls = []
    class Model:
        @classmethod
        def from_pretrained(cls, name, **kwargs):
            calls.append(('load', name))
            return cls()
        def generate_custom_voice(self, **kwargs):
            calls.append(('custom', kwargs))
            return [np.ones(24000, dtype=np.float32) * .1], 24000
        def generate_voice_clone(self, **kwargs):
            raise AssertionError('CustomVoice must not call Base cloning')
    monkeypatch.setattr(qwen, '_import_qwen_tts', lambda: types.SimpleNamespace(Qwen3TTSModel=Model))
    monkeypatch.setattr(qwen, 'model_options', lambda: {})
    monkeypatch.setattr(qwen.Qwen3Tts, '_seed', staticmethod(lambda seed: None))
    cfg = {'qwen_mode': 'custom', 'voice': 'Ryan', 'delivery': 'Warm and curious.', 'non_streaming': True}
    adapter = qwen.Qwen3Tts(cfg)
    monkeypatch.setattr(adapter, 'available', lambda: True)
    report = narrate_qwen(package([
        {'id': 's1', 'narration': 'Hello there.'},
        {'id': 's2', 'narration': 'A quieter ending.', 'narration_style': 'Quiet and thoughtful.'},
    ], **cfg), tmp_path, tts=adapter)
    assert calls[0] == ('load', qwen.CUSTOM_MODEL)
    assert [c[1]['instruct'] for c in calls[1:]] == ['Warm and curious.', 'Quiet and thoughtful.']
    assert all(c[1]['speaker'] == 'Ryan' and c[1]['non_streaming_mode'] is True for c in calls[1:])
    assert report['model'] == qwen.CUSTOM_MODEL
    assert report['voiceSettings']['qwen_mode'] == 'custom'
    assert not (tmp_path / 'voice-reference.wav').exists()


def test_base_fulltext_reaches_clone_without_delivery_kwarg(monkeypatch):
    calls = []
    class Base:
        def generate_voice_clone(self, **kwargs):
            calls.append(kwargs)
            return [np.zeros(24000, dtype=np.float32)], 24000
    adapter = qwen.Qwen3Tts({'non_streaming': True})
    adapter._base = Base()
    monkeypatch.setattr(qwen, '_import_qwen_tts', lambda: types.SimpleNamespace(Qwen3TTSModel=object))
    monkeypatch.setattr(adapter, '_seed', lambda seed: None)
    adapter.synthesize('Hello.', prompt={'voice_clone_prompt': 'reference'}, instruct='Warm', lang='English', seed=1)
    assert calls[0]['non_streaming_mode'] is True
    assert calls[0]['voice_clone_prompt'] == 'reference'
    assert 'instruct' not in calls[0]


def test_design_reference_direction_and_transcript_are_used(tmp_path):
    adapter = FakeTts()
    narrate_qwen(package([{'id': 's1', 'narration': 'Hello.'}], reference_text='A new reference.', delivery='Warm and curious.'), tmp_path, tts=adapter)
    assert adapter.design_calls[0]['reference_line'] == 'A new reference.'
    assert adapter.design_calls[0]['persona'].endswith('Warm and curious.')


def test_qwen_does_not_silently_ignore_kokoro_speed(tmp_path):
    with pytest.raises(SystemExit, match='speed=1'):
        narrate_qwen(package([{'id': 's1', 'narration': 'Hello.'}], speed=.93), tmp_path, tts=FakeTts())
