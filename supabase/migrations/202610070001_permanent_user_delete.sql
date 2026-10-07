BEGIN;

ALTER TABLE public.audit_logs
  DROP CONSTRAINT audit_logs_action_check;

ALTER TABLE public.audit_logs
  ADD CONSTRAINT audit_logs_action_check CHECK (action IN (
    'CREATE_USER',
    'UPDATE_USER',
    'CREATE_DEPOSIT',
    'CREATE_WITHDRAWAL',
    'RESET_PASSWORD',
    'LOGIN',
    'LOGOUT',
    'DISABLE_USER',
    'CREATE_ADMIN',
    'UPDATE_ADMIN',
    'DELETE_USER'
  ));

CREATE FUNCTION public.delete_managed_user(
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
