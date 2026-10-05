# debug/ — superseded Prime playback experiments

Iterative CDP attempts from the "play from the beginning" work, kept for the
failure-mode record. The working flow is `../prime_final.js`.

| Script | What it tried | Why it was superseded |
|---|---|---|
| `prime_start.js` | fullscreen via `.dv-player-fullscreen` stage + seek 0 | class doesn't exist in the current player build |
| `prime_play.js` | click any "play" element + `video.play()` + fullscreen | exposed the hidden 0×0 media element; stage fullscreen failed |
| `prime_resume.js` | click the Resume control | greedy container match hit "Go ad free" → navigated to signup |
| `prime_go.js` | exact `<button>` text match | the control is a `<span>`, not a `<button>` |
| `prime_finish_fast.js` | fast finisher (v1/v2) | broken logger (arrow `arguments`) + ad-wait gave up 10 s too early |
