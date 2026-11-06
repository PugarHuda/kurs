// Composites the Playwright recording (docs/video/raw.webm) with the Edge TTS narration and
// word-timed subtitles. Scene starts come from the recorder (scenes.json), word timings from tts.py.
import React from "react";
import { AbsoluteFill, Audio, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import scenes from "../../docs/video/scenes.json";
import durations from "../../docs/video/durations.json";
import captions from "../../docs/video/captions.json";
import vo from "../../docs/video/vo.json";

export const FPS = 30;
const CUT = 2.2; // blank lead-in before the first page paints
const sc = scenes as Record<string, number>;
const du = durations as Record<string, number>;
const keys = Object.keys(sc).sort((a, b) => sc[a] - sc[b]);
const last = keys[keys.length - 1];
export const totalSeconds = sc[last] + du[last] + 1.5 - CUT;

type W = { start: number; end: number; text: string };
/** Edge TTS boundaries drop punctuation ("ink!" -> "ink"); put the script's own words back when they line up. */
function words(key: string): W[] {
  const b = (captions as Record<string, [number, number, string][]>)[key];
  const script = vo.segments.find((s) => s.key === key)!.text.split(/\s+/);
  const same = script.length === b.length;
  return b.map(([start, end, t], i) => ({ start, end, text: same ? script[i] : t }));
}
/** Caption lines: at most 8 words, broken after a sentence or clause. */
function lines(ws: W[]): W[][] {
  const out: W[][] = [];
  let cur: W[] = [];
  for (const w of ws) {
    cur.push(w);
    if (cur.length >= 8 || (cur.length >= 3 && /[.,:;!?]$/.test(w.text))) (out.push(cur), (cur = []));
  }
  if (cur.length) out.push(cur);
  return out;
}

const Caption: React.FC<{ ws: W[][] }> = ({ ws }) => {
  const t = useCurrentFrame() / FPS;
  // a line stays up until the next one starts, so the text never flickers between phrases
  const i = ws.findIndex((l, j) => t >= l[0].start && t < (ws[j + 1]?.[0].start ?? l[l.length - 1].end + 0.6));
  if (i < 0) return null;
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 46 }}>
      <div style={{ background: "rgba(19,35,58,0.88)", color: "#fff", font: "700 38px/1.3 Archivo, Arial, sans-serif", padding: "12px 26px", borderRadius: 12, maxWidth: 1380, textAlign: "center", boxShadow: "0 6px 24px rgba(0,0,0,.25)" }}>
        {ws[i].map((w, k) => (
          <span key={k} style={{ color: t >= w.start ? "#ffb000" : "#fff" }}>
            {w.text}{" "}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  );
};

export const KursDemo: React.FC = () => (
  <AbsoluteFill style={{ background: "#e8efe6" }}>
    <OffthreadVideo src={staticFile("raw.webm")} startFrom={Math.round(CUT * FPS)} muted />
    {keys.map((k) => (
      <Sequence key={k} from={Math.round((sc[k] - CUT) * FPS)} durationInFrames={Math.ceil((du[k] + 1) * FPS)}>
        <Audio src={staticFile(`vo_${k}.mp3`)} />
        <Caption ws={lines(words(k))} />
      </Sequence>
    ))}
  </AbsoluteFill>
);
