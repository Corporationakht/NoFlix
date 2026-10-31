import fs from "node:fs/promises";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const rl = readline.createInterface({ input, output });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function tmdbImage(path, size) {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : "";
}

async function getDetails(id, category, apiKey) {
  const preferred = category === "film" ? "movie" : "tv";
  const endpoints = [preferred, preferred === "movie" ? "tv" : "movie"];

  for (const type of endpoints) {
    const url = new URL(`https://api.themoviedb.org/3/${type}/${encodeURIComponent(id)}`);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("language", "id-ID");

    const response = await fetch(url);
    if (response.ok) {
      return { data: await response.json(), type };
    }

    // A 404 may mean the item is the other media type; try the fallback.
    if (response.status !== 404) {
      const body = await response.text();
      throw new Error(`TMDB ${response.status} untuk ID ${id}: ${body.slice(0, 180)}`);
    }
  }
  return null;
}

async function main() {
  const apiKey = (await rl.question("Masukkan TMDB API Key (v3): ")).trim();
  if (!apiKey) throw new Error("API key kosong.");

  let raw;
  try {
    raw = JSON.parse(await fs.readFile("videos.json", "utf8"));
  } catch {
    throw new Error("Tidak bisa membaca videos.json. Jalankan script di folder yang sama dengan videos.json.");
  }

  if (!raw || !Array.isArray(raw.titles)) {
    throw new Error('Format videos.json harus memiliki array "titles".');
  }

  const backupPath = "videos.backup.json";
  await fs.copyFile("videos.json", backupPath);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < raw.titles.length; i++) {
    const item = raw.titles[i];
    const id = item.tmdbId;

    if (!id) {
      console.log(`[LEWATI] ${item.title}: tidak memiliki tmdbId.`);
      skipped++;
      continue;
    }

    try {
      const result = await getDetails(id, item.category, apiKey);
      if (!result) {
        console.log(`[TIDAK DITEMUKAN] ${item.title} (ID ${id})`);
        skipped++;
        continue;
      }

      const data = result.data;
      let changed = false;

      if (data.poster_path) {
        item.poster = tmdbImage(data.poster_path, "w500");
        changed = true;
      }
      if (data.backdrop_path) {
        item.backdrop = tmdbImage(data.backdrop_path, "w1280");
        changed = true;
      }

      if (changed) {
        console.log(`[OK] ${item.title}`);
        updated++;
      } else {
        console.log(`[TANPA POSTER] ${item.title} (ID ${id})`);
        skipped++;
      }
    } catch (error) {
      console.error(`[GAGAL] ${item.title}: ${error.message}`);
      failed++;
    }

    // Keep requests comfortably spaced.
    await sleep(250);
  }

  await fs.writeFile("videos.json", JSON.stringify(raw, null, 2) + "\n", "utf8");
  console.log("\nSelesai.");
  console.log(`Poster/backdrop diperbarui: ${updated}`);
  console.log(`Dilewati/tidak ditemukan: ${skipped}`);
  console.log(`Gagal karena error: ${failed}`);
  console.log(`Cadangan file lama: ${backupPath}`);
  console.log("\nPeriksa website setelah mengunggah videos.json yang baru ke GitHub.");
  console.log("API key tidak disimpan ke file mana pun oleh script ini.");
}

main()
  .catch(error => {
    console.error("\nERROR:", error.message);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
