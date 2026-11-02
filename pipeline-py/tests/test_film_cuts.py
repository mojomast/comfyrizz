from comfyrizz_pipeline.film_cuts import CHAINED_HEAD_TRIM_S, line_filter, plan_shot, speech_end, video_filter


def test_short_narration_uses_the_clip_without_freezing():
    plan = plan_shot(3.04, 2.5, chained=False)
    assert plan.retime == 1.0 and plan.pad == 0.0 and plan.length == 2.5


def test_long_narration_slows_the_clip_instead_of_cloning_the_last_frame():
    plan = plan_shot(3.04, 4.5, chained=False)
    assert plan.pad == 0.0
    assert abs(plan.retime - 4.5 / 3.04) < 1e-3


def test_chained_clip_drops_its_duplicated_head():
    plan = plan_shot(3.04, 2.0, chained=True)
    assert plan.head_trim == CHAINED_HEAD_TRIM_S
    assert "trim=start=0.375" in video_filter(plan)


def test_retime_is_capped_and_only_the_remainder_is_padded():
    plan = plan_shot(3.04, 7.0, chained=False)
    assert plan.retime == 2.0 and abs(plan.pad - 0.92) < 1e-3


def test_speech_end_cuts_trailing_hum_and_clicks():
    # the-keeper s_a_s2 and s_a_s3 takes (silencedetect -40 dB, rms per burst)
    assert speech_end([(0, 1.63, 0.125), (2.04, 2.09, 0.127), (2.64, 4.03, 0.008)]) == 1.63
    assert speech_end([(0, 2.32, 0.124), (3.73, 4.61, 0.009), (5.03, 5.08, 0.004), (5.49, 5.99, 0.037)]) == 2.32
    # a loud word after a pause is kept
    assert speech_end([(0, 2.45, 0.124), (2.88, 3.29, 0.092)]) == 3.29


def test_every_line_fades_in_and_out():
    f = line_filter(2.0)
    assert "afade=t=in" in f and "afade=t=out:st=1.960" in f


def test_quiet_tails_are_cut_unless_they_look_like_soft_speech():
    # s_a_s3 (the-keeper): a -41 dBFS whine (flatness 0.05) and a low thump after the sentence
    assert speech_end([(0, 2.32, 0.124, 0.57, 0.56), (3.73, 4.61, 0.009, 0.054, 0.72), (5.49, 5.99, 0.037, 0.014, 0.11)]) == 2.32
    # a soft but speech-like phrase is kept
    assert speech_end([(0, 2.0, 0.12, 0.5, 0.6), (2.5, 3.2, 0.01, 0.4, 0.65)]) == 3.2
    # s_a_s2: 1.4 s of quiet broadband hiss after the sentence is cut
    assert speech_end([(0, 1.63, 0.125, 0.48, 0.55), (2.64, 4.03, 0.008, 0.72, 0.39)]) == 1.63


def test_room_hum_after_a_looped_take_is_cut():
    # s_a_d1 first reading, then -46 dB tonal hum
    assert speech_end([(0, 2.134, 0.149, 0.61, 0.31), (2.514, 2.535, 0.004, 0.13, 0.88), (2.953, 4.93, 0.005, 0.26, 0.65)]) == 2.134


def test_slowed_clips_are_motion_interpolated_not_frame_doubled():
    assert "minterpolate=fps=24" in video_filter(plan_shot(3.04, 4.5, chained=False))
    assert "minterpolate" not in video_filter(plan_shot(3.04, 2.0, chained=False))
