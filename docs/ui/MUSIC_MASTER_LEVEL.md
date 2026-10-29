# Music Video master level

Music Video uses the existing authoritative master routing: a ready music audio
asset with a valid `audio.music.trim` or `audio.music.reactive` declaration is the
sole soundtrack. This is the same policy used by playback to suppress narration,
native video audio, ambience, and SFX. It is not inferred from a filename, title,
provider, or the upload origin of an ordinary music bed.

Full, incremental, local pipeline, and remote exports pass the effective package
to the common loudness finisher. For this master routing the finisher returns
`{ applied: false, reason: "preserve music master" }`, preserving the authored
level instead of applying the ordinary -16 LUFS mix normalization. The selected
source trim remains authoritative. Missing master gain/fades default to 0 dB and
zero seconds; explicitly authored gain/fades still apply. Master routing does not
loop or duck the song and does not mix a second narration track. Ordinary music
beds and narration mixes retain their existing fades, ducking, and loudness
normalization. An uploaded bed without master routing is still an ordinary mix.

No new package field or schema migration is required. Music Video adoption
already writes gain 0 dB, zero fades, loop false, duck false, and the source trim.
The render parity inspector uses the same finishing policy as production.

**Preserved level is not byte-identical audio.** MP4 exports encode audio as AAC;
lossy re-encoding, sample-rate conversion where necessary, and encoder padding
can introduce small sample differences and a short container-duration tail.
Compare decoded PCM gain/correlation and video frame count, not the WAV hash to
the MP4 audio stream. The original uploaded asset's SHA-256 remains unchanged.
