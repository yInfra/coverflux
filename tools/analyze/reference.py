"""Dev-only: reference beats/downbeats with Beat This! (CPJKU) to measure the in-extension JS beat engine.
Usage: tools/analyze/.venv/Scripts/python tools/analyze/reference.py <audio files...>
Writes test/audio-ref/<name>.beats.json  (not shipped to users)."""
import json, os, subprocess, sys, tempfile
from beat_this.inference import File2Beats

f2b = File2Beats(checkpoint_path="final0", device="cpu", dbn=False)
out_dir = os.path.join(os.path.dirname(__file__), "..", "..", "test", "audio-ref")
os.makedirs(out_dir, exist_ok=True)
for path in sys.argv[1:]:
    with tempfile.TemporaryDirectory() as td:
        wav = os.path.join(td, "a.wav")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-ac", "1", "-ar", "22050", wav], check=True)
        beats, downbeats = f2b(wav)
    name = os.path.splitext(os.path.basename(path))[0]
    with open(os.path.join(out_dir, name + ".beats.json"), "w", encoding="utf-8") as f:
        json.dump({"file": os.path.basename(path), "beats": [round(float(b), 4) for b in beats],
                   "downbeats": [round(float(b), 4) for b in downbeats]}, f)
    ib = sorted(b2 - b1 for b1, b2 in zip(beats, beats[1:]))
    print(f"{name}: {len(beats)} beats, {len(downbeats)} downbeats, median {60 / ib[len(ib) // 2]:.1f} BPM")
