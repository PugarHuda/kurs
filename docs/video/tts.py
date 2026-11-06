"""Narration + word timings for the subtitles. usage (from docs/video): python tts.py
writes vo_<key>.mp3, durations.json and captions.json ({key: [[startSec, endSec, word], ...]})."""
import asyncio, json, subprocess
import edge_tts

vo = json.load(open("vo.json"))

async def one(seg):
    c = edge_tts.Communicate(seg["text"], vo["voice"], rate=vo["rate"], boundary="WordBoundary")
    words = []
    with open(f"vo_{seg['key']}.mp3", "wb") as f:
        async for ch in c.stream():
            if ch["type"] == "audio":
                f.write(ch["data"])
            elif ch["type"] == "WordBoundary":  # offsets are in 100 ns ticks
                words.append([ch["offset"] / 1e7, (ch["offset"] + ch["duration"]) / 1e7, ch["text"]])
    return seg["key"], words

async def main():
    res = await asyncio.gather(*(one(s) for s in vo["segments"]))
    caps = dict(res)
    dur = {}
    for k in caps:
        p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f"vo_{k}.mp3"], capture_output=True, text=True)
        dur[k] = round(float(p.stdout), 2)
    json.dump(caps, open("captions.json", "w"))
    json.dump(dur, open("durations.json", "w"), indent=1)
    print(dur)

asyncio.run(main())
