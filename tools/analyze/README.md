# Reference beats (development only)

Measures the built-in JS beat engine (`src/beat-engine.js`) against [Beat This!](https://github.com/CPJKU/beat_this) (CPJKU, ISMIR 2024), a neural beat/downbeat tracker. **Not shipped** – Coverflux itself needs no Python.

```bash
python -m venv tools/analyze/.venv
tools/analyze/.venv/bin/python -m pip install torch --index-url https://download.pytorch.org/whl/cpu   # Windows: .venv/Scripts/python
tools/analyze/.venv/bin/python -m pip install numpy soxr einops rotary-embedding-torch soundfile https://github.com/CPJKU/beat_this/archive/main.zip
tools/analyze/.venv/bin/python tools/analyze/reference.py song1.mp3 song2.mp3   # -> test/audio-ref/*.beats.json (git-ignored)
node tools/beat-eval.mjs song1.mp3 song2.mp3                                       # F-measure, tempo, downbeats
```

Both need `ffmpeg` on the PATH. If the checkpoint download fails on an expired TLS certificate of the JKU server, download `final0.ckpt` manually to `~/.cache/torch/hub/checkpoints/beat_this-final0.ckpt`.
