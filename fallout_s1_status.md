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

## Season map (8 episodes — `grid_readonly.js` scrape, 2026-10-07 04:44)

| # | Title | ASIN |
|---|-------|------|
| 1 | The End | `0H65SELFYQNNW2SNLDGEOSFZXJ` |
| 2 | The Target | `0FJEDT2KQIEGTC61UU1IYRFZRB` |
| 3 | The Head | `0JBVSYWCTQLOQGTRNV4N670HH8` |
| 4 | The Ghouls | `0TBFWHTQWLSMFW67KBP9IC4UMU` |
| 5 | The Past | `0SHVDQZTABJKUJHNBCA8CAECKN` |
| 6 | The Trap | `0M1X60J5R6U69B3NLNFPUP3AWI` |
| 7 | The Radio | `0HKWUSAS9VXYJVCSLTTD3HSV3O` |
| 8 | The Beginning | `0MVNRZ7Q0BIUIV8E85JGJLA22T` |

## Episodes

| Ep | raw file | d (s) | gate | ads found | final file | commit |
|----|----------|-------|------|-----------|------------|--------|
| 1  | `rec_20261007_021642` (shared w/ E2) | ~4340 actual (d=4641 padded) | en-us ✅ subs off ✅ | head JP pre-roll 0–43 (Machida+SUT) | `fallout_s1e1_540p_24fps.mp4` 1.7G 71:27 ✅ | — |
| 2  | `rec_20261007_021642` (shared w/ E1) | ~3805 actual (d=4058 padded) | en-us ✅ subs off ✅ | SUPER DRY pre-roll + mid-roll SUT selfie + Diners Club @53:22 | `fallout_s1e2_540p_24fps.mp4` 1.6G 61:03 ✅ | — |
| 3  | `rec_20261007_053420` (3235 s) | ~3248 actual (d=3419/3533 padded) | en-us ✅ subs off ✅ | **no pre-roll**; 85 s mid-roll @34:38 (iPhone 18 Pro + store + WEAPONS + BIOHAZARD JP film ads, partly DARK = brightness-scan misses the dark halves) + 10 s tail JP ad after credits | `fallout_s1e3_540p_24fps.mp4` 1.5G 52:17 ✅ | — |

**d-padding finding (2026-10-07):** Prime's `<video>.duration` over-reports content
by ~4–7% (E1: d=4641 vs 4340 actual; E2: d=4058 vs 3805 actual). End-of-episode
detection must rely on the t-reset/element-swap signal (stopper does), NOT
t≥d−30 (which would fire minutes after the content is already gone… or never,
since t plateaus below d−30).

**Ads on this account/territory (Prime JP):** JP commercials spliced into the
stream — pre-rolls (Machida 救急, SUT 誕生, SUPER DRY — but E3 had NONE),
mid-rolls (SUT selfie, Diners Club ゴールド, iPhone 18 Pro, store ad), JP
film/TV promos with JP subtitles (WEAPONS, BIOHAZARD release cards), and a
JP ad in the tail slot after the credits (E3). Identifiable by QR tracking
codes (CS…) in corners, JP text/subtitles, bright commercial framing, product
shots. Ad placement VARIES per episode (pre-roll, mid-roll, tail — any
combination). Two scan blind spots: (1) ad placement varies, so the head
(first ~20 s) and tail (last ~30 s) must be checked with direct frame grabs,
not just the brightness scan; (2) ad blocks contain DARK stretches (the
brightness scan flags only the bright halves — E3's 85 s block looked like two
16 s windows), so probe the black gaps around/inside detected ad windows.
Fallout shows are full of genuinely bright scenes (desert/sky) — every bright
window must be visually confirmed (contact sheets of start+mid frames)
before trimming.
