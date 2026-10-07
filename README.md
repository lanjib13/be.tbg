# be.tbg

Backend API REST Express.js untuk Sistem Informasi Tabungan Santri Pondok Pesantren Ihyaul Ulum Dukun Gresik. Dilengkapi Supabase Auth, PostgreSQL, RBAC, dan audit trail.

## Perintah

```powershell
npm run dev
npm test
```

Salin `.env.example` ke `.env` hanya bila perlu; `.env` yang sudah dikonfigurasi tetap digunakan. `SUPABASE_SERVICE_ROLE_KEY` hanya dibaca backend dan tidak boleh dikirim ke browser.



API base URL lokal: `http://localhost:4000/api`. Health check: `/health`.

DELETE pengguna bersifat permanen: setelah konfirmasi, RPC menghapus profil, detail, rekening/saldo, dan transaksi serta mencatat audit `DELETE_USER`; backend kemudian menghapus akun Supabase Auth. Operasi tidak dapat dibatalkan. Pastikan migration `202610070001_permanent_user_delete.sql` sudah diterapkan ke Supabase sebelum memakai aksi ini.
