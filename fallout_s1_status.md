# Fallout S1 capture — season tracker

Started 2026-10-07 02:16 JST. Target: all S1 episodes, English audio, no
subtitles, ad-free, per-episode files on `/media/sergio/My Passport`.

## Series facts (Prime JP account)

- Series ASIN (S1): `0HAQAA7JM43QWX0H6GUD3IOF70`
- S1E1 ASIN: `0H65SELFYQNNW2SNLDGEOSFZXJ`
- **Audio**: 26-language lineup; player selected **en-US 128k** (`audio_en-US_3`)
  on this account — gate verified per episode with `player_audio_check.js`.
  (Contrast: The Boys on the same account defaulted to ja-JP.)
- **Subtitles**: off by default (native CC button state + textTracks, verified)
- **Quality**: max **540p** (8 video renditions, 150k–3001k), **2.37:1
  letterbox baked into the frames** (measured on a live capture frame) —
  Prime JP delivery, not a display bug.
- **Episode d drift**: S1E1 refined d 4545 → 4641 mid-stream (Prime updates
  `<video>.duration` as it learns the full stream length; stopper reads it
  live, so end-detection stays correct).
- Naming convention: `fallout_s1e<N>_540p_24fps.mp4`
- Per-episode loop: `start_episode.sh <series-url> <N>` (gate inside) →
  `arm_episode.sh <N> <d>` → on stop: `rescan_bright.py --grab` → confirm/trim →
  re-scan → `analyze_rec.py` → deliverable → commit.

## Episodes

| Ep | raw file | d (s) | gate | ads found | final file | commit |
|----|----------|-------|------|-----------|------------|--------|
| 1  | `rec_20261007_021642` | 4641 (refined) | en-us ✅ subs off ✅ | pending | pending | — |
