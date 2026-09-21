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
  const [stats, setStats] = useState(
    JSON.parse(localStorage.getItem("stats") || '{"xp":0,"days":[]}')
  );
  const [status, setStatus] = useState("");
  const [recording, setRecording] = useState(false);
  const [screen, setScreen] = useState(false);
  const [n, setN] = useState(0);
  const video = useRef();
  const frames = useRef([]);
  const timer = useRef();

  async function load() {
    const all = await store("readonly", (s) => s.getAll());
    setVideos(
      all.reverse().map((v) => ({ ...v, url: URL.createObjectURL(v.blob) }))
    );
  }

  useEffect(() => {
    load();
    navigator.storage?.persist?.(); // asks the browser not to clear your videos
  }, []);

  async function start() {
    const md = navigator.mediaDevices;
    const stream = await (screen
      ? md.getDisplayMedia({ video: true })
      : md.getUserMedia({ video: true }));
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
        s.put({ id: Date.now(), title: `${new Date().toLocaleString()} • ${mins} min`, blob })
      );
      const s = { xp: stats.xp + mins * 10, days: [...new Set([...stats.days, day(new Date())])] };
      setStats(s);
      localStorage.setItem("stats", JSON.stringify(s));
      setStatus(`Saved! +${mins * 10} XP gained ✨`);
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

  const progressPercent = Math.min(100, Math.max(0, ((stats.xp - lo) / (hi - lo)) * 100));

  return (
    <main>
      <style>{css}</style>

      <header className="brand-header">
        <h1>StudyLapse</h1>
        <p className="subtitle">Focus, record, and build your study streak.</p>
      </header>

      {/* Gamified Stats Dashboard */}
      <section className="stats-card">
        <div className="stats-row">
          <div className="stat-item highlight">
            <span className="stat-label">Level</span>
            <span className="stat-value">{level}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Total XP</span>
            <span className="stat-value">{stats.xp.toLocaleString()}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Current Streak</span>
            <span className="stat-value">{streak} <small>days</small></span>
          </div>
        </div>

        <div className="progress-container">
          <div className="progress-header">
            <span>Level {level} Progress</span>
            <span>{stats.xp - lo} / {hi - lo} XP</span>
          </div>
          <div className="bar">
            <i style={{ width: `${progressPercent}%` }} />
          </div>
        </div>
      </section>

      {/* Main Studio Control */}
      <section className="studio-card">
        <div className="video-container" style={{ display: recording ? "block" : "none" }}>
          <div className="live-badge">
            <span className="pulse-dot"></span> LIVE RECORDING
          </div>
          <video ref={video} muted playsInline />
        </div>

        <div className="controls">
          {recording ? (
            <div className="recording-status">
              <div className="time-counter">
                <span>{Math.round((n * SEC) / 60)}</span> min studied
              </div>
              <button className="btn btn-primary btn-stop" onClick={stop}>
                Finish & Save Session
              </button>
            </div>
          ) : (
            <div className="setup-status">
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={screen}
                  onChange={(e) => setScreen(e.target.checked)}
                />
                <span className="toggle-switch"></span>
                Record screen instead of camera
              </label>

              <button className="btn btn-primary btn-start" onClick={start}>
                Start Studying
              </button>
            </div>
          )}
        </div>

        {status && <div className="status-toast">{status}</div>}
      </section>

      {/* Timelapses Section */}
      <section className="timelapses-section">
        <h2>Your Timelapses</h2>
        {videos.length === 0 ? (
          <div className="empty-state">
            <p>No study sessions recorded yet.</p>
            <small>Click "Start Studying" above to produce your first timelapse.</small>
          </div>
        ) : (
          <div className="grid">
            {videos.map((v) => (
              <div key={v.id} className="video-card">
                <div className="video-wrapper">
                  <video src={v.url} controls />
                </div>
                <div className="card-body">
                  <span className="card-title">{v.title}</span>
                  <div className="card-actions">
                    <a className="btn btn-sm btn-outline" href={v.url} download={`studylapse-${v.id}.webm`}>
                      Download
                    </a>
                    <button className="btn btn-sm btn-danger" onClick={() => del(v)}>
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

const css = `
@import url("https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Inter:wght@400;500;600&display=swap");

:root {
  --bg: #0b0c0e;
  --panel: #14161b;
  --panel-border: #23262f;
  --line: #2a2d36;
  --text: #f0efe9;
  --muted: #8e919a;
  --accent: #d9c38f;
  --accent-hover: #e8d7ab;
  --accent-glow: rgba(217, 195, 143, 0.15);
  --danger: #e56b6b;
  --danger-glow: rgba(229, 107, 107, 0.15);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 400 15px/1.6 Inter, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}

main {
  max-width: 820px;
  margin: 0 auto;
  padding: 64px 24px;
}

.brand-header {
  margin-bottom: 32px;
}

h1 {
  font: 600 48px/1.1 "Cormorant Garamond", Georgia, serif;
  letter-spacing: -0.01em;
  margin: 0 0 6px 0;
  color: var(--text);
}

.subtitle {
  margin: 0;
  color: var(--muted);
  font-size: 15px;
}

h2 {
  font: 500 28px "Cormorant Garamond", Georgia, serif;
  margin: 0 0 20px;
}

/* Stats Dashboard Card */
.stats-card {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 16px;
  padding: 24px;
  margin-bottom: 24px;
}

.stats-row {
  display: flex;
  gap: 32px;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--line);
}

.stat-item {
  display: flex;
  flex-direction: column;
}

.stat-label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  margin-bottom: 4px;
}

.stat-value {
  font: 600 28px/1 "Cormorant Garamond", Georgia, serif;
  color: var(--text);
}

.stat-item.highlight .stat-value {
  color: var(--accent);
  font-size: 32px;
}

.stat-value small {
  font-size: 14px;
  color: var(--muted);
  font-family: Inter, sans-serif;
}

.progress-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.progress-header {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--muted);
}

.bar {
  height: 6px;
  background: var(--line);
  border-radius: 999px;
  overflow: hidden;
}

.bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--accent) 0%, #ede0be 100%);
  border-radius: 999px;
  transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
}

/* Studio & Recording Card */
.studio-card {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 16px;
  padding: 24px;
  margin-bottom: 48px;
}

.video-container {
  position: relative;
  margin-bottom: 20px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--line);
  background: #000;
}

.video-container video {
  display: block;
  width: 100%;
  aspect-ratio: 16/9;
  object-fit: cover;
}

.live-badge {
  position: absolute;
  top: 16px;
  left: 16px;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  padding: 6px 12px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  gap: 8px;
  letter-spacing: 0.05em;
}

.pulse-dot {
  width: 8px;
  height: 8px;
  background: #e56b6b;
  border-radius: 50%;
  box-shadow: 0 0 8px #e56b6b;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
  100% { opacity: 1; transform: scale(1); }
}

.controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.setup-status, .recording-status {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.time-counter {
  font-size: 16px;
  color: var(--muted);
}

.time-counter span {
  font-weight: 600;
  color: var(--text);
  font-size: 20px;
}

/* Custom Toggle Switch */
.toggle-label {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  color: var(--muted);
  font-size: 14px;
  user-select: none;
}

.toggle-label input {
  display: none;
}

.toggle-switch {
  width: 38px;
  height: 22px;
  background: var(--line);
  border-radius: 999px;
  position: relative;
  transition: background 0.2s;
}

.toggle-switch::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  background: var(--muted);
  border-radius: 50%;
  transition: transform 0.2s, background 0.2s;
}

.toggle-label input:checked + .toggle-switch {
  background: var(--accent);
}

.toggle-label input:checked + .toggle-switch::after {
  transform: translateX(16px);
  background: var(--bg);
}

/* Buttons */
.btn {
  font: 500 14px Inter, system-ui, sans-serif;
  padding: 10px 22px;
  border-radius: 999px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.2s ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-decoration: none;
}

.btn-primary {
  background: var(--accent);
  color: var(--bg);
  font-weight: 600;
}

.btn-primary:hover {
  background: var(--accent-hover);
  box-shadow: 0 0 16px var(--accent-glow);
}

.btn-stop {
  background: transparent;
  border-color: var(--danger);
  color: var(--danger);
}

.btn-stop:hover {
  background: var(--danger);
  color: #fff;
  box-shadow: 0 0 16px var(--danger-glow);
}

.btn-sm {
  padding: 6px 14px;
  font-size: 12px;
}

.btn-outline {
  border-color: var(--line);
  color: var(--text);
  background: transparent;
}

.btn-outline:hover {
  border-color: var(--muted);
  background: rgba(255, 255, 255, 0.05);
}

.btn-danger {
  border-color: transparent;
  color: var(--muted);
  background: transparent;
}

.btn-danger:hover {
  color: var(--danger);
  background: var(--danger-glow);
}

.status-toast {
  margin-top: 16px;
  padding: 10px 14px;
  background: rgba(217, 195, 143, 0.08);
  border: 1px solid var(--accent-glow);
  border-radius: 8px;
  color: var(--accent);
  font-size: 13px;
}

/* Timelapses Section */
.timelapses-section {
  border-top: 1px solid var(--line);
  padding-top: 40px;
}

.empty-state {
  text-align: center;
  padding: 48px 24px;
  background: var(--panel);
  border: 1px dashed var(--line);
  border-radius: 16px;
  color: var(--muted);
}

.empty-state p {
  margin: 0 0 4px;
  color: var(--text);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 20px;
}

.video-card {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.video-wrapper video {
  display: block;
  width: 100%;
  aspect-ratio: 16/9;
  background: #000;
  object-fit: cover;
}

.card-body {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  justify-content: space-between;
}

.card-title {
  font-size: 12px;
  color: var(--muted);
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
`;