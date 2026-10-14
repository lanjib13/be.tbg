BEGIN;

-- ============================================================================
-- 1. Bersihkan data yatim (orphans) yang mungkin tersisa dari operasi terdahulu
-- ============================================================================
DELETE FROM public.transactions
WHERE user_id NOT IN (SELECT id FROM public.profiles);

DELETE FROM public.transactions
WHERE savings_id NOT IN (SELECT id FROM public.savings);

DELETE FROM public.savings
WHERE user_id NOT IN (SELECT id FROM public.profiles);

DELETE FROM public.user_profiles
WHERE profile_id NOT IN (SELECT id FROM public.profiles);

-- ============================================================================
-- 2. Foreign Key profiles.auth_user_id -> auth.users(id) ON DELETE CASCADE
--    Jika akun dihapus dari Supabase Auth, profiles otomatis ikut terhapus.
-- ============================================================================
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_auth_user_id_fkey,
  ADD CONSTRAINT profiles_auth_user_id_fkey
    FOREIGN KEY (auth_user_id) REFERENCES auth.users (id) ON DELETE CASCADE;

-- ============================================================================
-- 3. Foreign Key relasi anak dari profiles -> ON DELETE CASCADE
--    Jika profil dihapus, seluruh data diri, rekening, dan transaksi otomatis terhapus.
-- ============================================================================
ALTER TABLE public.user_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_profile_id_fkey,
  ADD CONSTRAINT user_profiles_profile_id_fkey
    FOREIGN KEY (profile_id) REFERENCES public.profiles (id) ON DELETE CASCADE;

ALTER TABLE public.savings
  DROP CONSTRAINT IF EXISTS savings_user_id_fkey,
  ADD CONSTRAINT savings_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.profiles (id) ON DELETE CASCADE;

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_user_id_fkey,
  ADD CONSTRAINT transactions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.profiles (id) ON DELETE CASCADE;

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_savings_owner_fk,
  ADD CONSTRAINT transactions_savings_owner_fk
    FOREIGN KEY (savings_id, user_id) REFERENCES public.savings (id, user_id) ON DELETE CASCADE;

-- ============================================================================
-- 4. Pengelolaan admin_id pada transactions:
--    Bila Admin pencatat transaksi dihapus, riwayat transaksi TIDAK ikut hilang,
--    namun admin_id di-set NULL (ON DELETE SET NULL).
-- ============================================================================
ALTER TABLE public.transactions
  ALTER COLUMN admin_id DROP NOT NULL;

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_admin_id_fkey,
  ADD CONSTRAINT transactions_admin_id_fkey
    FOREIGN KEY (admin_id) REFERENCES public.profiles (id) ON DELETE SET NULL;

-- ============================================================================
-- 5. Trigger dua arah: Jika baris pada public.profiles dihapus
--    (misalnya langsung melalui Table Editor Supabase atau RPC),
--    otomatis hapus juga akun di auth.users agar sinkron dan bersih total.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.handle_deleted_profile_cleanup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM auth.users WHERE id = OLD.auth_user_id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS on_profile_deleted_cleanup ON public.profiles;
CREATE TRIGGER on_profile_deleted_cleanup
  AFTER DELETE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_deleted_profile_cleanup();

-- ============================================================================
-- 6. Perbarui RPC delete_managed_user untuk penghapusan Pengguna (role: user)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.delete_managed_user(
  p_actor_profile_id uuid,
  p_target_profile_id uuid,
  p_ip_address inet DEFAULT NULL,
  p_user_agent text DEFAULT NULL
)
RETURNS TABLE (auth_user_id uuid, username text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor public.profiles%ROWTYPE;
  v_target public.profiles%ROWTYPE;
  v_target_auth_user_id uuid;
  v_target_username text;
  v_target_name text;
BEGIN
  SELECT p.*
    INTO v_actor
    FROM public.profiles AS p
    WHERE p.id = p_actor_profile_id
      AND p.status = 'active'
      AND p.role IN ('admin', 'super_admin');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACTIVE_ADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;

  SELECT p.*
    INTO v_target
    FROM public.profiles AS p
    WHERE p.id = p_target_profile_id
      AND p.role = 'user'
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANAGED_USER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  v_target_auth_user_id := v_target.auth_user_id;
  v_target_username := v_target.username;
  v_target_name := v_target.name;

  -- 1. Catat audit log terlebih dahulu
  INSERT INTO public.audit_logs (user_id, action, description, ip_address, user_agent)
  VALUES (
    v_actor.id,
    'DELETE_USER',
    format(
      'Admin %s menghapus permanen pengguna %s (%s); rekening, saldo, transaksi, dan akun login terkait ikut dihapus bersih.',
      v_actor.username,
      v_target_name,
      v_target_username
    ),
    p_ip_address,
    p_user_agent
  );

  -- 2. Hapus profil: CASCADE otomatis menghapus user_profiles, savings, dan transactions.
  --    Trigger on_profile_deleted_cleanup otomatis menghapus akun di auth.users.
  DELETE FROM public.profiles WHERE id = v_target.id;

  -- 3. Jaga-jaga pastikan auth.users juga terhapus jika belum dihapus trigger
  DELETE FROM auth.users WHERE id = v_target_auth_user_id;

  RETURN QUERY SELECT v_target_auth_user_id, v_target_username;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_managed_user(uuid, uuid, inet, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_managed_user(uuid, uuid, inet, text)
  TO service_role;

-- ============================================================================
-- 7. Tambahkan RPC delete_managed_admin untuk penghapusan Admin (role: admin)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.delete_managed_admin(
  p_actor_profile_id uuid,
  p_target_profile_id uuid,
  p_ip_address inet DEFAULT NULL,
  p_user_agent text DEFAULT NULL
)
RETURNS TABLE (auth_user_id uuid, username text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor public.profiles%ROWTYPE;
  v_target public.profiles%ROWTYPE;
  v_target_auth_user_id uuid;
  v_target_username text;
  v_target_name text;
BEGIN
  SELECT p.*
    INTO v_actor
    FROM public.profiles AS p
    WHERE p.id = p_actor_profile_id
      AND p.status = 'active'
      AND p.role = 'super_admin';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUPER_ADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;

  SELECT p.*
    INTO v_target
    FROM public.profiles AS p
    WHERE p.id = p_target_profile_id
      AND p.role = 'admin'
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANAGED_ADMIN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  v_target_auth_user_id := v_target.auth_user_id;
  v_target_username := v_target.username;
  v_target_name := v_target.name;

  -- Set transaksi yang dibuat oleh admin ini agar admin_id-nya null (keuangan tetap tercatat)
  UPDATE public.transactions
    SET admin_id = NULL
    WHERE admin_id = v_target.id;

  INSERT INTO public.audit_logs (user_id, action, description, ip_address, user_agent)
  VALUES (
    v_actor.id,
    'DELETE_ADMIN',
    format(
      'Super Admin %s menghapus permanen Admin %s (%s).',
      v_actor.username,
      v_target_name,
      v_target_username
    ),
    p_ip_address,
    p_user_agent
  );

  DELETE FROM public.profiles WHERE id = v_target.id;
  DELETE FROM auth.users WHERE id = v_target_auth_user_id;

  RETURN QUERY SELECT v_target_auth_user_id, v_target_username;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_managed_admin(uuid, uuid, inet, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_managed_admin(uuid, uuid, inet, text)
  TO service_role;

COMMIT;
