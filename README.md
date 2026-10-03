# be.tbg

Backend API REST Express.js untuk Sistem Informasi Tabungan Santri Pondok Pesantren Ihyaul Ulum Dukun Gresik. Dilengkapi Supabase Auth, PostgreSQL, RBAC, dan audit trail.

## Perintah

```powershell
npm run dev
npm test
```

Salin `.env.example` ke `.env` hanya bila perlu; `.env` yang sudah dikonfigurasi tetap digunakan. `SUPABASE_SERVICE_ROLE_KEY` hanya dibaca backend dan tidak boleh dikirim ke browser.

## Akun awal development

Bootstrap hanya untuk `NODE_ENV=development`. Tambahkan `INITIAL_SUPER_ADMIN_NAME`, `INITIAL_SUPER_ADMIN_USERNAME`, dan `INITIAL_SUPER_ADMIN_PASSWORD` ke `backend/.env`; password development minimal 8 karakter. Opsional, isi ketiga `INITIAL_ADMIN_*` untuk membuat Admin awal juga. Untuk production, gunakan password yang lebih kuat. Lalu jalankan:

```powershell
npm run bootstrap:development
```

Script menolak membuat Super Admin kedua dan tidak mencetak password. Hapus nilai `INITIAL_*` dari `.env` sesudah bootstrap. Jangan memakai bootstrap ini pada production.

Setelah Super Admin berhasil login, gunakan menu **Registrasi Admin** atau buka `/super-admin/register-admin` untuk membuat akun Admin. Registrasi Admin tidak dibuka ke publik.

API base URL lokal: `http://localhost:4000/api`. Health check: `/health`.
