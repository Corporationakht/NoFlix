const app = document.getElementById("app");
const CATEGORY = { film: "Film", serial: "Serial", anime: "Anime" };
const motionOK = !matchMedia("(prefers-reduced-motion: reduce)").matches;
let dataPromise = null;
let routeToken = 0;
let revealer = null;

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem("noflix:" + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("noflix:" + key, JSON.stringify(value));
    } catch {}
  }
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function fold(text) {
  return String(text ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

class DataError extends Error {}

function normalize(raw) {
  if (!raw || !Array.isArray(raw.titles)) throw new DataError('Isi file harus berbentuk { "titles": [ ... ] }.');
  const seen = new Set();
  return raw.titles.map((t, i) => {
    const where = `Judul ke-${i + 1}`;
    if (!t || typeof t !== "object") throw new DataError(`${where} bukan objek.`);
    if (!t.id || typeof t.id !== "string") throw new DataError(`${where} tidak punya "id".`);
    if (seen.has(t.id)) throw new DataError(`"id" ${t.id} dipakai lebih dari sekali.`);
    seen.add(t.id);
    if (!CATEGORY[t.category]) throw new DataError(`${t.id}: "category" harus film, serial, atau anime.`);
    if (!t.title) throw new DataError(`${t.id}: "title" kosong.`);
    const seasons = Array.isArray(t.seasons) ? t.seasons
      .map(s => ({ number: Number(s.number), title: s.title || `Musim ${s.number}`, episodes: (s.episodes || []).map(e => ({ ...e, number: Number(e.number) })).sort((a, b) => a.number - b.number) }))
      .filter(s => s.episodes.length)
      .sort((a, b) => a.number - b.number) : [];
    if (!seasons.length && !t.video) throw new DataError(`${t.id}: isi "video" untuk film, atau "seasons" untuk serial.`);
    return {
      id: t.id,
      category: t.category,
      title: String(t.title),
      year: t.year || "",
      duration: Number(t.duration) || 0,
      genres: Array.isArray(t.genres) ? t.genres.map(String) : [],
      synopsis: t.synopsis || "",
      poster: t.poster || "",
      backdrop: t.backdrop || "",
      featured: Boolean(t.featured),
      added: t.added || "",
      video: t.video || "",
      videoType: t.videoType || "",
      seasons
    };
  }).sort((a, b) => String(b.added).localeCompare(String(a.added)));
}

function loadData() {
  if (!dataPromise) {
    dataPromise = fetch("videos.json", { cache: "no-cache" })
      .then(res => {
        if (!res.ok) throw new DataError(`videos.json tidak ditemukan (status ${res.status}).`);
        return res.text();
      })
      .then(text => {
        let raw;
        try {
          raw = JSON.parse(text);
        } catch (err) {
          throw new DataError("videos.json bukan JSON yang valid: " + err.message);
        }
        return normalize(raw);
      })
      .catch(err => {
        dataPromise = null;
        throw err;
      });
  }
  return dataPromise;
}

const isSeries = t => t.seasons.length > 0;
const episodeCount = t => t.seasons.reduce((n, s) => n + s.episodes.length, 0);

function sourceOf(url, type) {
  if (!url) return null;
  let u;
  try {
    u = new URL(url, location.href);
  } catch {
    return null;
  }
  const yt = u.href.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) return { kind: "embed", src: `https://www.youtube-nocookie.com/embed/${yt[1]}?rel=0` };
  const drive = u.href.match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
  if (drive) return { kind: "embed", src: `https://drive.google.com/file/d/${drive[1]}/preview` };
  if (type === "file" || (type !== "embed" && /\.(mp4|webm|ogv|ogg|m4v|mov)$/i.test(u.pathname))) return { kind: "file", src: u.href };
  return { kind: "embed", src: u.href };
}

function progressKey(id, s, e) {
  return s ? `${id}:${s}:${e}` : id;
}

const progress = {
  all: () => store.get("progress", {}),
  get: key => progress.all()[key] || null,
  save(key, t, d) {
    const all = progress.all();
    all[key] = { t: Math.floor(t), d: Math.floor(d), at: Date.now() };
    store.set("progress", all);
  },
  pct: p => (p && p.d ? Math.min(100, Math.round((p.t / p.d) * 100)) : 0),
  done: p => Boolean(p && p.d && p.t / p.d > 0.95)
};

function continueList(titles) {
  const all = progress.all();
  const out = [];
  for (const t of titles) {
    let best = null;
    for (const [key, p] of Object.entries(all)) {
      if (key !== t.id && !key.startsWith(t.id + ":")) continue;
      const [, ks, ke] = key.split(":");
      if (ks ? !episodeExists(t, Number(ks), Number(ke)) : isSeries(t)) continue;
      if (!best || p.at > best.p.at) best = { key, p };
    }
    if (!best) continue;
    const [, s, e] = best.key.split(":");
    if (progress.done(best.p) && !(s && nextEpisode(t, Number(s), Number(e)))) continue;
    out.push({ t, key: best.key, p: best.p, s: s ? Number(s) : 0, e: e ? Number(e) : 0 });
  }
  return out.sort((a, b) => b.p.at - a.p.at);
}

function episodeExists(t, s, e) {
  const season = t.seasons.find(x => x.number === s);
  return Boolean(season && season.episodes.some(x => x.number === e));
}

function nextEpisode(t, s, e) {
  const si = t.seasons.findIndex(x => x.number === s);
  if (si < 0) return null;
  const ei = t.seasons[si].episodes.findIndex(x => x.number === e);
  if (ei >= 0 && ei + 1 < t.seasons[si].episodes.length) return { s, e: t.seasons[si].episodes[ei + 1].number };
  if (si + 1 < t.seasons.length) return { s: t.seasons[si + 1].number, e: t.seasons[si + 1].episodes[0].number };
  return null;
}

function playTarget(t) {
  if (!isSeries(t)) {
    const p = progress.get(t.id);
    return { href: `#/tonton/${encodeURIComponent(t.id)}`, label: p && !progress.done(p) && p.t > 5 ? "Lanjutkan" : "Putar" };
  }
  const c = continueList([t])[0];
  if (c) {
    const target = progress.done(c.p) ? nextEpisode(t, c.s, c.e) : { s: c.s, e: c.e };
    return { href: `#/tonton/${encodeURIComponent(t.id)}/${target.s}/${target.e}`, label: `Lanjutkan M${target.s} E${target.e}` };
  }
  const first = t.seasons[0];
  return { href: `#/tonton/${encodeURIComponent(t.id)}/${first.number}/${first.episodes[0].number}`, label: "Putar episode 1" };
}

const watchlist = {
  all: () => store.get("watchlist", []),
  has: id => watchlist.all().includes(id),
  toggle(id) {
    const list = watchlist.all();
    const idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1);
    else list.unshift(id);
    store.set("watchlist", list);
    return idx < 0;
  }
};

function listButton(t) {
  const saved = watchlist.has(t.id);
  return `<button type="button" data-action="toggle-list" data-id="${esc(t.id)}" aria-pressed="${saved}">${saved ? "Hapus dari Daftarku" : "Simpan ke Daftarku"}</button>`;
}

function billing(parts) {
  const list = parts.filter(Boolean);
  return list.length ? `<p class="billing">${list.map(p => `<span>${esc(p)}</span>`).join("")}</p>` : "";
}

function lengthLabel(t) {
  if (isSeries(t)) return `${t.seasons.length} musim, ${episodeCount(t)} episode`;
  return t.duration ? `${t.duration} menit` : "";
}

function detailHref(t) {
  return `#/judul/${encodeURIComponent(t.id)}`;
}

function posterImg(t, cls = "poster") {
  return t.poster
    ? `<img class="${cls}" src="${esc(t.poster)}" alt="" loading="lazy">`
    : `<span class="${cls} poster-empty">${esc(t.title)}</span>`;
}

function card(t, opts = {}) {
  const href = opts.href || detailHref(t);
  const bar = opts.pct ? `<span class="progress" aria-hidden="true"><span style="width:${opts.pct}%"></span></span>` : "";
  if (opts.wide) {
    const img = t.backdrop || t.poster;
    const media = img ? `<img class="still" src="${esc(img)}" alt="" loading="lazy">` : `<span class="still poster-empty">${esc(t.title)}</span>`;
    return `<a class="card card-wide" href="${href}"><span class="frame">${media}${bar}</span><span class="card-title">${esc(t.title)}</span><span class="card-sub">${esc([CATEGORY[t.category], t.year, lengthLabel(t)].filter(Boolean).join(" / "))}</span></a>`;
  }
  const sub = opts.sub || [CATEGORY[t.category], t.year].filter(Boolean).join(" / ");
  return `<a class="card" href="${href}"><span class="frame">${posterImg(t)}${bar}</span><span class="card-title">${esc(t.title)}</span><span class="card-sub">${esc(sub)}</span></a>`;
}

function band(title, body, link) {
  return `<section class="band"><div class="band-head"><h2>${esc(title)}</h2>${link || ""}</div>${body}</section>`;
}

function emptyLibrary() {
  return `<div class="state"><h1 tabindex="-1">Belum ada video</h1><p>Tambahkan judul pertama di file <code>videos.json</code>, simpan, lalu muat ulang halaman ini.</p></div>`;
}

function errorState(err) {
  const isData = err instanceof DataError;
  return `<div class="state"><h1 tabindex="-1">${isData ? "videos.json bermasalah" : "Gagal memuat"}</h1><p class="error">${esc(err.message)}</p><p>${isData ? "Perbaiki bagian yang disebut di atas, simpan file, lalu tekan Muat ulang." : "Periksa koneksi atau server lokal, lalu coba lagi."}</p><div class="actions"><button type="button" data-action="retry">Muat ulang</button></div></div>`;
}

async function viewHome() {
  const titles = await loadData();
  if (!titles.length) return emptyLibrary();
  const featured = titles.find(t => t.featured) || titles[0];
  const play = playTarget(featured);
  const heroImg = featured.backdrop || featured.poster;
  let html = `<section class="hero">
      <div class="hero-media">${heroImg ? `<img src="${esc(heroImg)}" alt="">` : ""}</div>
      <div class="hero-body">
        <h1 tabindex="-1">${esc(featured.title)}</h1>
        ${billing([CATEGORY[featured.category], featured.year, lengthLabel(featured), featured.genres.join(", ")])}
        ${featured.synopsis ? `<p class="overview">${esc(featured.synopsis)}</p>` : ""}
        <div class="actions">
          <a class="btn btn-primary" href="${play.href}">${esc(play.label)}</a>
          <a class="btn" href="${detailHref(featured)}">Lihat detail</a>
          ${listButton(featured)}
        </div>
      </div>
    </section>`;

  const cont = continueList(titles);
  if (cont.length) {
    html += band("Lanjut nonton", `<div class="track">${cont.map(c => {
      const target = c.s && progress.done(c.p) ? nextEpisode(c.t, c.s, c.e) : { s: c.s, e: c.e };
      const href = c.s ? `#/tonton/${encodeURIComponent(c.t.id)}/${target.s}/${target.e}` : `#/tonton/${encodeURIComponent(c.t.id)}`;
      const sub = c.s ? `Musim ${target.s}, episode ${target.e}` : (c.p.d ? `${progress.pct(c.p)}% ditonton` : "Terakhir dibuka");
      return card(c.t, { href, pct: target.e === c.e && target.s === c.s ? progress.pct(c.p) : 0, sub });
    }).join("")}</div>`);
  }

  const fresh = titles.slice(0, 8);
  html += band("Baru ditambahkan", `<div class="track track-wide">${fresh.map(t => card(t, { wide: true })).join("")}</div>`);

  const films = titles.filter(t => t.category === "film");
  if (films.length) html += band("Film", `<div class="track">${films.map(t => card(t)).join("")}</div>`, `<a href="#/film">Semua film</a>`);

  const anime = titles.filter(t => t.category === "anime");
  if (anime.length) {
    const [main, ...rest] = anime;
    const spot = `<a class="spot-main card" href="${detailHref(main)}">${posterImg(main)}<span><h3>${esc(main.title)}</h3>${billing([main.year, lengthLabel(main)])}${main.synopsis ? `<p class="overview">${esc(main.synopsis)}</p>` : ""}</span></a>`;
    const others = rest.length ? `<div class="spot-rest">${rest.slice(0, 6).map(t => card(t)).join("")}</div>` : "";
    html += band("Anime", `<div class="spotlight">${spot}${others}</div>`, `<a href="#/anime">Semua anime</a>`);
  }

  const series = titles.filter(t => t.category === "serial");
  if (series.length) {
    const rows = series.slice(0, 10).map(t => `<li><a href="${detailHref(t)}"><strong>${esc(t.title)}</strong><span>${esc(t.year)}</span><span>${t.seasons.length} musim</span><span>${episodeCount(t)} episode</span></a></li>`).join("");
    html += band("Serial", `<ol class="ledger">${rows}</ol>`, `<a href="#/serial">Semua serial</a>`);
  }
  return html;
}

async function viewCategory(cat, genre) {
  const titles = (await loadData()).filter(t => t.category === cat);
  const genres = [...new Set(titles.flatMap(t => t.genres))].sort((a, b) => a.localeCompare(b, "id"));
  const list = genre ? titles.filter(t => t.genres.includes(genre)) : titles;
  const control = genres.length
    ? `<div class="field"><label for="genre">Genre</label><select id="genre" data-action="genre" data-cat="${cat}"><option value="">Semua genre</option>${genres.map(g => `<option value="${esc(g)}"${g === genre ? " selected" : ""}>${esc(g)}</option>`).join("")}</select></div>`
    : "";
  let body;
  if (!titles.length) body = `<div class="state"><p>Belum ada ${CATEGORY[cat].toLowerCase()} di <code>videos.json</code>. Tambahkan judul dengan <code>"category": "${cat}"</code>.</p></div>`;
  else if (!list.length) body = `<div class="state"><p>Tidak ada judul bergenre ${esc(genre)}. Pilih genre lain.</p></div>`;
  else body = `<div class="grid">${list.map(t => card(t)).join("")}</div>`;
  return `<div class="page-head"><h1 tabindex="-1">${CATEGORY[cat]}</h1>${control}</div>${body}`;
}

async function viewSearch(query) {
  const q = query.trim();
  document.getElementById("search-input").value = q;
  if (!q) return `<div class="state"><h1 tabindex="-1">Cari judul</h1><p>Ketik judul atau genre di kolom pencarian.</p></div>`;
  const needle = fold(q);
  const results = (await loadData()).filter(t => fold(t.title).includes(needle) || t.genres.some(g => fold(g).includes(needle)));
  if (!results.length) return `<div class="state"><h1 tabindex="-1">Tidak ketemu</h1><p>Tidak ada judul atau genre yang cocok dengan "${esc(q)}".</p></div>`;
  return `<div class="page-head"><h1 tabindex="-1">"${esc(q)}"</h1><p class="note">${results.length} judul cocok</p></div><div class="grid">${results.map(t => card(t)).join("")}</div>`;
}

async function viewList() {
  const titles = await loadData();
  const ids = watchlist.all();
  const list = ids.map(id => titles.find(t => t.id === id)).filter(Boolean);
  if (!list.length) {
    return `<div class="state"><h1 tabindex="-1">Daftarku kosong</h1><p>Tekan "Simpan ke Daftarku" di halaman judul mana pun supaya muncul di sini. Daftar ini tersimpan di browser ini saja.</p><div class="actions"><a class="btn btn-primary" href="#/">Ke beranda</a></div></div>`;
  }
  return `<div class="page-head"><h1 tabindex="-1">Daftarku</h1><p class="note">${list.length} judul disimpan di browser ini</p></div><div class="grid">${list.map(t => card(t)).join("")}</div>`;
}

function notFound(what) {
  return `<div class="state"><h1 tabindex="-1">Tidak ada</h1><p>${what}</p><div class="actions"><a class="btn btn-primary" href="#/">Ke beranda</a></div></div>`;
}

function episodeRows(t, season) {
  return season.episodes.map(e => {
    const p = progress.get(progressKey(t.id, season.number, e.number));
    const state = p ? (progress.done(p) ? "Sudah ditonton" : p.d ? `${progress.pct(p)}% ditonton` : "Pernah dibuka") : "";
    const meta = [e.duration ? `${e.duration} menit` : "", state].filter(Boolean).join(" / ");
    return `<li class="episode"><span class="num">${String(e.number).padStart(2, "0")}</span><div><h3>${esc(e.title || `Episode ${e.number}`)}</h3>${meta ? `<p class="ep-progress">${esc(meta)}</p>` : ""}${e.synopsis ? `<p>${esc(e.synopsis)}</p>` : ""}</div><a class="btn" href="#/tonton/${encodeURIComponent(t.id)}/${season.number}/${e.number}" aria-label="Putar episode ${e.number}: ${esc(e.title || "")}">Putar</a></li>`;
  }).join("");
}

async function viewDetail(id) {
  const titles = await loadData();
  const t = titles.find(x => x.id === id);
  if (!t) return notFound(`Judul dengan id "${esc(id)}" tidak ada di videos.json.`);
  const play = playTarget(t);
  const img = t.backdrop || t.poster;
  let seasons = "";
  if (isSeries(t)) {
    const current = continueList([t])[0];
    const season = t.seasons.find(s => current && s.number === current.s) || t.seasons[0];
    const picker = t.seasons.length > 1
      ? `<div class="field"><label for="season">Musim</label><select id="season" data-action="season" data-id="${esc(t.id)}">${t.seasons.map(s => `<option value="${s.number}"${s === season ? " selected" : ""}>${esc(s.title)} (${s.episodes.length} episode)</option>`).join("")}</select></div>`
      : "";
    seasons = `<section class="section"><h2>Episode</h2>${picker}<ol class="episodes" id="episodes">${episodeRows(t, season)}</ol></section>`;
  }
  const similar = titles.filter(x => x.id !== t.id && x.genres.some(g => t.genres.includes(g))).slice(0, 12);
  return `<section class="detail${img ? "" : " no-media"}">
      ${img ? `<div class="hero-media"><img src="${esc(img)}" alt=""></div>` : ""}
      <div class="detail-body">
        ${t.poster ? `<img class="poster" src="${esc(t.poster)}" alt="Poster ${esc(t.title)}">` : `<span class="poster poster-empty">${esc(t.title)}</span>`}
        <div>
          <h1 tabindex="-1">${esc(t.title)}</h1>
          ${billing([CATEGORY[t.category], t.year, lengthLabel(t), t.genres.join(", ")])}
          <p class="overview">${esc(t.synopsis || "Belum ada sinopsis.")}</p>
          <div class="actions"><a class="btn btn-primary" href="${play.href}">${esc(play.label)}</a>${listButton(t)}</div>
        </div>
      </div>
    </section>${seasons}${similar.length ? band("Judul serupa", `<div class="track">${similar.map(x => card(x)).join("")}</div>`) : ""}`;
}

async function viewWatch(id, s, e) {
  const titles = await loadData();
  const t = titles.find(x => x.id === id);
  if (!t) return notFound(`Judul dengan id "${esc(id)}" tidak ada di videos.json.`);
  let item = t;
  let sub = billing([CATEGORY[t.category], t.year, lengthLabel(t)]);
  let key = t.id;
  let next = null;
  if (isSeries(t)) {
    const season = t.seasons.find(x => x.number === Number(s));
    const ep = season && season.episodes.find(x => x.number === Number(e));
    if (!ep) return notFound(`Episode ini tidak ada di ${esc(t.title)}.`);
    item = { video: ep.video, videoType: ep.videoType };
    key = progressKey(t.id, season.number, ep.number);
    sub = `<p class="sub">Musim ${season.number}, episode ${ep.number}${ep.title ? `: ${esc(ep.title)}` : ""}</p>`;
    next = nextEpisode(t, season.number, ep.number);
  }
  const src = sourceOf(item.video, item.videoType);
  if (!src) return notFound(`Link video untuk ${esc(t.title)} kosong atau tidak valid di videos.json.`);
  const player = src.kind === "file"
    ? `<video id="video" controls playsinline preload="metadata" src="${esc(src.src)}" data-key="${esc(key)}"${t.backdrop ? ` poster="${esc(t.backdrop)}"` : ""}></video>`
    : `<iframe src="${esc(src.src)}" title="Pemutar ${esc(t.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="no-referrer"></iframe>`;
  if (src.kind === "embed") {
    const old = progress.get(key);
    progress.save(key, old ? old.t : 0, old ? old.d : 0);
  }
  const nextLink = next ? `<a class="btn btn-primary" href="#/tonton/${encodeURIComponent(t.id)}/${next.s}/${next.e}">Episode berikutnya</a>` : "";
  const note = src.kind === "embed"
    ? `<p class="note">Video diputar lewat embed dari ${esc(new URL(src.src).hostname)}. Posisi menonton tidak bisa disimpan untuk embed.</p>`
    : `<p class="note">Posisi menonton disimpan otomatis di browser ini.</p>`;
  return `<div class="watch">
      <h1 tabindex="-1">${esc(t.title)}</h1>
      ${sub}
      <div class="player" id="player">${player}</div>
      ${note}
      <div class="actions">${nextLink}<a class="btn" href="${detailHref(t)}">Kembali ke detail</a>${listButton(t)}</div>
    </div>`;
}

function bindVideo() {
  const video = document.getElementById("video");
  if (!video) return;
  const key = video.dataset.key;
  let lastSave = 0;
  const save = () => {
    if (video.duration && isFinite(video.duration)) progress.save(key, video.currentTime, video.duration);
  };
  video.addEventListener("loadedmetadata", () => {
    const p = progress.get(key);
    if (p && !progress.done(p) && p.t > 5 && p.t < video.duration) video.currentTime = p.t;
  }, { once: true });
  video.addEventListener("timeupdate", () => {
    if (Date.now() - lastSave > 5000) {
      lastSave = Date.now();
      save();
    }
  });
  video.addEventListener("pause", save);
  video.addEventListener("ended", save);
  video.addEventListener("error", () => {
    document.getElementById("player").insertAdjacentHTML("beforeend", `<div class="player-error" role="alert"><strong>Video tidak bisa diputar.</strong><span>Link mungkin mati, butuh login, atau formatnya tidak didukung browser.</span><a href="${esc(video.currentSrc || video.src)}" target="_blank" rel="noopener noreferrer">Buka link video di tab baru</a></div>`);
  });
  window.addEventListener("hashchange", save, { once: true });
}

function reveal() {
  if (revealer) revealer.disconnect();
  if (!motionOK || !("IntersectionObserver" in window)) return;
  const items = app.querySelectorAll(".band .card, .ledger li, .episode, .grid .card");
  revealer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("in");
      revealer.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -40px 0px" });
  items.forEach((el, i) => {
    el.classList.add("reveal");
    el.style.transitionDelay = `${Math.min(i % 8, 6) * 40}ms`;
    revealer.observe(el);
  });
}

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(p => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const [a = "", b = "", c = "", d = ""] = parts;
  if (!a) return { nav: "home", run: viewHome };
  if (CATEGORY[a]) return { nav: a, run: () => viewCategory(a, b) };
  if (a === "daftarku") return { nav: "daftarku", run: viewList };
  if (a === "cari") return { nav: "", run: () => viewSearch(parts.slice(1).join("/")) };
  if (a === "judul" && b) return { nav: "", run: () => viewDetail(b) };
  if (a === "tonton" && b) return { nav: "", run: () => viewWatch(b, c, d) };
  return { nav: "", run: () => notFound("Alamat ini tidak dikenali.") };
}

async function render() {
  const token = ++routeToken;
  const route = parseRoute();
  if (!location.hash.startsWith("#/cari/")) document.getElementById("search-input").value = "";
  document.querySelectorAll("[data-nav]").forEach(a => {
    if (a.dataset.nav === route.nav) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  app.innerHTML = `<p class="loading-text" role="status">Memuat...</p>`;
  window.scrollTo(0, 0);
  let html;
  try {
    html = await route.run();
  } catch (err) {
    html = errorState(err);
  }
  if (token !== routeToken) return;
  app.innerHTML = `<div class="${motionOK ? "enter" : ""}">${html}</div>`;
  bindVideo();
  reveal();
  const heading = app.querySelector("h1");
  document.title = heading && route.nav !== "home" ? `${heading.textContent} · NoFlix` : "NoFlix";
  if (heading && route.nav !== "home") heading.focus({ preventScroll: true });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById("theme-toggle");
  btn.textContent = theme === "dark" ? "Mode terang" : "Mode gelap";
  btn.setAttribute("aria-pressed", String(theme === "light"));
}

document.getElementById("theme-toggle").addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  store.set("theme", theme);
  applyTheme(theme);
});

document.getElementById("search-form").addEventListener("submit", e => {
  e.preventDefault();
  location.hash = "#/cari/" + encodeURIComponent(document.getElementById("search-input").value.trim());
});

document.addEventListener("click", e => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  if (el.dataset.action === "retry") {
    dataPromise = null;
    render();
  }
  if (el.dataset.action === "toggle-list") {
    const saved = watchlist.toggle(el.dataset.id);
    document.querySelectorAll(`[data-action="toggle-list"][data-id="${CSS.escape(el.dataset.id)}"]`).forEach(btn => {
      btn.setAttribute("aria-pressed", String(saved));
      btn.textContent = saved ? "Hapus dari Daftarku" : "Simpan ke Daftarku";
    });
  }
});

document.addEventListener("change", async e => {
  const el = e.target;
  if (el.dataset.action === "genre") location.hash = `#/${el.dataset.cat}` + (el.value ? `/${encodeURIComponent(el.value)}` : "");
  if (el.dataset.action === "season") {
    const t = (await loadData()).find(x => x.id === el.dataset.id);
    const season = t && t.seasons.find(s => s.number === Number(el.value));
    if (season) {
      document.getElementById("episodes").innerHTML = episodeRows(t, season);
      reveal();
    }
  }
});

applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
window.addEventListener("hashchange", render);
render();
