const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const extractZip = require('extract-zip');

const MARKER = '.webrtcbench';

/** Royalty-free benchmark clips. Files are used unmodified, as their licenses require. */
const CATALOG = [
  {
    id: 'bbb-2160p60',
    title: 'Big Buck Bunny',
    subtitle: '4K · 60 fps · H.264',
    file: 'bbb_sunflower_2160p_60fps_normal.mp4',
    url: 'https://download.blender.org/demo/movies/BBB/bbb_sunflower_2160p_60fps_normal.mp4.zip',
    zipEntry: 'bbb_sunflower_2160p_60fps_normal.mp4',
    downloadBytes: 671868845,
    width: 3840,
    height: 2160,
    fps: 60,
    segmentStart: 150,
    content: 'Animation: soft gradients, fur, fast pans',
    license: 'CC BY 3.0',
    attribution: '(c) copyright 2008, Blender Foundation / www.bigbuckbunny.org',
    sourcePage: 'https://peach.blender.org/',
  },
  {
    id: 'xmas-2160p60',
    title: 'Christmas Surprise',
    subtitle: '4K · 59.94 fps · H.264',
    file: 'Christmas-Surprise-2160p-H264-rec709-CDGriffith-Photography.mp4',
    url: 'https://www.dropbox.com/scl/fi/vhns350078h7e9zng8zi8/Christmas-Surprise-2160p-H264-rec709-CDGriffith-Photography.mp4?rlkey=76pnzde7k288hfl2zmuiq893q&dl=1',
    downloadBytes: 1117257000,
    width: 3840,
    height: 2160,
    fps: 59.94,
    content: 'Live action: 9 scene cuts, fine detail, camera motion',
    license: 'CC BY-ND 4.0',
    attribution: 'CDGriffith Photography',
    sourcePage: 'https://codecalamity.com/projects/benchmark-videos',
  },
  {
    id: 'bbb-1080p60',
    title: 'Big Buck Bunny',
    subtitle: '1080p · 60 fps · H.264',
    file: 'bbb_sunflower_1080p_60fps_normal.mp4',
    url: 'https://download.blender.org/demo/movies/BBB/bbb_sunflower_1080p_60fps_normal.mp4.zip',
    zipEntry: 'bbb_sunflower_1080p_60fps_normal.mp4',
    downloadBytes: 355019001,
    width: 1920,
    height: 1080,
    fps: 60,
    segmentStart: 150,
    content: 'Lighter source for 1080p-and-below runs',
    license: 'CC BY 3.0',
    attribution: '(c) copyright 2008, Blender Foundation / www.bigbuckbunny.org',
    sourcePage: 'https://peach.blender.org/',
  },
];

/** Mirroring mode: the live main monitor instead of a clip. */
const DISPLAY_SOURCE = {
  id: 'display',
  kind: 'display',
  title: "Mirror this PC's display",
  subtitle: 'Live screen capture · main monitor',
  content: 'Streams your main monitor in real time, like screen mirroring. Play a game or video on it during the run; unchanged frames are left out of latency.',
  license: 'Your screen',
  available: true,
};

/** Generated in the renderer at exactly the requested resolution and frame rate. */
const PATTERNS = [
  {
    id: 'pattern-motion',
    title: 'High-motion stress',
    subtitle: 'Generated · any resolution / fps',
    content: 'Full-frame moving noise and gradients: worst case for codecs',
    license: 'Generated',
  },
  {
    id: 'pattern-screen',
    title: 'Desktop & text',
    subtitle: 'Generated · any resolution / fps',
    content: 'Scrolling code, moving window, cursor: screen-sharing style',
    license: 'Generated',
  },
  {
    id: 'pattern-bars',
    title: 'Color bars + sweep',
    subtitle: 'Generated · any resolution / fps',
    content: 'Low-complexity baseline with a moving sweep bar',
    license: 'Generated',
  },
];

/** Walks up from the app looking for the project's videos/ folder, else uses Documents. */
function findLibraryDir(startDir, documentsDir) {
  let dir = startDir;
  for (let i = 0; i < 7; i++) {
    const candidate = path.join(dir, 'videos');
    if (fs.existsSync(path.join(candidate, MARKER))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fallback = path.join(documentsDir, 'WebRTC Bench', 'videos');
  fs.mkdirSync(fallback, { recursive: true });
  if (!fs.existsSync(path.join(fallback, MARKER))) fs.writeFileSync(path.join(fallback, MARKER), 'WebRTC Bench video library\n');
  return fallback;
}

class Library {
  constructor({ dir, config }) {
    this.dir = dir;
    this.config = config;
    this.downloads = new Map(); // id -> { controller, received, total }
  }

  _custom() {
    return this.config.data.customVideos || [];
  }

  list() {
    const files = CATALOG.map((c) => {
      const p = path.join(this.dir, c.file);
      let size = 0;
      try {
        size = fs.statSync(p).size;
      } catch {
        // not downloaded
      }
      const dl = this.downloads.get(c.id);
      return {
        ...c,
        kind: 'file',
        path: p,
        available: size > 0 && !dl,
        sizeBytes: size,
        downloading: dl ? { received: dl.received, total: dl.total } : null,
      };
    });
    const custom = this._custom().map((c) => {
      let size = 0;
      try {
        size = fs.statSync(c.path).size;
      } catch {
        // moved or deleted
      }
      return {
        ...c,
        kind: 'file',
        custom: true,
        available: size > 0,
        sizeBytes: size,
        subtitle: c.subtitle || 'Your file',
        license: 'Your file',
        content: c.path,
      };
    });
    return [...files, ...custom, DISPLAY_SOURCE, ...PATTERNS.map((p) => ({ ...p, kind: 'pattern', available: true }))];
  }

  resolve(id) {
    return this.list().find((v) => v.id === id) || null;
  }

  addFiles(paths) {
    const list = this._custom();
    for (const p of paths) {
      if (list.some((c) => c.path === p)) continue;
      list.push({ id: `file-${crypto.createHash('sha1').update(p).digest('hex').slice(0, 10)}`, title: path.basename(p), path: p });
    }
    this.config.data.customVideos = list;
    this.config.save();
  }

  removeCustom(id) {
    this.config.data.customVideos = this._custom().filter((c) => c.id !== id);
    this.config.save();
  }

  async download(id, onProgress) {
    const item = CATALOG.find((c) => c.id === id);
    if (!item) throw new Error(`Unknown video ${id}`);
    if (this.downloads.has(id)) return;
    const controller = new AbortController();
    const state = { controller, received: 0, total: item.downloadBytes };
    this.downloads.set(id, state);
    const work = path.join(this.dir, '_dl', id);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const tmp = path.join(work, item.zipEntry ? 'download.zip' : 'download.part');
    try {
      const res = await fetch(item.url, { signal: controller.signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} from ${new URL(item.url).host}`);
      state.total = Number(res.headers.get('content-length')) || item.downloadBytes;
      let lastEmit = 0;
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        state.received += chunk.length;
        const now = Date.now();
        if (now - lastEmit > 250) {
          lastEmit = now;
          onProgress?.({ id, received: state.received, total: state.total });
        }
      });
      await pipeline(body, fs.createWriteStream(tmp));
      const dest = path.join(this.dir, item.file);
      if (item.zipEntry) {
        const out = path.join(work, 'x');
        await extractZip(tmp, { dir: out });
        const found = findFile(out, item.zipEntry);
        if (!found) throw new Error(`${item.zipEntry} not found in archive`);
        fs.renameSync(found, dest);
      } else {
        fs.renameSync(tmp, dest);
      }
      onProgress?.({ id, received: state.total, total: state.total, done: true });
    } catch (err) {
      onProgress?.({ id, error: controller.signal.aborted ? 'Cancelled' : err.message });
      throw err;
    } finally {
      this.downloads.delete(id);
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  cancel(id) {
    this.downloads.get(id)?.controller.abort();
  }
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const f = findFile(p, name);
      if (f) return f;
    } else if (e.name === name) {
      return p;
    }
  }
  return null;
}

const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };

/** Serves a local file to the renderer with HTTP Range support so <video> can seek and loop. */
async function serveFile(filePath, request) {
  const stat = await fs.promises.stat(filePath);
  const size = stat.size;
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = request.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (m && !m[1] && m[2]) {
      start = Math.max(0, size - parseInt(m[2], 10));
      end = size - 1;
    }
    end = Math.min(end, size - 1);
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
    status: 200,
    headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
  });
}

module.exports = { Library, CATALOG, PATTERNS, findLibraryDir, serveFile };
