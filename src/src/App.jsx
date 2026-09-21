import { useState, useRef, useEffect } from "react";

const SEC = 5; // seconds between captured frames
const day = (d) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD, local time

// Tiny IndexedDB helper: videos are stored privately in this browser
const db = new Promise((res) => {
  const r = indexedDB.open("studylapse", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("v", { keyPath: "id" });
  r.onsuccess = () => res(r.result);
});
const store = async (mode, fn) => {
  const s = (await db).transaction("v", mode).objectStore("v");
  return new Promise((res) => {
    const r = fn(s);
    r.onsuccess = () => res(r.result);
  });
};

export default function App() {
  const [videos, setVideos] = useState([]);
  const [stats, setStats] = useState(JSON.parse(localStorage.getItem("stats") || '{"xp":0,"days":[]}'));
  const [status, setStatus] = useState("");
  const [recording, setRecording] = useState(false);
  const [screen, setScreen] = useState(false);
  const [n, setN] = useState(0);
  const video = useRef();
  const frames = useRef([]);
  const timer = useRef();

  async function load() {
    const all = await store("readonly", (s) => s.getAll());
    setVideos(all.reverse().map((v) => ({ ...v, url: URL.createObjectURL(v.blob) })));
  }
  useEffect(() => {
    load();
    navigator.storage?.persist?.(); // asks the browser not to clear your videos
  }, []);

  async function start() {
    const md = navigator.mediaDevices;
    const stream = await (screen ? md.getDisplayMedia({ video: true }) : md.getUserMedia({ video: true }));
    video.current.srcObject = stream;
    await video.current.play();
    frames.current = [];
    setN(0);
    const c = document.createElement("canvas");
    const grab = () => {
      c.width = video.current.videoWidth;
      c.height = video.current.videoHeight;
      c.getContext("2d").drawImage(video.current, 0, 0);
      c.toBlob((b) => frames.current.push(b), "image/jpeg", 0.7);
      setN((x) => x + 1);
    };
    grab();
    timer.current = setInterval(grab, SEC * 1000);
    setRecording(true);
  }

  // Replays the captured frames at 15 fps into a canvas and records that as a video
  async function render() {
    const first = await createImageBitmap(frames.current[0]);
    const c = document.createElement("canvas");
    c.width = first.width;
    c.height = first.height;
    const ctx = c.getContext("2d");
    const rec = new MediaRecorder(c.captureStream(15), { mimeType: "video/webm" });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((r) => (rec.onstop = r));
    rec.start();
    for (const f of frames.current) {
      ctx.drawImage(await createImageBitmap(f), 0, 0);
      await new Promise((r) => setTimeout(r, 67));
    }
    rec.stop();
    await done;
    return new Blob(chunks, { type: "video/webm" });
  }

  async function stop() {
    clearInterval(timer.current);
    video.current.srcObject.getTracks().forEach((t) => t.stop());
    setRecording(false);
    try {
      const mins = Math.max(1, Math.round((frames.current.length * SEC) / 60));
      setStatus("Building video... keep this tab in front.");
      const blob = await render();
      await store("readwrite", (s) =>
        s.put({ id: Date.now(), title: `${new Date().toLocaleString()} - ${mins} min`, blob })
      );
      const s = { xp: stats.xp + mins * 10, days: [...new Set([...stats.days, day(new Date())])] };
      setStats(s);
      localStorage.setItem("stats", JSON.stringify(s));
      setStatus(`Saved! +${mins * 10} XP`);
      load();
    } catch (e) {
      setStatus("Error: " + e.message);
    }
  }

  async function del(v) {
    if (!confirm("Delete this timelapse?")) return;
    await store("readwrite", (s) => s.delete(v.id));
    load();
  }

  const level = Math.floor(Math.sqrt(stats.xp / 100)) + 1;
  const [lo, hi] = [100 * (level - 1) ** 2, 100 * level ** 2];
  let streak = 0;
  const d = new Date();
  if (!stats.days.includes(day(d))) d.setDate(d.getDate() - 1);
  while (stats.days.includes(day(d))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }

  return (
    <main>
      <style>{css}</style>
      <h1>StudyLapse</h1>
      <section className="stats">
        <b>Level {level}</b>
        <span>{stats.xp} XP</span>
        <span>{streak}-day streak</span>
        <div className="bar">
          <i style={{ width: `${((stats.xp - lo) / (hi - lo)) * 100}%` }} />
        </div>
      </section>

      <video ref={video} muted playsInline style={{ display: recording ? "block" : "none" }} />
      {recording ? (
        <p>
          {Math.round((n * SEC) / 60)} min studied so far <button onClick={stop}>Finish and save</button>
        </p>
      ) : (
        <p>
          <label>
            <input type="checkbox" checked={screen} onChange={(e) => setScreen(e.target.checked)} /> Record screen
            instead of camera
          </label>{" "}
          <button onClick={start}>Start studying</button>
        </p>
      )}
      <p>{status}</p>

      <h2>Your timelapses</h2>
      {videos.length === 0 && <p>Nothing here yet. Start a session to make your first one.</p>}
      <div className="grid">
        {videos.map((v) => (
          <div key={v.id}>
            <video src={v.url} controls />
            <small>{v.title}</small> <a href={v.url} download={`studylapse-${v.id}.webm`}>Download</a>{" "}
            <button onClick={() => del(v)}>Delete</button>
          </div>
        ))}
      </div>
    </main>
  );
}

const css = `
@import url("https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Inter:wght@400;500&display=swap");
:root{--bg:#0e0f12;--panel:#16181d;--line:#2a2d35;--text:#ecebe6;--muted:#a4a6ad;--accent:#d9c38f}
body{margin:0;background:var(--bg);color:var(--text);font:400 16px/1.6 Inter,system-ui,sans-serif}
main{max-width:760px;margin:auto;padding:56px 24px}
h1{font:600 44px/1.1 "Cormorant Garamond",Georgia,serif;letter-spacing:.01em;margin:0 0 32px}
h2{font:500 26px "Cormorant Garamond",Georgia,serif;margin:48px 0 20px;padding-top:24px;border-top:1px solid var(--line)}
label,small{color:var(--muted)}
a{color:var(--accent);font-size:14px;margin:0 8px}
input{accent-color:var(--accent)}
button{font:500 14px Inter,system-ui,sans-serif;padding:8px 18px;border:1px solid var(--accent);background:transparent;color:var(--accent);border-radius:999px;cursor:pointer;transition:background .2s,color .2s}
button:hover{background:var(--accent);color:var(--bg)}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.stats{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 24px;margin-bottom:32px}
.stats b{font:600 34px "Cormorant Garamond",Georgia,serif;color:var(--accent)}
.stats span{color:var(--muted)}
.bar{flex-basis:100%;height:4px;margin-top:8px;background:var(--line);border-radius:4px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent);transition:width .6s}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:24px}
.grid>div{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}
.grid button{padding:4px 12px;border-color:var(--line);color:var(--muted)}
.grid button:hover{background:transparent;border-color:#e58b8b;color:#e58b8b}
video{display:block;width:100%;aspect-ratio:16/9;margin-bottom:10px;border-radius:6px;background:#000}
`;