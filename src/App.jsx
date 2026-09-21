import { useState, useRef, useEffect } from "react";

const SEC = 5;
const MAX_VIDEO_SECONDS = 5 * 60;

const day = (d) => d.toLocaleDateString("en-CA");

// ============================================================
// IndexedDB
// ============================================================

const db = new Promise((res, rej) => {
  const r = indexedDB.open("studylapse", 2);

  r.onupgradeneeded = () => {
    const database = r.result;

    if (!database.objectStoreNames.contains("v")) {
      database.createObjectStore("v", { keyPath: "id" });
    }

    if (!database.objectStoreNames.contains("funVideos")) {
      database.createObjectStore("funVideos", { keyPath: "id" });
    }
  };

  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

const store = async (storeName, mode, fn) => {
  const database = await db;
  const transaction = database
    .transaction(storeName, mode)
    .objectStore(storeName);

  return new Promise((resolve, reject) => {
    const request = fn(transaction);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

// ============================================================
// Main App
// ============================================================

export default function App() {
  const [page, setPage] = useState("study");

  return (
    <>
      <style>{css}</style>

      <nav className="top-nav">
        <div className="nav-inner">
          <button
            className={`nav-logo ${page === "study" ? "active" : ""}`}
            onClick={() => setPage("study")}
          >
            StudyLapse
          </button>

          <div className="nav-links">
            <button
              className={page === "study" ? "nav-link active" : "nav-link"}
              onClick={() => setPage("study")}
            >
              Study
            </button>

            <button
              className={page === "fun" ? "nav-link active" : "nav-link"}
              onClick={() => setPage("fun")}
            >
              VideoFun
            </button>
          </div>
        </div>
      </nav>

      {page === "study" ? <StudyLapse /> : <VideoFun />}
    </>
  );
}

// ============================================================
// StudyLapse
// ============================================================

function StudyLapse() {
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
    const all = await store("v", "readonly", (s) => s.getAll());

    setVideos(
      all
        .reverse()
        .map((v) => ({
          ...v,
          url: URL.createObjectURL(v.blob),
        }))
    );
  }

  useEffect(() => {
    load();
    navigator.storage?.persist?.();

    return () => {
      clearInterval(timer.current);
    };
  }, []);

  async function start() {
    try {
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
        if (!video.current.videoWidth) return;

        c.width = video.current.videoWidth;
        c.height = video.current.videoHeight;

        c.getContext("2d").drawImage(
          video.current,
          0,
          0,
          c.width,
          c.height
        );

        c.toBlob(
          (b) => {
            if (b) frames.current.push(b);
          },
          "image/jpeg",
          0.7
        );

        setN((x) => x + 1);
      };

      grab();

      timer.current = setInterval(grab, SEC * 1000);

      setRecording(true);
    } catch (e) {
      setStatus("Could not start recording: " + e.message);
    }
  }

  async function render() {
    if (!frames.current.length) {
      throw new Error("No frames were captured.");
    }

    const first = await createImageBitmap(frames.current[0]);

    const c = document.createElement("canvas");

    c.width = first.width;
    c.height = first.height;

    const ctx = c.getContext("2d");

    const rec = new MediaRecorder(c.captureStream(15), {
      mimeType: "video/webm",
    });

    const chunks = [];

    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };

    const done = new Promise((resolve) => {
      rec.onstop = resolve;
    });

    rec.start();

    for (const f of frames.current) {
      const bitmap = await createImageBitmap(f);

      ctx.drawImage(bitmap, 0, 0);

      bitmap.close();

      await new Promise((r) => setTimeout(r, 67));
    }

    rec.stop();

    await done;

    return new Blob(chunks, {
      type: "video/webm",
    });
  }

  async function stop() {
    clearInterval(timer.current);

    if (video.current?.srcObject) {
      video.current.srcObject
        .getTracks()
        .forEach((t) => t.stop());

      video.current.srcObject = null;
    }

    setRecording(false);

    try {
      const mins = Math.max(
        1,
        Math.round((frames.current.length * SEC) / 60)
      );

      setStatus("Building video... keep this tab in front.");

      const blob = await render();

      await store("v", "readwrite", (s) =>
        s.put({
          id: Date.now(),
          title: `${new Date().toLocaleString()} • ${mins} min`,
          blob,
        })
      );

      const nextStats = {
        xp: stats.xp + mins * 10,
        days: [
          ...new Set([
            ...stats.days,
            day(new Date()),
          ]),
        ],
      };

      setStats(nextStats);

      localStorage.setItem(
        "stats",
        JSON.stringify(nextStats)
      );

      setStatus(
        `Saved! +${mins * 10} XP gained ✨`
      );

      load();
    } catch (e) {
      setStatus("Error: " + e.message);
    }
  }

  async function del(v) {
    if (!confirm("Delete this timelapse?")) return;

    URL.revokeObjectURL(v.url);

    await store("v", "readwrite", (s) =>
      s.delete(v.id)
    );

    load();
  }

  const level =
    Math.floor(Math.sqrt(stats.xp / 100)) + 1;

  const [lo, hi] = [
    100 * (level - 1) ** 2,
    100 * level ** 2,
  ];

  let streak = 0;

  const d = new Date();

  if (!stats.days.includes(day(d))) {
    d.setDate(d.getDate() - 1);
  }

  while (stats.days.includes(day(d))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }

  const progressPercent = Math.min(
    100,
    Math.max(
      0,
      ((stats.xp - lo) / (hi - lo)) * 100
    )
  );

  return (
    <main>
      <header className="brand-header">
        <h1>StudyLapse</h1>
        <p className="subtitle">
          Focus, record, and build your study streak.
        </p>
      </header>

      <section className="stats-card">
        <div className="stats-row">
          <div className="stat-item highlight">
            <span className="stat-label">
              Level
            </span>
            <span className="stat-value">
              {level}
            </span>
          </div>

          <div className="stat-item">
            <span className="stat-label">
              Total XP
            </span>
            <span className="stat-value">
              {stats.xp.toLocaleString()}
            </span>
          </div>

          <div className="stat-item">
            <span className="stat-label">
              Current Streak
            </span>
            <span className="stat-value">
              {streak} <small>days</small>
            </span>
          </div>
        </div>

        <div className="progress-container">
          <div className="progress-header">
            <span>
              Level {level} Progress
            </span>

            <span>
              {stats.xp - lo} / {hi - lo} XP
            </span>
          </div>

          <div className="bar">
            <i
              style={{
                width: `${progressPercent}%`,
              }}
            />
          </div>
        </div>
      </section>

      <section className="studio-card">
        <div
          className="video-container"
          style={{
            display: recording ? "block" : "none",
          }}
        >
          <div className="live-badge">
            <span className="pulse-dot" />
            LIVE RECORDING
          </div>

          <video
            ref={video}
            muted
            playsInline
          />
        </div>

        <div className="controls">
          {recording ? (
            <div className="recording-status">
              <div className="time-counter">
                <span>
                  {Math.round(
                    (n * SEC) / 60
                  )}
                </span>{" "}
                min studied
              </div>

              <button
                className="btn btn-primary btn-stop"
                onClick={stop}
              >
                Finish & Save Session
              </button>
            </div>
          ) : (
            <div className="setup-status">
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={screen}
                  onChange={(e) =>
                    setScreen(e.target.checked)
                  }
                />

                <span className="toggle-switch" />

                Record screen instead of camera
              </label>

              <button
                className="btn btn-primary btn-start"
                onClick={start}
              >
                Start Studying
              </button>
            </div>
          )}
        </div>

        {status && (
          <div className="status-toast">
            {status}
          </div>
        )}
      </section>

      <section className="timelapses-section">
        <h2>Your Timelapses</h2>

        {videos.length === 0 ? (
          <div className="empty-state">
            <p>
              No study sessions recorded yet.
            </p>

            <small>
              Click "Start Studying" above to
              produce your first timelapse.
            </small>
          </div>
        ) : (
          <div className="grid">
            {videos.map((v) => (
              <div
                key={v.id}
                className="video-card"
              >
                <div className="video-wrapper">
                  <video
                    src={v.url}
                    controls
                  />
                </div>

                <div className="card-body">
                  <span className="card-title">
                    {v.title}
                  </span>

                  <div className="card-actions">
                    <a
                      className="btn btn-sm btn-outline"
                      href={v.url}
                      download={`studylapse-${v.id}.webm`}
                    >
                      Download
                    </a>

                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => del(v)}
                    >
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

// ============================================================
// VideoFun
// ============================================================

function VideoFun() {
  const [videos, setVideos] = useState([]);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [status, setStatus] = useState("");

  const preview = useRef();
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);

  async function loadVideos() {
    const all = await store(
      "funVideos",
      "readonly",
      (s) => s.getAll()
    );

    setVideos(
      all.reverse().map((v) => ({
        ...v,
        url: URL.createObjectURL(v.blob),
      }))
    );
  }

  useEffect(() => {
    loadVideos();
    navigator.storage?.persist?.();

    return () => {
      clearInterval(timerRef.current);

      if (streamRef.current) {
        streamRef.current
          .getTracks()
          .forEach((track) => track.stop());
      }
    };
  }, []);

  function getSupportedMimeType() {
    const types = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];

    return (
      types.find((type) =>
        MediaRecorder.isTypeSupported(type)
      ) || ""
    );
  }

  async function startRecording() {
    try {
      setStatus("");

      if (
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia
      ) {
        throw new Error(
          "Camera recording is not supported by this browser."
        );
      }

      const stream =
        await navigator.mediaDevices.getUserMedia({
          video: {
            width: {
              ideal: 1920,
            },
            height: {
              ideal: 1080,
            },
            facingMode: "user",
          },
          audio: true,
        });

      streamRef.current = stream;

      preview.current.srcObject = stream;

      await preview.current.play();

      const mimeType =
        getSupportedMimeType();

      const recorder = mimeType
        ? new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond: 2_500_000,
          })
        : new MediaRecorder(stream);

      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const blob = new Blob(
          chunksRef.current,
          {
            type:
              recorder.mimeType ||
              "video/webm",
          }
        );

        const id = Date.now();

        await store(
          "funVideos",
          "readwrite",
          (s) =>
            s.put({
              id,
              title: `VideoFun • ${new Date().toLocaleString()}`,
              duration: seconds,
              blob,
            })
        );

        setStatus(
          "Video saved to this browser ✨"
        );

        await loadVideos();
      };

      recorder.start(1000);

      setSeconds(0);
      setRecording(true);

      timerRef.current = setInterval(() => {
        setSeconds((current) => {
          const next = current + 1;

          if (
            next >= MAX_VIDEO_SECONDS
          ) {
            setTimeout(() => {
              stopRecording();
            }, 0);
          }

          return next;
        });
      }, 1000);
    } catch (e) {
      setStatus(
        "Could not start camera: " +
          e.message
      );
    }
  }

  function stopRecording() {
    clearInterval(timerRef.current);

    if (
      recorderRef.current &&
      recorderRef.current.state !== "inactive"
    ) {
      recorderRef.current.stop();
    }

    if (streamRef.current) {
      streamRef.current
        .getTracks()
        .forEach((track) => track.stop());

      streamRef.current = null;
    }

    if (preview.current) {
      preview.current.srcObject = null;
    }

    setRecording(false);
  }

  async function deleteVideo(video) {
    if (
      !confirm(
        "Delete this VideoFun recording?"
      )
    ) {
      return;
    }

    URL.revokeObjectURL(video.url);

    await store(
      "funVideos",
      "readwrite",
      (s) => s.delete(video.id)
    );

    await loadVideos();
  }

  function formatTime(totalSeconds) {
    const mins = Math.floor(
      totalSeconds / 60
    );

    const secs = totalSeconds % 60;

    return `${String(mins).padStart(
      2,
      "0"
    )}:${String(secs).padStart(2, "0")}`;
  }

  return (
    <main>
      <header className="brand-header">
        <h1>VideoFun</h1>

        <p className="subtitle">
          Record short videos and keep them
          privately in this browser.
        </p>
      </header>

      <section className="fun-hero">
        <div className="fun-icon">▶</div>

        <h2>Make a Video</h2>

        <p>
          Record a video up to 5 minutes long.
          Your recording stays in this browser
          unless you download it.
        </p>

        <div className="video-container fun-preview">
          <video
            ref={preview}
            muted
            playsInline
          />

          {!recording && (
            <div className="preview-placeholder">
              <span>Camera preview</span>
            </div>
          )}

          {recording && (
            <div className="live-badge">
              <span className="pulse-dot" />
              RECORDING
            </div>
          )}
        </div>

        <div className="fun-controls">
          <div className="fun-timer">
            <span>
              {formatTime(seconds)}
            </span>

            <small>
              / 05:00
            </small>
          </div>

          {!recording ? (
            <button
              className="btn btn-primary btn-large"
              onClick={startRecording}
            >
              Start Video
            </button>
          ) : (
            <button
              className="btn btn-stop btn-large"
              onClick={stopRecording}
            >
              Stop & Save
            </button>
          )}
        </div>

        {status && (
          <div className="status-toast">
            {status}
          </div>
        )}
      </section>

      <section className="timelapses-section">
        <div className="section-heading-row">
          <div>
            <h2>Your VideoFun Videos</h2>
            <p className="section-description">
              Stored locally on this browser.
            </p>
          </div>

          <span className="video-count">
            {videos.length}{" "}
            {videos.length === 1
              ? "video"
              : "videos"}
          </span>
        </div>

        {videos.length === 0 ? (
          <div className="empty-state">
            <p>
              No VideoFun videos yet.
            </p>

            <small>
              Record your first short video
              above.
            </small>
          </div>
        ) : (
          <div className="grid">
            {videos.map((v) => (
              <div
                key={v.id}
                className="video-card"
              >
                <div className="video-wrapper">
                  <video
                    src={v.url}
                    controls
                    preload="metadata"
                  />
                </div>

                <div className="card-body">
                  <span className="card-title">
                    {v.title}
                  </span>

                  <span className="video-duration">
                    {formatTime(v.duration)}
                  </span>

                  <div className="card-actions">
                    <a
                      className="btn btn-sm btn-outline"
                      href={v.url}
                      download={`videofun-${v.id}.webm`}
                    >
                      Download
                    </a>

                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() =>
                        deleteVideo(v)
                      }
                    >
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

// ============================================================
// CSS
// ============================================================

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

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 400 15px/1.6 Inter, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* ============================================================
   Navigation
   ============================================================ */

.top-nav {
  position: sticky;
  top: 0;
  z-index: 100;
  background: rgba(11, 12, 14, 0.9);
  backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--line);
}

.nav-inner {
  max-width: 820px;
  margin: 0 auto;
  padding: 12px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.nav-logo,
.nav-link {
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font: 500 14px Inter, sans-serif;
}

.nav-logo {
  color: var(--text);
  font-family: "Cormorant Garamond", Georgia, serif;
  font-size: 23px;
  font-weight: 600;
}

.nav-links {
  display: flex;
  gap: 6px;
}

.nav-link {
  padding: 7px 13px;
  border-radius: 999px;
}

.nav-link:hover {
  color: var(--text);
  background: rgba(255,255,255,.05);
}

.nav-link.active {
  color: var(--bg);
  background: var(--accent);
}

/* ============================================================
   Layout
   ============================================================ */

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
  margin: 0 0 6px;
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

/* ============================================================
   Stats
   ============================================================ */

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
  letter-spacing: .05em;
  color: var(--muted);
  margin-bottom: 4px;
}

.stat-value {
  font: 600 28px/1 "Cormorant Garamond", Georgia, serif;
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
  background: linear-gradient(
    90deg,
    var(--accent),
    #ede0be
  );
  border-radius: 999px;
}

/* ============================================================
   Studio
   ============================================================ */

.studio-card,
.fun-hero {
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
  z-index: 2;
  background: rgba(0,0,0,.75);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,.1);
  color: white;
  font-size: 11px;
  font-weight: 600;
  padding: 6px 12px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  gap: 8px;
  letter-spacing: .05em;
}

.pulse-dot {
  width: 8px;
  height: 8px;
  background: var(--danger);
  border-radius: 50%;
  box-shadow: 0 0 8px var(--danger);
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0% {
    opacity: 1;
    transform: scale(1);
  }

  50% {
    opacity: .4;
    transform: scale(.8);
  }

  100% {
    opacity: 1;
    transform: scale(1);
  }
}

.controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.setup-status,
.recording-status {
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

/* ============================================================
   VideoFun
   ============================================================ */

.fun-hero {
  margin-bottom: 48px;
}

.fun-icon {
  width: 52px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--accent);`