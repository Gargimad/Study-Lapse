import { useState, useRef, useEffect, useCallback } from "react";

const SEC = 5;
const MAX_VIDEO_SECONDS = 5 * 60;

const day = (d) => d.toLocaleDateString("en-CA");

// ============================================================
// IndexedDB — two separate databases
// ============================================================

// --- StudyLapse DB: holds timelapse recordings ---
const studyDb = new Promise((res, rej) => {
  const r = indexedDB.open("studylapse", 2);

  r.onupgradeneeded = () => {
    const database = r.result;
    if (!database.objectStoreNames.contains("v")) {
      database.createObjectStore("v", { keyPath: "id" });
    }
  };

  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

// --- VideoFun DB: separate database, its own store ---
const funDb = new Promise((res, rej) => {
  const r = indexedDB.open("videofun", 1);

  r.onupgradeneeded = () => {
    const database = r.result;
    if (!database.objectStoreNames.contains("clips")) {
      database.createObjectStore("clips", { keyPath: "id" });
    }
  };

  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

// Generic store helper — takes the db promise so the two apps
// are fully isolated from each other.
const makeStore = (dbPromise) => async (storeName, mode, fn) => {
  const database = await dbPromise;
  const transaction = database.transaction(storeName, mode);
  const objectStore = transaction.objectStore(storeName);

  return new Promise((resolve, reject) => {
    let result;
    let requestError;

    try {
      const request = fn(objectStore);
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => {
        requestError = request.error;
      };
    } catch (err) {
      // Synchronous errors from fn() (e.g. bad key path)
      transaction.abort();
      reject(err);
      return;
    }

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () =>
      reject(requestError || transaction.error);
    transaction.onabort = () =>
      reject(requestError || transaction.error);
  });
};

// StudyLapse store + VideoFun store
const studyStore = makeStore(studyDb);
const funStore = makeStore(funDb);

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
  const [paused, setPaused] = useState(false);
  const [screen, setScreen] = useState(false);
  const [n, setN] = useState(0);

  const video = useRef();
  const frames = useRef([]);
  const timer = useRef();
  const pausedRef = useRef(false);

  const load = useCallback(async () => {
    const all = await studyStore("v", "readonly", (s) => s.getAll());

    setVideos((prev) => {
      prev.forEach((v) => v.url && URL.revokeObjectURL(v.url));
      return all.reverse().map((v) => ({
        ...v,
        url: URL.createObjectURL(v.blob),
      }));
    });
  }, []);

  useEffect(() => {
    load();
    navigator.storage?.persist?.();

    return () => {
      clearInterval(timer.current);
    };
  }, [load]);

  const grabFrame = useCallback(() => {
    if (pausedRef.current) return;
    if (!video.current || !video.current.videoWidth) return;

    const c = document.createElement("canvas");
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
        if (b) {
          frames.current.push(b);
          setN(frames.current.length);
        }
      },
      "image/jpeg",
      0.7
    );
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
      pausedRef.current = false;
      setPaused(false);
      setN(0);

      await new Promise((resolve) => {
        if (video.current.videoWidth) return resolve();
        video.current.onloadedmetadata = () => resolve();
      });

      grabFrame();

      timer.current = setInterval(grabFrame, SEC * 1000);

      setRecording(true);
      setStatus("");
    } catch (e) {
      setStatus("Could not start recording: " + e.message);
    }
  }

  function togglePause() {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
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
    const stream = c.captureStream(15);

    const rec = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : "video/webm",
    });

    const chunks = [];

    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };

    const done = new Promise((resolve, reject) => {
      rec.onstop = resolve;
      rec.onerror = (e) => reject(e.error || new Error("Recorder error"));
    });

    rec.start();

    for (let i = 0; i < frames.current.length; i++) {
      const bitmap = await createImageBitmap(frames.current[i]);
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      await new Promise((r) => setTimeout(r, 67));
    }

    rec.stop();
    first.close();

    await done;

    return new Blob(chunks, { type: "video/webm" });
  }

  async function stop() {
    clearInterval(timer.current);
    pausedRef.current = false;

    if (video.current?.srcObject) {
      video.current.srcObject.getTracks().forEach((t) => t.stop());
      video.current.srcObject = null;
    }

    setRecording(false);
    setPaused(false);

    try {
      const mins = Math.max(
        1,
        Math.round((frames.current.length * SEC) / 60)
      );

      setStatus("Building video… keep this tab in front.");

      const blob = await render();

      await studyStore("v", "readwrite", (s) =>
        s.put({
          id: Date.now(),
          title: `${new Date().toLocaleString()} • ${mins} min`,
          blob,
        })
      );

      const nextStats = {
        xp: stats.xp + mins * 10,
        days: [...new Set([...stats.days, day(new Date())])],
      };

      setStats(nextStats);
      localStorage.setItem("stats", JSON.stringify(nextStats));

      setStatus(`Saved! +${mins * 10} XP gained ✨`);

      frames.current = [];
      load();
    } catch (e) {
      setStatus("Error: " + e.message);
    }
  }

  async function del(v) {
    if (!confirm("Delete this timelapse?")) return;

    URL.revokeObjectURL(v.url);

    await studyStore("v", "readwrite", (s) => s.delete(v.id));

    load();
  }

  const level = Math.floor(Math.sqrt(stats.xp / 100)) + 1;
  const [lo, hi] = [100 * (level - 1) ** 2, 100 * level ** 2];

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
    Math.max(0, ((stats.xp - lo) / (hi - lo)) * 100)
  );

  const studiedMinutes = Math.round((n * SEC) / 60);

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
            <span className="stat-label">Level</span>
            <span className="stat-value">{level}</span>
          </div>

          <div className="stat-item">
            <span className="stat-label">Total XP</span>
            <span className="stat-value">
              {stats.xp.toLocaleString()}
            </span>
          </div>

          <div className="stat-item">
            <span className="stat-label">Current Streak</span>
            <span className="stat-value">
              {streak} <small>days</small>
            </span>
          </div>
        </div>

        <div className="progress-container">
          <div className="progress-header">
            <span>Level {level} Progress</span>
            <span>
              {stats.xp - lo} / {hi - lo} XP
            </span>
          </div>

          <div className="bar">
            <i style={{ width: `${progressPercent}%` }} />
          </div>
        </div>
      </section>

      <section className="studio-card">
        <div
          className="video-container"
          style={{ display: recording ? "block" : "none" }}
        >
          <div className={`live-badge ${paused ? "paused" : ""}`}>
            <span className="pulse-dot" />
            {paused ? "PAUSED" : "LIVE RECORDING"}
          </div>

          <video ref={video} muted playsInline />
        </div>

        <div className="controls">
          {recording ? (
            <div className="recording-status">
              <div className="time-counter">
                <span>{studiedMinutes}</span> min studied
              </div>

              <div className="button-row">
                <button
                  className="btn btn-outline"
                  onClick={togglePause}
                >
                  {paused ? "Resume" : "Pause"}
                </button>

                <button
                  className="btn btn-primary btn-stop"
                  onClick={stop}
                >
                  Finish &amp; Save
                </button>
              </div>
            </div>
          ) : (
            <div className="setup-status">
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={screen}
                  onChange={(e) => setScreen(e.target.checked)}
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

        {status && <div className="status-toast">{status}</div>}
      </section>

      <section className="timelapses-section">
        <h2>Your Timelapses</h2>

        {videos.length === 0 ? (
          <div className="empty-state">
            <p>No study sessions recorded yet.</p>
            <small>
              Click "Start Studying" above to produce your first timelapse.
            </small>
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
  const [paused, setPaused] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [status, setStatus] = useState("");

  const preview = useRef();
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const secondsRef = useRef(0);
  const pausedRef = useRef(false);

  const loadVideos = useCallback(async () => {
    const all = await funStore("clips", "readonly", (s) => s.getAll());

    setVideos((prev) => {
      prev.forEach((v) => v.url && URL.revokeObjectURL(v.url));
      return all.reverse().map((v) => ({
        ...v,
        url: URL.createObjectURL(v.blob),
      }));
    });
  }, []);

  useEffect(() => {
    loadVideos();
    navigator.storage?.persist?.();

    return () => {
      clearInterval(timerRef.current);

      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") {
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
      }

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, [loadVideos]);

  function getSupportedMimeType() {
    const types = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];

    return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  }

  function cleanupStream() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (preview.current) {
      preview.current.srcObject = null;
    }
  }

  async function startRecording() {
    try {
      setStatus("");

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "Camera recording is not supported by this browser."
        );
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          facingMode: "user",
        },
        audio: true,
      });

      streamRef.current = stream;

      preview.current.srcObject = stream;
      await preview.current.play();

      const mimeType = getSupportedMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond: 2_500_000,
          })
        : new MediaRecorder(stream);

      recorderRef.current = recorder;
      chunksRef.current = [];
      secondsRef.current = 0;
      pausedRef.current = false;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        console.error("MediaRecorder error:", event.error);
        setStatus(
          "Recorder error: " + (event.error?.message || "unknown")
        );
      };

      recorder.onstop = async () => {
        try {
          const blob = new Blob(chunksRef.current, {
            type: recorder.mimeType || "video/webm",
          });

          if (!blob.size) {
            throw new Error(
              "Recording produced an empty file. Try recording a bit longer."
            );
          }

          const id = Date.now();

          await funStore("clips", "readwrite", (s) =>
            s.put({
              id,
              title: `VideoFun • ${new Date().toLocaleString()}`,
              duration: secondsRef.current,
              size: blob.size,
              blob,
            })
          );

          setStatus("Video saved ✨");
          await loadVideos();
        } catch (err) {
          console.error("VideoFun save failed:", err);
          setStatus("Save failed: " + err.message);
        } finally {
          cleanupStream();
          setRecording(false);
          setPaused(false);
          recorderRef.current = null;
        }
      };

      recorder.start(1000);

      setSeconds(0);
      setPaused(false);
      setRecording(true);

      timerRef.current = setInterval(() => {
        if (pausedRef.current) return;

        secondsRef.current += 1;
        setSeconds(secondsRef.current);

        if (secondsRef.current >= MAX_VIDEO_SECONDS) {
          stopRecording();
        }
      }, 1000);
    } catch (e) {
      setStatus("Could not start camera: " + e.message);
      cleanupStream();
    }
  }

  function togglePause() {
    const rec = recorderRef.current;
    if (!rec) return;

    if (rec.state === "recording") {
      rec.pause();
      pausedRef.current = true;
      setPaused(true);
    } else if (rec.state === "paused") {
      rec.resume();
      pausedRef.current = false;
      setPaused(false);
    }
  }

  // Only tells the recorder to stop. The onstop handler takes care of
  // stopping tracks and saving the blob — that way the final chunk
  // gets flushed before we tear the stream down.
  function stopRecording() {
    clearInterval(timerRef.current);
    pausedRef.current = false;

    const rec = recorderRef.current;

    if (rec && rec.state !== "inactive") {
      rec.stop();
    } else {
      // Nothing to save — clean up immediately.
      cleanupStream();
      setRecording(false);
      setPaused(false);
    }
  }

  async function deleteVideo(video) {
    if (!confirm("Delete this VideoFun recording?")) return;

    URL.revokeObjectURL(video.url);

    await funStore("clips", "readwrite", (s) => s.delete(video.id));

    await loadVideos();
  }

  function formatTime(totalSeconds) {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;

    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(
      2,
      "0"
    )}`;
  }

  function formatSize(bytes) {
    if (!bytes) return "—";
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  }

  return (
    <main>
      <header className="brand-header">
        <h1>VideoFun</h1>
        <p className="subtitle">
          Record short videos and keep them privately in this browser.
        </p>
      </header>

      <section className="fun-hero">
        <div className="fun-icon">▶</div>

        <h2>Make a Video</h2>

        <p>
          Record a video up to 5 minutes long. Your recording stays in
          this browser unless you download it.
        </p>

        <div className="video-container fun-preview">
          <video ref={preview} muted playsInline />

          {!recording && (
            <div className="preview-placeholder">
              <span>Camera preview</span>
            </div>
          )}

          {recording && (
            <div className={`live-badge ${paused ? "paused" : ""}`}>
              <span className="pulse-dot" />
              {paused ? "PAUSED" : "RECORDING"}
            </div>
          )}
        </div>

        <div className="fun-controls">
          <div className="fun-timer">
            <span>{formatTime(seconds)}</span>
            <small>/ 05:00</small>
          </div>

          {!recording ? (
            <button
              className="btn btn-primary btn-large"
              onClick={startRecording}
            >
              Start Video
            </button>
          ) : (
            <div className="button-row">
              <button
                className="btn btn-outline btn-large"
                onClick={togglePause}
              >
                {paused ? "Resume" : "Pause"}
              </button>

              <button
                className="btn btn-stop btn-large"
                onClick={stopRecording}
              >
                Stop &amp; Save
              </button>
            </div>
          )}
        </div>

        {status && <div className="status-toast">{status}</div>}
      </section>

      <section className="timelapses-section">
        <div className="section-heading-row">
          <div>
            <h2>Your VideoFun Videos</h2>
            <p className="section-description">
              Stored locally in the <code>videofun</code> database.
            </p>
          </div>

          <span className="video-count">
            {videos.length} {videos.length === 1 ? "video" : "videos"}
          </span>
        </div>

        {videos.length === 0 ? (
          <div className="empty-state">
            <p>No VideoFun videos yet.</p>
            <small>Record your first short video above.</small>
          </div>
        ) : (
          <div className="grid">
            {videos.map((v) => (
              <div key={v.id} className="video-card">
                <div className="video-wrapper">
                  <video src={v.url} controls preload="metadata" />
                </div>

                <div className="card-body">
                  <span className="card-title">{v.title}</span>

                  <span className="video-duration">
                    {formatTime(v.duration || 0)} • {formatSize(v.size)}
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
                      onClick={() => deleteVideo(v)}
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

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 400 15px/1.6 Inter, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* ============================ Navigation ============================ */

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

.nav-links { display: flex; gap: 6px; }

.nav-link {
  padding: 7px 13px;
  border-radius: 999px;
  transition: background .15s, color .15s;
}

.nav-link:hover {
  color: var(--text);
  background: rgba(255,255,255,.05);
}

.nav-link.active {
  color: var(--bg);
  background: var(--accent);
}

/* ============================ Layout ============================ */

main {
  max-width: 820px;
  margin: 0 auto;
  padding: 64px 24px;
}

.brand-header { margin-bottom: 32px; }

h1 {
  font: 600 48px/1.1 "Cormorant Garamond", Georgia, serif;
  letter-spacing: -0.01em;
  margin: 0 0 6px;
}

.subtitle { margin: 0; color: var(--muted); font-size: 15px; }

h2 {
  font: 500 28px "Cormorant Garamond", Georgia, serif;
  margin: 0 0 20px;
}

/* ============================ Stats ============================ */

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

.stat-item { display: flex; flex-direction: column; }

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

.progress-container { display: flex; flex-direction: column; gap: 8px; }

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
  background: linear-gradient(90deg, var(--accent), #ede0be);
  border-radius: 999px;
  transition: width .3s ease;
}

/* ============================ Studio / Fun hero ============================ */

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
  background: #000;
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

.live-badge.paused { color: var(--accent); }

.live-badge.paused .pulse-dot {
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
  animation: none;
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
  0%   { opacity: 1; transform: scale(1); }
  50%  { opacity: .4; transform: scale(.8); }
  100% { opacity: 1; transform: scale(1); }
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
  flex-wrap: wrap;
}

.button-row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.time-counter { font-size: 16px; color: var(--muted); }

.time-counter span {
  font-weight: 600;
  color: var(--text);
  font-size: 20px;
}

/* ============================ Buttons ============================ */

.btn {
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 10px 18px;
  font: 500 14px Inter, sans-serif;
  cursor: pointer;
  transition: background .15s, color .15s, border-color .15s, transform .1s;
}

.btn:active { transform: translateY(1px); }

.btn-primary {
  background: var(--accent);
  color: var(--bg);
  font-weight: 600;
}

.btn-primary:hover {
  background: var(--accent-hover);
  box-shadow: 0 0 0 4px var(--accent-glow);
}

.btn-outline {
  background: transparent;
  color: var(--text);
  border-color: var(--line);
}

.btn-outline:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.btn-stop {
  background: var(--danger);
  color: white;
  font-weight: 600;
}

.btn-stop:hover {
  background: #f07a7a;
  box-shadow: 0 0 0 4px var(--danger-glow);
}

.btn-danger {
  background: transparent;
  color: var(--danger);
  border-color: var(--danger);
}

.btn-danger:hover {
  background: var(--danger);
  color: white;
}

.btn-sm { padding: 6px 12px; font-size: 13px; }
.btn-large { padding: 12px 22px; font-size: 15px; }

.btn-start { min-width: 160px; }

/* ============================ Toggle ============================ */

.toggle-label {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  font-size: 14px;
  color: var(--muted);
  user-select: none;
}

.toggle-label input { display: none; }

.toggle-switch {
  position: relative;
  width: 38px;
  height: 22px;
  background: var(--line);
  border-radius: 999px;
  transition: background .15s;
}

.toggle-switch::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  background: var(--text);
  border-radius: 50%;
  transition: transform .15s;
}

.toggle-label input:checked + .toggle-switch {
  background: var(--accent);
}

.toggle-label input:checked + .toggle-switch::after {
  transform: translateX(16px);
  background: var(--bg);
}

/* ============================ VideoFun ============================ */

.fun-icon {
  width: 52px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--accent);
  color: var(--bg);
  font-size: 18px;
  margin-bottom: 12px;
}

.fun-hero p {
  color: var(--muted);
  margin: 0 0 20px;
}

.fun-preview {
  position: relative;
  margin-bottom: 20px;
}

.preview-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 14px;
  letter-spacing: .05em;
  text-transform: uppercase;
  pointer-events: none;
}

.fun-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.fun-timer {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font: 600 24px/1 "Cormorant Garamond", Georgia, serif;
  color: var(--text);
}

.fun-timer small {
  font: 400 14px Inter, sans-serif;
  color: var(--muted);
}

/* ============================ Status ============================ */

.status-toast {
  margin-top: 16px;
  padding: 10px 14px;
  background: rgba(217, 195, 143, .08);
  border: 1px solid rgba(217, 195, 143, .25);
  border-radius: 10px;
  color: var(--accent);
  font-size: 14px;
}

/* ============================ Video list ============================ */

.timelapses-section { margin-top: 24px; }

.section-heading-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 16px;
  margin-bottom: 16px;
}

.section-heading-row h2 { margin-bottom: 4px; }

.section-description {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}

.section-description code {
  background: var(--line);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 12px;
}

.video-count {
  font-size: 13px;
  color: var(--muted);
}

.empty-state {
  background: var(--panel);
  border: 1px dashed var(--line);
  border-radius: 16px;
  padding: 40px 24px;
  text-align: center;
  color: var(--muted);
}

.empty-state p { margin: 0 0 6px; color: var(--text); }
.empty-state small { font-size: 13px; }

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}

.video-card {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 14px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.video-wrapper {
  background: #000;
  aspect-ratio: 16/9;
  display: flex;
  align-items: center;
  justify-content: center;
}

.video-wrapper video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.card-body {
  padding: 12px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.card-title {
  font-size: 13px;
  color: var(--text);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.video-duration {
  font-size: 12px;
  color: var(--muted);
}

.card-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.card-actions .btn { flex: 1; text-align: center; text-decoration: none; }

/* ============================ Responsive ============================ */

@media (max-width: 600px) {
  h1 { font-size: 36px; }
  main { padding: 40px 18px; }
  .stats-row { flex-wrap: wrap; gap: 20px; }
  .stat-item { flex: 1 1 40%; }
  .setup-status,
  .recording-status { flex-direction: column; align-items: stretch; }
  .button-row { width: 100%; }
  .button-row .btn { flex: 1; }
}
`;