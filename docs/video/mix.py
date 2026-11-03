"""Places each narration clip at its scene's recorded start and encodes the MP4.
usage (from docs/video): python mix.py -> kurs-demo.mp4"""
import json, subprocess
sc = json.load(open("scenes.json")); du = json.load(open("durations.json"))
CUT = 2.2  # blank lead-in before the first page paints
keys = sorted(sc, key=lambda k: sc[k])
end = sc[keys[-1]] + du[keys[-1]] + 1.5 - CUT
inputs = ["-ss", str(CUT), "-i", "raw.webm"]
filters = []
for i, k in enumerate(keys, start=1):
    inputs += ["-i", f"vo_{k}.mp3"]
    ms = int((sc[k] - CUT) * 1000)
    filters.append(f"[{i}:a]adelay={ms}|{ms},apad[a{i}]")
mix = "".join(f"[a{i}]" for i in range(1, len(keys) + 1)) + f"amix=inputs={len(keys)}:normalize=0,atrim=0:{end:.2f}[aout]"
cmd = ["ffmpeg", "-y", *inputs, "-filter_complex", ";".join(filters + [mix]), "-map", "0:v", "-map", "[aout]",
       "-t", f"{end:.2f}", "-c:v", "libx264", "-preset", "slow", "-crf", "22", "-pix_fmt", "yuv420p",
       "-vf", "scale=1600:900,fps=30", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "kurs-demo.mp4"]
r = subprocess.run(cmd, capture_output=True, text=True)
print("ok" if r.returncode == 0 else r.stderr[-500:])
