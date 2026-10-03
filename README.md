# be.tbg

Backend API REST Express.js untuk Sistem Informasi Tabungan Santri Pondok Pesantren Ihyaul Ulum Dukun Gresik. Dilengkapi Supabase Auth, PostgreSQL, RBAC, dan audit trail.

## Perintah

```powershell
npm run dev
npm test
```

Salin `.env.example` ke `.env` hanya bila perlu; `.env` yang sudah dikonfigurasi tetap digunakan. `SUPABASE_SERVICE_ROLE_KEY` hanya dibaca backend dan tidak boleh dikirim ke browser.



API base URL lokal: `http://localhost:4000/api`. Health check: `/health`.
