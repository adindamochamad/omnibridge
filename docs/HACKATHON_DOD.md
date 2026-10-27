# Definition of Done — Meta Global AI Developer Hackathon 2026

Indie · Push the Frontier · OmniBridge commit gate.

Selesai berarti seorang juri, dalam 3 menit, bisa mengulang kalimat ini tanpa slide:

> Muse Spark yakin itu Modbus. CRC-nya 0.00. Parser tidak terpasang, dan perintah ke mesin tidak terkirim.

Kalau kalimat itu tidak terjadi di rekaman, submission belum selesai. Fitur di luar kalimat itu tidak menghitung.

Bobot yang dipakai untuk mengalokasi usaha: dampak 30%, pemakaian model Meta 25%, demo termasuk video 25%, kedalaman teknis 20%. Sumber bobot: ringkasan Official Rules yang beredar lewat liputan Cerebral Valley pada 25 Okt 2026. Kalau teks yang kamu terima di portal berbeda, teks portal yang menang.

## Gagal kirim

Jangan submit selama salah satu ini benar.

- [ ] Video menampilkan webhook, export, Settings, atau kalimat Claude / Opus.
- [ ] Jalur verified memasang parser saat **Break CRC** nyala.
- [ ] Angka CRC di layar bukan dari kode (tidak ada `0.00` lawan `0.90`).
- [ ] Repo publik yang dilink di kartu akhir tidak berisi commit gate.
- [ ] Model yang terpanggil bukan `muse-spark-1.3` Standard.
- [ ] Rekaman dari browser `localhost`, bukan jendela `npm run tauri dev`.

## 1. Dampak — yang terlihat di satu frame

- [ ] Desktop window, `/hackathon`, Break CRC nyala, readout **CRC 0.00**, need **0.90**, meta `CRC flipped`.
- [ ] Pita byte terlihat sebelum tombol ditekan. Faceplate Temp, Pressure, Flow, Motor, Valve, Alarm masih **—**. Kalimat di layar: *Do not install a parser the bytes cannot prove.*
- [ ] Setelah **Run both lanes**, baris Decision: Naive = **Installed**, Verified = **Held**.
- [ ] Baris Confidence menunjukkan angka model di kedua kolom. Angka verified boleh tinggi. Keputusan tetap Held.
- [ ] Baris Tool CRC verified adalah angka di bawah 0.90, dan baris Tools memuat `analyze_binary_structure`.
- [ ] Baris Fields verified = `0`. Baris Commands naive menyebut nama perintah. Baris Commands verified = `withheld`.
- [ ] Take yang Commands-nya `none returned` dibuang. Jalankan ulang sampai kontras perintah ada.
- [ ] Break CRC dimatikan setelah Held, dalam take yang sama. Halaman menjalankan kedua lajur lagi. Readout **1.00**, Verified menjadi **Committed**, lalu angka faceplate terisi.

## 2. Model Meta — mesin, bukan stiker

- [ ] Settings → Test connection lulus ke `muse-spark-1.3` Standard. Contributor tidak dipakai.
- [ ] Kunci hanya di data lokal. Tidak ada kunci di repo, video, atau README.
- [ ] Kedua lajur memakai Meta Model API. Tidak ada panggilan Anthropic di take itu.
- [ ] Spend limit di halaman Billing Model API dipasang di $150. Klaim kredit Cerebral Valley sudah dikirim.

## 3. Video — 25% nilai, dan ini yang juri benar-benar tonton

Ikuti [HACKATHON_DEMO_SCRIPT.md](./HACKATHON_DEMO_SCRIPT.md).

- [ ] Durasi file yang diunggah 2:45–3:00.
- [ ] 10 detik pertama adalah byte plus CRC 0.00, bukan perkenalan dan bukan logo.
- [ ] Caption terbaca: `26 Oct–4 Nov 2026 · muse-spark-1.3 · Indie · Push the Frontier`.
- [ ] Satu take desktop. Tidak ada zoom ke kode, tidak ada tur sidebar.
- [ ] Kartu akhir: `https://github.com/adindamochamad/omnibridge`, path `/hackathon`, dan kalimat *Best Agentic Use-Case*.
- [ ] Audio menyebut shell dan enam tool sebagai yang sudah ada. Yang baru: klien Muse Spark dan commit gate.
- [ ] Dua gladi bersih di jendela Tauri sebelum rekam. Gladi pertama Break CRC nyala sampai Held dan faceplate tetap **—**. Gladi kedua melepas Break CRC sampai Verified **Committed** dan faceplate terisi.

## 4. Kedalaman teknis — bisa diulang orang lain

- [ ] `npm test` lulus. Suite commit gate mencakup CRC rendah, judul tanpa kata Modbus, parser non-Modbus yang regex-nya cocok, dan CRC buffer demo 1.00 vs di bawah 0.90.
- [ ] `npm run check` bersih.
- [ ] `npm run build` lulus sebelum submit.
- [ ] README bagian atas menjelaskan commit gate dan Muse Spark. Diagram dan bagian “Why Opus 4.7” tidak lagi menjadi halaman yang juri baca pertama.
- [ ] Teks yang bisa ikut terekam tidak menyebut Claude atau Opus: About di Settings, “Claude is analyzing”, “Claude is thinking”, dan `longDescription` di `src-tauri/tauri.conf.json`.
- [ ] `docs/HACKATHON_2026.md` tetap memisahkan shell lama dan karya 26 Okt–4 Nov.
- [ ] `origin/main` yang publik berisi file gate (`commit-gate.ts`, `meta-api.ts`, `src/routes/hackathon/+page.svelte`) pada commit yang sama dengan yang direkam.

## 5. Di luar selesai

Tidak dikerjakan untuk submission ini.

- Situs marketing, atau deploy web.
- Repository baru.
- Model Meta kedua (gambar, SAM) yang tidak muncul di kalimat juri.
- Safe Mode, webhook, atau export sebagai adegan video.
- Menghapus riwayat git rilis 0.1.0.

## Urutan yang tersisa

Checkpoint 27 Okt 2026 malam: [HACKATHON_CHECKPOINT.md](./HACKATHON_CHECKPOINT.md). Repo publik `d567052` sudah memuat gate, caption, dan salinan Muse Spark. Claude/Opus di panel yang bisa terekam sudah diganti.

1. Di jendela yang baru dimuat, **Run both lanes** sekali lagi. Tabelnya kosong setelah reload.
2. Simpan take hanya jika Naive menyebut perintah dan Verified menulis `withheld`.
3. Lepas Break CRC di akhir take. Tunggu Verified **Committed** dan faceplate terisi. Readout saat itu **1.00**.
4. Rekam 2:45–3:00. Submit Cerebral Valley sebelum 4 Nov 2026, 21:00 ET (5 Nov 2026, 09:00 WIB).
