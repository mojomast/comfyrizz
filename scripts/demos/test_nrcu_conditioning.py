import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np
from nrcu_shot_conditioning import speech_prompt, write_conditioning
from nrcu_miniseries_dialogue import DIALOGUE, TIMING_FRAMES, SCENES


class ConditioningTest(unittest.TestCase):
    def test_exact_line_keeps_voice_and_natural_speed(self):
        calls = []
        class Voice:
            def create(self, text, **options):
                calls.append((text, options))
                return np.zeros(24000 * 3), 24000
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'shot.wav'
            speech, padded = write_conditioning(Voice(), {'preset': 'bm_george', 'language': 'en-gb', 'speed': .9}, 'Your free trial ends.', path)
            self.assertEqual(calls, [('Your free trial ends.', {'voice': 'bm_george', 'lang': 'en-gb', 'speed': .9})])
            self.assertEqual(speech, 3)
            self.assertAlmostEqual(padded, 3.35)
            with wave.open(str(path)) as wav:
                self.assertEqual(wav.getnframes(), 80400)
            with self.assertRaises(ValueError):
                write_conditioning(Voice(), {'preset': 'bm_george', 'language': 'en-gb', 'speed': .9}, 'Changed words', path)

    def test_deadline_uses_editorial_slot_not_longer_source(self):
        prompt = speech_prompt({'line': 'Good. I no subscribe.', 'speaker': 'don', 'seconds': 3, 'sourceSeconds': 5})
        self.assertIn('before 2.75 seconds', prompt)
        self.assertIn('Preserve the written broken English exactly', prompt)
        self.assertIn('Say exactly once: "Good. I no subscribe."', prompt)

    def test_miniseries_revision_retains_episode_target_and_covers_every_new_shot(self):
        self.assertEqual(sum(TIMING_FRAMES.values()) + 65 * 24, 240 * 24)
        coverage = [shot for scene in SCENES for shot in scene['shots']]
        self.assertEqual(len(set(coverage)), 48)
        self.assertEqual(set(coverage), set(TIMING_FRAMES))
        self.assertTrue(set(DIALOGUE) <= set(coverage))
        self.assertTrue(all(frame > 0 for frame in TIMING_FRAMES.values()))


if __name__ == '__main__':
    unittest.main()
