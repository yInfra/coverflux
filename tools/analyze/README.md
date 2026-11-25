# Referenz-Beats (nur Entwicklung)

Dieses Werkzeug misst, wie genau die eingebaute JavaScript-Beat-Engine (`src/beat-engine.js`) ist. Es vergleicht sie mit [Beat This!](https://github.com/CPJKU/beat_this) (CPJKU, ISMIR 2024), einem neuronalen Netz für Beats und Taktanfänge.

**Es wird nicht ausgeliefert.** Coverflux selbst braucht weder Python noch PyTorch.

```bash
python -m venv tools/analyze/.venv
tools/analyze/.venv/Scripts/python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
tools/analyze/.venv/Scripts/python -m pip install numpy soxr einops rotary-embedding-torch soundfile https://github.com/CPJKU/beat_this/archive/main.zip
tools/analyze/.venv/Scripts/python tools/analyze/reference.py song1.mp3 song2.mp3   # -> test/audio-ref/*.beats.json
node tools/beat-eval.mjs song1.mp3 song2.mp3                                           # F-Measure, Tempo, Taktanfänge
```

Unter macOS und Linux heißt der Pfad zur Python-Umgebung `.venv/bin/python`. Beide Werkzeuge brauchen `ffmpeg` im PATH.

Der Server der JKU hatte zeitweise ein abgelaufenes TLS-Zertifikat. In dem Fall lädst du den Checkpoint manuell nach `~/.cache/torch/hub/checkpoints/beat_this-final0.ckpt`.
