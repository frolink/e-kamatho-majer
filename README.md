# E-Kamatho Majer

Pi Testnet Top Up → TransFi Offramp (Pi→IDR) → Saldo Rupiah → Payout Merchant (Transfer Bank/VA, merchant terdaftar).

## Kepatuhan AML: nama akun Pi harus cocok rekening tujuan (saat PENARIKAN)

Pengecekan AML dilakukan **saat menarik dana ke rekening bank pribadi**
(`api/withdraw.js`), BUKAN saat login. Login tetap alur biasa (hanya Pi
access token), tidak ada gate nama di situ.

Alur AML:
- Layar "Tarik ke Rekening Bank" minta 2 nama: **Nama Akun Pi** dan **Nama
  Pemilik Rekening Tujuan**
- `lib/transfiClient.namesMatch()` mencocokkan keduanya (normalisasi huruf
  kecil, buang diakritik/tanda baca, toleransi selisih kata kecil)
- Kalau tidak cocok, permintaan ditolak **sebelum saldo disentuh sama
  sekali** — baik di client (`app.js`, untuk UX instan) maupun di server
  (`api/withdraw.js`, otoritatif — client-side check TIDAK bisa dipercaya
  sepenuhnya karena bisa dilewati)
- `api/merchant.js` (bayar warung/Indomaret) **TIDAK** kena aturan ini —
  itu memang bayar ke pihak ketiga, nama boleh beda

**Jujur soal batasannya:** Pi Platform API publik tidak memberi developer
akses ke nama legal hasil KYC internal Pi Network (hanya `username`). Jadi
"Nama Akun Pi" di form penarikan bersifat self-attested oleh user saat itu
juga — lapis pencocokan identitas yang sesungguhnya (nama vs kepemilikan
rekening bank) tetap dilakukan oleh mesin KYC/compliance TransFi sendiri
saat payout diproses, karena merekalah pihak yang teregulasi untuk itu.
Tanggung jawab kita: (1) tidak pernah mengirim permintaan penarikan kalau
dua nama itu jelas tidak cocok, dan (2) meneruskan `accountHolderName`
yang akurat ke TransFi supaya mesin AML mereka bisa bekerja.

## Efisiensi kuota (free tier)

- `lib/transfiClient.js` — cache kurs (`getExchangeRate`) 30 detik in-memory
- `api/pi.js` — cache saldo Pi (Horizon) 10 detik in-memory
- `app.js` — `refreshBalances()` di-throttle 8 detik, kecuali dipaksa
  (`refreshBalances(true)`) saat login, tombol Sinkron manual, atau
  setelah transaksi selesai
- Saldo Rupiah TIDAK di-polling — hanya diperbarui lewat `api/webhook.js`
  (event-driven), bukan polling berulang ke TransFi

## Struktur Project

```
index.html, style.css, app.js   -> frontend statis (single page)
api/
  auth.js       -> login, verifikasi Pi access token (TIDAK ada gate AML di sini)
  pi.js         -> Tukar ke Rupiah: approve, complete (Pi Platform API), wallet-balance
  transfi.js    -> kurs Pi->IDR & cek status order Offramp (inquiry only)
  merchant.js   -> Bayar Merchant: payout dari saldo Rupiah ke warung/Indomaret (TransFi Payouts)
  withdraw.js   -> Tarik ke rekening bank PRIBADI, WAJIB nama cocok (AML) ← baru
  webhook.js    -> terima webhook TransFi (settle order, payout, & withdrawal)
  wallet.js     -> saldo Rupiah & riwayat transaksi
lib/
  piClient.js     -> wrapper Pi Platform API (HANYA dipakai api/pi.js)
  transfiClient.js-> wrapper TransFi API (dipakai api/pi.js utk create order,
                     api/merchant.js utk payout, api/transfi.js utk quote,
                     api/webhook.js utk verifikasi signature)
  store.js        -> ledger sederhana (file JSON, lihat catatan di bawah)
```

## Alur End-to-End

```
Pi Browser → Pi.createPayment() → Pi Platform API (approve/complete)
    → Pi masuk dompet Pi pribadi user (sudah ada di sana, mis. dari hasil jualan)
    → api/pi.js memanggil transfiClient.createOfframpOrder()
    → TransFi memproses konversi/swap Pi → IDR
    → api/webhook.js menerima konfirmasi settle → saldo Rupiah user bertambah
    → (a) api/merchant.js memotong saldo Rupiah & bayar warung/Indomaret, ATAU
    → (b) api/withdraw.js menarik saldo Rupiah ke rekening bank PRIBADI user,
          dengan syarat nama akun Pi = nama pemilik rekening (AML)
```

Tiga alur (**Tukar ke Rupiah**, **Bayar Merchant**, **Tarik ke Bank**) hanya
bertemu lewat satu angka: saldo Rupiah di `store.js`. `api/merchant.js` dan
`api/withdraw.js` tidak pernah mengimpor `lib/piClient.js`, dan `api/pi.js`
tidak pernah mengimpor logika payout/withdrawal.

## 1. Setup

```bash
npm install
cp .env.example .env
```

Isi `.env`:
- `PI_API_KEY` — Pi Developer Portal → App Dashboard → API Key
- `TRANSFI_USERNAME`, `TRANSFI_PASSWORD` — dari displai.transfi.com → Settings → API Credentials (Sandbox dulu; kredensial sandbox & production terpisah)
- `CORS_ORIGIN` — domain production yang terdaftar di Pi Developer Portal

## 2. Jalankan lokal

```bash
npx vercel dev
```

Buka `http://localhost:3000`. Untuk cek backend hidup: `http://localhost:3000/api/health`.

Untuk cek kredensial TransFi benar (persis "Test your connection" di
dokumentasi mereka): `http://localhost:3000/api/transfi?action=test-connection`
— `{"connected":true,...}` berarti kredensial OK; `401` berarti
`TRANSFI_USERNAME`/`TRANSFI_PASSWORD` salah atau belum aktif di
displai.transfi.com.

## 3. Deploy ke Vercel

1. Push folder ini ke repo GitHub.
2. Import repo di [vercel.com/new](https://vercel.com/new).
3. Isi Environment Variables di dashboard Vercel (isi yang sama seperti `.env`).
4. Deploy. Vercel otomatis mendeteksi folder `api/` sebagai serverless functions.
5. Daftarkan URL production (`https://xxx.vercel.app`) di Pi Developer Portal sebagai App URL.
6. Daftarkan `https://xxx.vercel.app/api/webhook` di dashboard webhook TransFi.

## 4. Sambungkan frontend ke backend asli

Di `app.js`, ubah:
```js
const CONFIG = {
  DEMO_MODE: false // WAJIB false setelah semua env di atas terisi
};
```
`API_BASE: '/api'` sudah relatif, otomatis benar di local dev (`vercel dev`) maupun production karena frontend & API satu domain di Vercel.

## 5. Uji alur end-to-end

1. Buka app dari **Pi Browser**, di URL production yang sudah dikonfirmasi di Pi Developer Portal.
2. Login dengan Pi, lalu Top Up sejumlah kecil Pi Testnet.
3. Cek log Vercel (`vercel logs` atau dashboard) — harus terlihat:
   `/api/pi?action=approve` → `/api/pi?action=complete` → panggilan `transfiClient.createOfframpOrder`.
4. Cek dashboard TransFi Sandbox, order Offramp baru harus muncul berstatus `initiated`.
5. Setelah TransFi memproses (di sandbox biasanya bisa disimulasikan manual dari dashboard mereka), webhook akan masuk ke `/api/webhook` — saldo Rupiah user harus naik.
6. Coba Bayar Merchant — saldo Rupiah berkurang, dan payout baru muncul di dashboard TransFi.

## 6. Catatan produksi & hal yang WAJIB kamu verifikasi sendiri

- **`lib/store.js` pakai file JSON** — cukup untuk demo/testing, TIDAK aman
  untuk trafik nyata di Vercel (serverless tidak punya filesystem
  persisten). Ganti ke database asli (Vercel Postgres/KV, Supabase, dll)
  sebelum go-live.
- **Skema request body `createOfframpOrder()` dan `createPayout()`** di
  `lib/transfiClient.js` disusun mengikuti field yang muncul di skema
  webhook publik TransFi (`orderId`, `depositCurrency`, `withdrawAmount`,
  dst). TransFi punya field tambahan yang wajib tergantung produk & negara
  (mis. `purposeCode`, data KYC/beneficiary, `payerName` untuk EUR). **Cocokkan
  ulang persis dengan "API Reference" di dashboard sandbox TransFi kamu**
  sebelum transaksi sungguhan — jangan asumsikan field di file ini final.
- **Header signature webhook** (`x-transfi-signature` di `api/webhook.js`)
  perlu disesuaikan namanya dengan pengaturan webhook TransFi kamu.
- **Registrasi beneficiary/rekening merchant** biasanya harus dilakukan
  lebih dulu di TransFi (via dashboard atau API "Payment Account
  Configuration") sebelum payout ke rekening itu bisa jalan — data bank/VA
  di `lib/store.js` (`defaultMerchants()`) dan yang diinput lewat "Tambah
  Merchant" masih perlu dicocokkan/didaftarkan ke sistem TransFi kamu.
- **Kenapa TIDAK ada "scan QRIS untuk bayar merchant":** berdasarkan riset
  ke dokumentasi publik TransFi (`docs.transfi.com/docs/qris`), fitur QRIS
  mereka itu untuk **collections** (TransFi membuatkan QR untuk BISNIS kamu
  yang discan PELANGGAN kamu) — bukan untuk membayar keluar dengan men-scan
  QR milik merchant lain. Membayar dengan scan QRIS pihak ketiga (mis.
  Indomaret) butuh lisensi QRIS acquiring/switching yang biasanya cuma
  dipegang bank/PJSP resmi (DANA, OVO, GoPay, atau gateway seperti
  Xendit/Midtrans/DOKU). Karena itu `api/merchant.js` sengaja hanya
  mendukung `bank_transfer`/`virtual_account` — merchant yang mau dibayar
  harus didaftarkan dengan rekening/VA-nya sendiri, bukan discan QR-nya.
- **Data merchant default** (`Indomaret`, `Alfamart`, `PLN`) di
  `defaultMerchants()` dan `demoMerchants` di `app.js` masih **nomor
  rekening/VA contoh** — ganti dengan data hasil kerja sama/pendaftaran
  nyata sebelum dipakai sungguhan.
- **PI_HORIZON_URL** sudah benar untuk testnet; untuk mainnet cek endpoint
  resmi terbaru di Pi Developer Portal.
- Tambahkan session token (JWT) di `api/auth.js` untuk produksi — saat ini
  `uid` dikirim apa adanya dari client demi kesederhanaan demo.
