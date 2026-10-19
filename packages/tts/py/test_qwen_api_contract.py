"""Exercise the documented upstream batched API contracts without model downloads."""
import sys
from types import SimpleNamespace
import numpy as np
import qwen


def test_aligner_uses_qwen_asr_tuple_audio_and_start_time(monkeypatch):
    calls, loads = [], []
    class Model:
        @classmethod
        def from_pretrained(cls, model, **kwargs):
            loads.append((model, kwargs))
            return cls()
        def align(self, *, audio, text, language):
            calls.append((audio, text, language))
            return [[SimpleNamespace(text="Hello", start_time=0.1, end_time=0.5)]]
    monkeypatch.setitem(sys.modules, "qwen_asr", SimpleNamespace(Qwen3ForcedAligner=Model))
    monkeypatch.setattr(qwen, "model_options", lambda: {"device_map": "cuda:0"})
    adapter = qwen.Qwen3Aligner()
    samples = np.zeros(24000)
    for _ in range(2):
        assert adapter.align(samples, 24000, "Hello", "English") == [{"text": "Hello", "start_ts": 0.1, "end_ts": 0.5}]
    assert len(loads) == 1
    assert calls[0][0][1] == 24000
    assert calls[0][0][0] is samples


def test_asr_unwraps_batch_and_reuses_loaded_model(monkeypatch):
    loads = []
    class Model:
        @classmethod
        def from_pretrained(cls, model, **kwargs):
            loads.append(model)
            return cls()
        def transcribe(self, *, audio, language):
            assert audio[1] == 24000
            return [SimpleNamespace(text="Hello world")]
    monkeypatch.setitem(sys.modules, "qwen_asr", SimpleNamespace(Qwen3ASRModel=Model))
    monkeypatch.setattr(qwen, "model_options", lambda: {})
    adapter = qwen.Qwen3Asr()
    for _ in range(2):
        assert adapter.transcribe(np.zeros(24000), 24000, "English") == "Hello world"
    assert len(loads) == 1
