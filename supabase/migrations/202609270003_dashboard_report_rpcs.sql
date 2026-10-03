BEGIN;

CREATE FUNCTION public.get_dashboard_summary(p_actor_profile_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor public.profiles%ROWTYPE;
  v_today_start timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_today_end timestamptz := v_today_start + interval '1 day';
  v_result jsonb;
BEGIN
  SELECT p.* INTO v_actor
  FROM public.profiles AS p
  WHERE p.id = p_actor_profile_id
    AND p.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACTIVE_PROFILE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF v_actor.role = 'user' THEN
    SELECT jsonb_build_object(
      'totalSavings', coalesce((SELECT sum(s.saldo) FROM public.savings AS s WHERE s.user_id = v_actor.id), 0),
      'totalDeposits', coalesce((SELECT sum(t.amount) FROM public.transactions AS t WHERE t.user_id = v_actor.id AND t.type = 'deposit'), 0),
      'totalWithdrawals', coalesce((SELECT sum(t.amount) FROM public.transactions AS t WHERE t.user_id = v_actor.id AND t.type = 'withdrawal'), 0),
      'transactionCount', (SELECT count(*) FROM public.transactions AS t WHERE t.user_id = v_actor.id)
    ) INTO v_result;
    RETURN v_result;
  END IF;

  IF v_actor.role = 'admin' THEN
    SELECT jsonb_build_object(
      'totalUsers', (SELECT count(*) FROM public.profiles AS p WHERE p.role = 'user'),
      'totalSavings', coalesce((SELECT sum(s.saldo) FROM public.savings AS s), 0),
      'totalDeposits', coalesce((SELECT sum(t.amount) FROM public.transactions AS t WHERE t.type = 'deposit'), 0),
      'totalWithdrawals', coalesce((SELECT sum(t.amount) FROM public.transactions AS t WHERE t.type = 'withdrawal'), 0),
      'transactionsToday', (SELECT count(*) FROM public.transactions AS t WHERE t.transaction_date >= v_today_start AND t.transaction_date < v_today_end)
    ) INTO v_result;
    RETURN v_result;
  END IF;

  IF v_actor.role = 'super_admin' THEN
    SELECT jsonb_build_object(
      'totalAdmins', (SELECT count(*) FROM public.profiles AS p WHERE p.role = 'admin'),
      'totalUsers', (SELECT count(*) FROM public.profiles AS p WHERE p.role = 'user'),
      'totalSavings', coalesce((SELECT sum(s.saldo) FROM public.savings AS s), 0),
      'totalDeposits', coalesce((SELECT sum(t.amount) FROM public.transactions AS t WHERE t.type = 'deposit'), 0),
      'totalWithdrawals', coalesce((SELECT sum(t.amount) FROM public.transactions AS t WHERE t.type = 'withdrawal'), 0),
      'totalTransactions', (SELECT count(*) FROM public.transactions AS t)
    ) INTO v_result;
    RETURN v_result;
  END IF;

  RAISE EXCEPTION 'UNSUPPORTED_PROFILE_ROLE' USING ERRCODE = '42501';
END;
$$;

CREATE FUNCTION public.get_transaction_report_summary(
  p_actor_profile_id uuid,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_type text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor public.profiles%ROWTYPE;
  v_result jsonb;
BEGIN
  SELECT p.* INTO v_actor
  FROM public.profiles AS p
  WHERE p.id = p_actor_profile_id
    AND p.status = 'active'
    AND p.role IN ('admin', 'super_admin');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REPORT_ACCESS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'INVALID_REPORT_DATE_RANGE' USING ERRCODE = '22023';
  END IF;

  IF p_type IS NOT NULL AND p_type NOT IN ('deposit', 'withdrawal') THEN
    RAISE EXCEPTION 'INVALID_REPORT_TYPE' USING ERRCODE = '22023';
  END IF;

  IF p_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.profiles AS p WHERE p.id = p_user_id AND p.role = 'user'
  ) THEN
    RAISE EXCEPTION 'REPORT_USER_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_build_object(
    'totalDeposits', coalesce(sum(t.amount) FILTER (WHERE t.type = 'deposit'), 0),
    'totalWithdrawals', coalesce(sum(t.amount) FILTER (WHERE t.type = 'withdrawal'), 0),
    'totalTransactions', count(t.id)
  ) INTO v_result
  FROM public.transactions AS t
  WHERE (p_from IS NULL OR t.transaction_date >= p_from)
    AND (p_to IS NULL OR t.transaction_date <= p_to)
    AND (p_user_id IS NULL OR t.user_id = p_user_id)
    AND (p_type IS NULL OR t.type = p_type);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_dashboard_summary(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_transaction_report_summary(uuid, timestamptz, timestamptz, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_dashboard_summary(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_transaction_report_summary(uuid, timestamptz, timestamptz, uuid, text) TO service_role;

COMMIT;
