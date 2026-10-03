BEGIN;

CREATE FUNCTION public.provision_managed_profile(
  p_actor_profile_id uuid,
  p_auth_user_id uuid,
  p_name text,
  p_username text,
  p_email text DEFAULT NULL,
  p_role text DEFAULT 'user',
  p_nomor_identitas text DEFAULT NULL,
  p_no_hp text DEFAULT NULL,
  p_alamat text DEFAULT NULL,
  p_tanggal_lahir date DEFAULT NULL,
  p_ip_address inet DEFAULT NULL,
  p_user_agent text DEFAULT NULL
)
RETURNS TABLE (profile_id uuid, savings_id uuid, nomor_rekening text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor public.profiles%ROWTYPE;
  v_profile_id uuid;
  v_savings_id uuid;
  v_nomor_rekening text;
  v_action text;
BEGIN
  SELECT p.*
    INTO v_actor
    FROM public.profiles AS p
    WHERE p.id = p_actor_profile_id
      AND p.status = 'active'
      AND p.role IN ('super_admin', 'admin');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACTIVE_ADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF p_role NOT IN ('user', 'admin')
    OR (p_role = 'admin' AND v_actor.role <> 'super_admin') THEN
    RAISE EXCEPTION 'ROLE_CANNOT_BE_PROVISIONED' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = p_auth_user_id) THEN
    RAISE EXCEPTION 'AUTH_USER_NOT_FOUND' USING ERRCODE = '23503';
  END IF;

  IF p_role = 'user'
    AND (p_nomor_identitas IS NULL OR p_no_hp IS NULL OR p_alamat IS NULL) THEN
    RAISE EXCEPTION 'USER_DETAILS_REQUIRED' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.profiles (auth_user_id, name, username, email, role)
  VALUES (p_auth_user_id, p_name, lower(p_username), p_email, p_role)
  RETURNING id INTO v_profile_id;

  IF p_role = 'user' THEN
    INSERT INTO public.user_profiles (
      profile_id,
      nomor_identitas,
      no_hp,
      alamat,
      tanggal_lahir
    ) VALUES (
      v_profile_id,
      p_nomor_identitas,
      p_no_hp,
      p_alamat,
      p_tanggal_lahir
    );

    INSERT INTO public.savings (user_id)
    VALUES (v_profile_id)
    RETURNING id, public.savings.nomor_rekening
    INTO v_savings_id, v_nomor_rekening;

    v_action := 'CREATE_USER';
  ELSE
    v_action := 'CREATE_ADMIN';
  END IF;

  INSERT INTO public.audit_logs (user_id, action, description, ip_address, user_agent)
  VALUES (
    v_actor.id,
    v_action,
    format('Admin %s membuat akun %s %s (%s).', v_actor.username, p_role, p_name, lower(p_username)),
    p_ip_address,
    p_user_agent
  );

  RETURN QUERY SELECT v_profile_id, v_savings_id, v_nomor_rekening;
END;
$$;

CREATE FUNCTION public.update_managed_profile(
  p_actor_profile_id uuid,
  p_target_profile_id uuid,
  p_name text,
  p_username text,
  p_email text DEFAULT NULL,
  p_nomor_identitas text DEFAULT NULL,
  p_no_hp text DEFAULT NULL,
  p_alamat text DEFAULT NULL,
  p_tanggal_lahir date DEFAULT NULL,
  p_ip_address inet DEFAULT NULL,
  p_user_agent text DEFAULT NULL
)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor public.profiles%ROWTYPE;
  v_target public.profiles%ROWTYPE;
  v_updated public.profiles%ROWTYPE;
  v_action text;
BEGIN
  SELECT p.* INTO v_actor
  FROM public.profiles AS p
  WHERE p.id = p_actor_profile_id
    AND p.status = 'active'
    AND p.role IN ('admin', 'super_admin');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACTIVE_ADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;

  SELECT p.* INTO v_target
  FROM public.profiles AS p
  WHERE p.id = p_target_profile_id
  FOR UPDATE;

  IF NOT FOUND OR v_target.role = 'super_admin' THEN
    RAISE EXCEPTION 'MANAGED_PROFILE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF (v_target.role = 'admin' AND v_actor.role <> 'super_admin')
    OR (v_target.role = 'user' AND v_actor.role NOT IN ('admin', 'super_admin')) THEN
    RAISE EXCEPTION 'PROFILE_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF v_target.role = 'user'
    AND (p_nomor_identitas IS NULL OR p_no_hp IS NULL OR p_alamat IS NULL) THEN
    RAISE EXCEPTION 'USER_DETAILS_REQUIRED' USING ERRCODE = '22023';
  END IF;

  UPDATE public.profiles
  SET name = p_name,
      username = lower(p_username),
      email = p_email
  WHERE id = p_target_profile_id
  RETURNING * INTO v_updated;

  IF v_target.role = 'user' THEN
    UPDATE public.user_profiles
    SET nomor_identitas = p_nomor_identitas,
        no_hp = p_no_hp,
        alamat = p_alamat,
        tanggal_lahir = p_tanggal_lahir
    WHERE profile_id = p_target_profile_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'USER_DETAILS_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  v_action := CASE WHEN v_target.role = 'admin' THEN 'UPDATE_ADMIN' ELSE 'UPDATE_USER' END;
  INSERT INTO public.audit_logs (user_id, action, description, ip_address, user_agent)
  VALUES (
    v_actor.id,
    v_action,
    format('Admin %s memperbarui akun %s (%s).', v_actor.username, v_updated.name, v_updated.username),
    p_ip_address,
    p_user_agent
  );

  RETURN v_updated;
END;
$$;

CREATE FUNCTION public.set_managed_profile_status(
  p_actor_profile_id uuid,
  p_target_profile_id uuid,
  p_status text,
  p_ip_address inet DEFAULT NULL,
  p_user_agent text DEFAULT NULL
)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor public.profiles%ROWTYPE;
  v_target public.profiles%ROWTYPE;
  v_updated public.profiles%ROWTYPE;
  v_action text;
BEGIN
  IF p_status NOT IN ('active', 'inactive') THEN
    RAISE EXCEPTION 'INVALID_PROFILE_STATUS' USING ERRCODE = '22023';
  END IF;

  SELECT p.* INTO v_actor
  FROM public.profiles AS p
  WHERE p.id = p_actor_profile_id
    AND p.status = 'active'
    AND p.role IN ('admin', 'super_admin');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACTIVE_ADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;

  SELECT p.* INTO v_target
  FROM public.profiles AS p
  WHERE p.id = p_target_profile_id
  FOR UPDATE;

  IF NOT FOUND OR v_target.role = 'super_admin' THEN
    RAISE EXCEPTION 'MANAGED_PROFILE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF (v_target.role = 'admin' AND v_actor.role <> 'super_admin')
    OR (v_target.role = 'user' AND v_actor.role NOT IN ('admin', 'super_admin')) THEN
    RAISE EXCEPTION 'PROFILE_STATUS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF v_target.id = v_actor.id AND p_status = 'inactive' THEN
    RAISE EXCEPTION 'CANNOT_DISABLE_SELF' USING ERRCODE = '23514';
  END IF;

  UPDATE public.profiles
  SET status = p_status
  WHERE id = p_target_profile_id
  RETURNING * INTO v_updated;

  IF v_target.role = 'user' THEN
    UPDATE public.savings
    SET status = p_status
    WHERE user_id = p_target_profile_id;
  END IF;

  v_action := CASE
    WHEN p_status = 'inactive' AND v_target.role = 'user' THEN 'DISABLE_USER'
    WHEN v_target.role = 'admin' THEN 'UPDATE_ADMIN'
    ELSE 'UPDATE_USER'
  END;
  INSERT INTO public.audit_logs (user_id, action, description, ip_address, user_agent)
  VALUES (
    v_actor.id,
    v_action,
    format('Admin %s mengubah status akun %s (%s) menjadi %s.', v_actor.username, v_updated.name, v_updated.username, p_status),
    p_ip_address,
    p_user_agent
  );

  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.provision_managed_profile(
  uuid, uuid, text, text, text, text, text, text, text, date, inet, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_managed_profile(
  uuid, uuid, text, text, text, text, text, text, date, inet, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_managed_profile_status(
  uuid, uuid, text, inet, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.provision_managed_profile(
  uuid, uuid, text, text, text, text, text, text, text, date, inet, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_managed_profile(
  uuid, uuid, text, text, text, text, text, text, date, inet, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_managed_profile_status(
  uuid, uuid, text, inet, text
) TO service_role;

COMMIT;
