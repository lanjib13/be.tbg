BEGIN;

-- 1. Bersihkan data yatim (orphans) yang mungkin tersisa dari penghapusan pengguna terdahulu
DELETE FROM public.transactions
WHERE user_id NOT IN (SELECT id FROM public.profiles);

DELETE FROM public.transactions
WHERE savings_id NOT IN (SELECT id FROM public.savings);

DELETE FROM public.savings
WHERE user_id NOT IN (SELECT id FROM public.profiles);

DELETE FROM public.user_profiles
WHERE profile_id NOT IN (SELECT id FROM public.profiles);

-- 2. Ubah foreign key constraint ke ON DELETE CASCADE agar penghapusan profil otomatis membersihkan relasinya
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

-- 3. Perbarui fungsi delete_managed_user agar memvalidasi dan menghapus dengan aman
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

  -- Hapus transaksi, tabungan, dan detail profil
  DELETE FROM public.transactions AS t
    WHERE t.user_id = v_target.id;
  DELETE FROM public.user_profiles AS up
    WHERE up.profile_id = v_target.id;
  DELETE FROM public.savings AS s
    WHERE s.user_id = v_target.id;

  INSERT INTO public.audit_logs (user_id, action, description, ip_address, user_agent)
  VALUES (
    v_actor.id,
    'DELETE_USER',
    format(
      'Admin %s menghapus permanen profile pengguna %s; rekening dan transaksi terkait ikut dihapus.',
      v_actor.username,
      v_target.id
    ),
    p_ip_address,
    p_user_agent
  );

  DELETE FROM public.profiles AS p
    WHERE p.id = v_target.id;

  RETURN QUERY SELECT v_target.auth_user_id, v_target.username;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_managed_user(uuid, uuid, inet, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_managed_user(uuid, uuid, inet, text)
  TO service_role;

COMMIT;
