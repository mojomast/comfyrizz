"""Cut planning for assembling generated shots into a film (Kyle, Nov 1 2026: chained cuts froze
and a noise played under the freeze).

Root causes found on the-keeper run11 assembly:
* Each 73-frame LTX plate (3.04 s) was padded to the narration length with a cloned last frame
  (``tpad=stop_mode=clone``), a 0.8-3.5 s freeze at the end of every shot. A chained shot then
  opens on that same frame (it was conditioned on it) plus LTX's near-static first frames, so the
  hold ran straight across the cut.
* Chatterbox takes end with low-level hum or a breath after the sentence. It played under the
  frozen tail, and the per-segment AAC concat left no fades at the joins.

The fix: trim a chained clip's head, retime (slow) a clip to cover its narration instead of
freezing it, cut each take at the end of its speech, fade every line, and mix the whole narration
as one track so no AAC segment boundary lands on a cut. Pure functions; ffmpeg runs elsewhere.
"""
from __future__ import annotations

from dataclasses import dataclass

CHAINED_HEAD_TRIM_S = 0.375  # 9 frames at 24 fps: the duplicated frame plus LTX's static start
MAX_RETIME = 2.0              # never slow a clip past half speed; pad only what is left over
LINE_FADE_IN_S = 0.015
LINE_FADE_OUT_S = 0.04
TAIL_RMS_RATIO = 0.35         # a trailing burst this much quieter than the speech is hum/breath
VOICED_RMS_RATIO = 0.06       # below this even a tonal, voice-band burst is room hum
MIN_BURST_S = 0.12            # bursts shorter than this are clicks, not words


@dataclass(frozen=True)
class ShotPlan:
    head_trim: float
    retime: float
    pad: float
    length: float


def plan_shot(clip_seconds: float, need_seconds: float, chained: bool, min_seconds: float = 0.0) -> ShotPlan:
    """How to fit one clip to the time its narration needs without freezing a frame."""
    head = CHAINED_HEAD_TRIM_S if chained and clip_seconds > CHAINED_HEAD_TRIM_S * 4 else 0.0
    usable = max(clip_seconds - head, 0.01)
    length = max(need_seconds, min_seconds, 0.0)
    if length <= usable:
        return ShotPlan(head, 1.0, 0.0, round(length if length > 0 else usable, 3))
    retime = min(length / usable, MAX_RETIME)
    pad = max(length - usable * retime, 0.0)
    return ShotPlan(head, round(retime, 4), round(pad, 3), round(length, 3))


def speech_end(segments: list[tuple]) -> float:
    """End of real speech in a take, from non-silent segments in order.

    Each segment is (start, end, rms) or (start, end, rms, flatness, voice_band): spectral
    flatness (0 tonal .. 1 noise) and the share of energy in 300-3400 Hz. A trailing segment much
    quieter than the loudest speech is cut as hum, hiss or breath unless it looks like quiet
    voiced speech (long, speech-like flatness 0.15-0.65 and mostly in the voice band; a very tonal
    burst, flatness near 0, is a whine or hum). Bursts too short to be a word (clicks)
    are always cut.
    """
    if not segments:
        return 0.0
    loud = max(segment[2] for segment in segments)
    end = segments[0][1]
    for segment in segments:
        start, stop, rms = segment[:3]
        length = stop - start
        if length < MIN_BURST_S:
            continue
        if rms >= loud * TAIL_RMS_RATIO:
            end = stop
            continue
        if len(segment) >= 5 and length >= 0.4 and rms >= loud * VOICED_RMS_RATIO and 0.15 <= segment[3] <= 0.65 and segment[4] >= 0.5:
            end = stop  # quiet but voiced: a soft word, not noise
    return round(end, 3)


def line_filter(duration: float) -> str:
    """Fades for one narration line, so it starts and stops without a click."""
    out_start = max(duration - LINE_FADE_OUT_S, 0.0)
    return f"atrim=0:{duration:.3f},afade=t=in:d={LINE_FADE_IN_S},afade=t=out:st={out_start:.3f}:d={LINE_FADE_OUT_S}"


def video_filter(plan: ShotPlan, fps: int = 24, size: str = "1920:1080") -> str:
    """trim the head, slow the clip, pad only the remainder (never more than a few frames)."""
    parts = [f"trim=start={plan.head_trim:.3f}", "setpts=PTS-STARTPTS"]
    if plan.retime > 1.0:
        # slowed with motion-compensated in-betweens: plain fps duplication judders every other frame
        parts += [f"setpts={plan.retime:.4f}*PTS", f"minterpolate=fps={fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1"]
    else:
        parts.append(f"fps={fps}")
    parts += [f"scale={size}", "setsar=1"]
    if plan.pad > 0:
        parts.append(f"tpad=stop_mode=clone:stop_duration={plan.pad:.3f}")
    parts.append(f"trim=duration={plan.length:.3f}")
    return ",".join(parts)
