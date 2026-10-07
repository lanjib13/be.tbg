# Supabase Database

## Migration awal

`migrations/202609270001_initial_schema.sql` membuat tabel profil, detail pengguna, rekening, transaksi, audit, counter identifier, indeks, constraint, trigger, RLS policies, serta RPC setoran/penarikan atomik.

Migration ini ditujukan untuk Supabase PostgreSQL: memerlukan schema `auth`, fungsi `auth.uid()`, dan role `anon`, `authenticated`, serta `service_role`. Terapkan pada project Supabase lokal/staging terlebih dahulu, lalu jalankan kembali test sebelum production.

Migration lanjutan menambahkan RPC provisioning/update/status (`202609270002_profile_management_rpcs.sql`), agregasi dashboard/laporan (`202609270003_dashboard_report_rpcs.sql`), akses laporan transaksi yang dibatasi untuk user (`202609290001_user_report_access.sql`), dan penghapusan permanen user (`202610070001_permanent_user_delete.sql`). Terapkan semua migration berdasarkan urutan nama file sebelum memakai endpoint DELETE.

Migration telah diuji pada cluster PostgreSQL 14 sementara menggunakan stub `auth` dan role Supabase. Uji mencakup pembuatan nomor rekening/kode, setoran, penarikan, saldo kurang (tanpa perubahan parsial), pencatatan audit, cakupan SELECT RLS, isolasi laporan user, hard-delete seluruh data user, handoff ID Auth, audit penghapusan yang tetap tersimpan, dan penolakan target non-user. Pengujian tersebut belum menggantikan verifikasi pada Supabase lokal/staging.

Bila menggunakan `psql` dan connection string Supabase:

```powershell
Get-ChildItem backend/supabase/migrations/*.sql | Sort-Object Name | ForEach-Object {
	psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f $_.FullName
	if ($LASTEXITCODE -ne 0) { throw "Migration failed: $($_.Name)" }
}
```

Alternatifnya, jalankan isi migration melalui Supabase SQL Editor. Migration membungkus perubahan dengan `BEGIN`/`COMMIT`; jika gagal, perubahan SQL dibatalkan. Jangan menjalankan ulang migration yang sudah berhasil. Hard-delete user bersifat permanen dan menghapus transaksi/rekening; audit event penghapusan tetap dipertahankan.

## Kebijakan akses

Browser hanya diberi hak `SELECT` yang dibatasi RLS. Mutasi aplikasi dilakukan melalui Express setelah validasi dan pemeriksaan role. `record_savings_transaction` hanya dapat dieksekusi oleh `service_role`; backend wajib mengambil `p_actor_profile_id` dari session tervalidasi, bukan dari body request. Jangan menaruh service role key di frontend.

Counter nomor rekening dan nomor transaksi diubah dengan `INSERT ... ON CONFLICT DO UPDATE` di dalam trigger, sehingga generator aman terhadap request yang berjalan bersamaan. Function transaksi mengunci satu baris rekening dengan `FOR UPDATE`; pembaruan saldo, transaksi, dan audit berada dalam satu transaksi PostgreSQL. Hard-delete user menghapus transaksi/rekening/detail/profile dalam satu transaksi DB; setelah RPC sukses Express menghapus Auth user. Jika pembersihan Auth gagal, API melaporkan kegagalan parsial untuk rekonsiliasi.
