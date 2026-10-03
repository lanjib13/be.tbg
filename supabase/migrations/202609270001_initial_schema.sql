BEGIN;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL UNIQUE REFERENCES auth.users (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (btrim(name) <> ''),
  username text NOT NULL CHECK (
    username = lower(username)
    AND username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'
  ),
  email text,
  role text NOT NULL CHECK (role IN ('super_admin', 'admin', 'user')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX profiles_username_lower_uidx
  ON public.profiles (lower(username));
CREATE INDEX profiles_role_status_idx
  ON public.profiles (role, status);

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL UNIQUE REFERENCES public.profiles (id) ON DELETE RESTRICT,
  nomor_identitas text NOT NULL UNIQUE CHECK (btrim(nomor_identitas) <> ''),
  no_hp text NOT NULL CHECK (btrim(no_hp) <> ''),
  alamat text NOT NULL CHECK (btrim(alamat) <> ''),
  tanggal_lahir date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.savings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.profiles (id) ON DELETE RESTRICT,
  nomor_rekening text NOT NULL UNIQUE,
  saldo numeric(18, 0) NOT NULL DEFAULT 0 CHECK (saldo >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT savings_id_user_id_unique UNIQUE (id, user_id)
);

CREATE INDEX savings_status_user_id_idx
  ON public.savings (status, user_id);

CREATE TABLE public.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  savings_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE RESTRICT,
  admin_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE RESTRICT,
  transaction_code text NOT NULL UNIQUE,
  type text NOT NULL CHECK (type IN ('deposit', 'withdrawal')),
  amount numeric(18, 0) NOT NULL CHECK (amount > 0),
  balance_before numeric(18, 0) NOT NULL CHECK (balance_before >= 0),
  balance_after numeric(18, 0) NOT NULL CHECK (balance_after >= 0),
  description text NOT NULL DEFAULT '',
  transaction_date timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transactions_savings_owner_fk
    FOREIGN KEY (savings_id, user_id)
    REFERENCES public.savings (id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT transactions_balance_math_check CHECK (
    (type = 'deposit' AND balance_after = balance_before + amount)
    OR (type = 'withdrawal' AND balance_after = balance_before - amount)
  )
);

CREATE INDEX transactions_user_date_idx
  ON public.transactions (user_id, transaction_date DESC);
CREATE INDEX transactions_savings_created_idx
  ON public.transactions (savings_id, created_at DESC);
CREATE INDEX transactions_type_date_idx
  ON public.transactions (type, transaction_date);
CREATE INDEX transactions_admin_date_idx
  ON public.transactions (admin_id, transaction_date DESC);

CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN (
    'CREATE_USER',
    'UPDATE_USER',
    'CREATE_DEPOSIT',
    'CREATE_WITHDRAWAL',
    'RESET_PASSWORD',
    'LOGIN',
    'LOGOUT',
    'DISABLE_USER',
    'CREATE_ADMIN',
    'UPDATE_ADMIN'
  )),
  description text NOT NULL CHECK (btrim(description) <> ''),
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_created_at_idx
  ON public.audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_created_idx
  ON public.audit_logs (user_id, created_at DESC);
CREATE INDEX audit_logs_action_created_idx
  ON public.audit_logs (action, created_at DESC);

CREATE TABLE public.account_number_counters (
  counter_year integer PRIMARY KEY CHECK (counter_year BETWEEN 2000 AND 9999),
  last_value bigint NOT NULL CHECK (last_value > 0)
);

CREATE TABLE public.transaction_day_counters (
  counter_date date PRIMARY KEY,
  last_value bigint NOT NULL CHECK (last_value > 0)
);

CREATE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER user_profiles_set_updated_at
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER savings_set_updated_at
  BEFORE UPDATE ON public.savings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER transactions_set_updated_at
  BEFORE UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE FUNCTION public.assign_account_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_year integer := extract(year FROM timezone('UTC', now()))::integer;
  v_counter bigint;
  v_role text;
  v_status text;
BEGIN
  SELECT p.role, p.status
    INTO v_role, v_status
    FROM public.profiles AS p
    WHERE p.id = NEW.user_id;

  IF v_role IS DISTINCT FROM 'user' OR v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'SAVINGS_OWNER_MUST_BE_ACTIVE_USER' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.account_number_counters AS counter (counter_year, last_value)
  VALUES (v_year, 1)
  ON CONFLICT (counter_year) DO UPDATE
    SET last_value = counter.last_value + 1
  RETURNING last_value INTO v_counter;

  NEW.nomor_rekening := 'TAB-' || v_year::text || '-' || lpad(v_counter::text, 6, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER savings_assign_account_number
  BEFORE INSERT ON public.savings
  FOR EACH ROW EXECUTE FUNCTION public.assign_account_number();

CREATE FUNCTION public.assign_transaction_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_date date := (NEW.transaction_date AT TIME ZONE 'UTC')::date;
  v_counter bigint;
BEGIN
  INSERT INTO public.transaction_day_counters AS counter (counter_date, last_value)
  VALUES (v_date, 1)
  ON CONFLICT (counter_date) DO UPDATE
    SET last_value = counter.last_value + 1
  RETURNING last_value INTO v_counter;

  NEW.transaction_code := 'TRX-'
    || to_char(v_date, 'YYYYMMDD')
    || '-'
    || lpad(v_counter::text, 4, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER transactions_assign_code
  BEFORE INSERT ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.assign_transaction_code();

CREATE FUNCTION public.current_profile_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.id
  FROM public.profiles AS p
  WHERE p.auth_user_id = (SELECT auth.uid())
    AND p.status = 'active'
  LIMIT 1
$$;

CREATE FUNCTION public.current_app_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.role
  FROM public.profiles AS p
  WHERE p.auth_user_id = (SELECT auth.uid())
    AND p.status = 'active'
  LIMIT 1
$$;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.savings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_day_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_select_scoped
  ON public.profiles FOR SELECT TO authenticated
  USING (
    auth_user_id = (SELECT auth.uid())
    OR (SELECT public.current_app_role()) IN ('admin', 'super_admin')
  );

CREATE POLICY user_profiles_select_scoped
  ON public.user_profiles FOR SELECT TO authenticated
  USING (
    profile_id = (SELECT public.current_profile_id())
    OR (SELECT public.current_app_role()) IN ('admin', 'super_admin')
  );

CREATE POLICY savings_select_scoped
  ON public.savings FOR SELECT TO authenticated
  USING (
    user_id = (SELECT public.current_profile_id())
    OR (SELECT public.current_app_role()) IN ('admin', 'super_admin')
  );

CREATE POLICY transactions_select_scoped
  ON public.transactions FOR SELECT TO authenticated
  USING (
    user_id = (SELECT public.current_profile_id())
    OR (SELECT public.current_app_role()) IN ('admin', 'super_admin')
  );

CREATE POLICY audit_logs_super_admin_select
  ON public.audit_logs FOR SELECT TO authenticated
  USING ((SELECT public.current_app_role()) = 'super_admin');

REVOKE ALL ON TABLE
  public.profiles,
  public.user_profiles,
  public.savings,
  public.transactions,
  public.audit_logs,
  public.account_number_counters,
  public.transaction_day_counters
FROM anon, authenticated;

GRANT SELECT ON TABLE
  public.profiles,
  public.user_profiles,
  public.savings,
  public.transactions,
  public.audit_logs
TO authenticated;

GRANT ALL ON TABLE
  public.profiles,
  public.user_profiles,
  public.savings,
  public.transactions,
  public.audit_logs,
  public.account_number_counters,
  public.transaction_day_counters
TO service_role;

REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_account_number() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_transaction_code() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.current_profile_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.current_app_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_profile_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_app_role() TO authenticated, service_role;

CREATE FUNCTION public.record_savings_transaction(
  p_savings_id uuid,
  p_actor_profile_id uuid,
  p_type text,
  p_amount numeric,
  p_description text DEFAULT '',
  p_transaction_date timestamptz DEFAULT now(),
  p_ip_address inet DEFAULT NULL,
  p_user_agent text DEFAULT NULL
)
RETURNS public.transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_savings public.savings%ROWTYPE;
  v_owner public.profiles%ROWTYPE;
  v_actor public.profiles%ROWTYPE;
  v_before numeric(18, 0);
  v_after numeric(18, 0);
  v_transaction public.transactions%ROWTYPE;
  v_action text;
  v_type_label text;
BEGIN
  IF p_type IS NULL OR p_type NOT IN ('deposit', 'withdrawal') THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION_TYPE' USING ERRCODE = '22023';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> trunc(p_amount) THEN
    RAISE EXCEPTION 'AMOUNT_MUST_BE_POSITIVE_WHOLE_RUPIAH' USING ERRCODE = '22023';
  END IF;

  IF p_transaction_date IS NULL THEN
    RAISE EXCEPTION 'TRANSACTION_DATE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT p.*
    INTO v_actor
    FROM public.profiles AS p
    WHERE p.id = p_actor_profile_id
      AND p.role = 'admin'
      AND p.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACTIVE_ADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;

  SELECT s.*
    INTO v_savings
    FROM public.savings AS s
    WHERE s.id = p_savings_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SAVINGS_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_savings.status <> 'active' THEN
    RAISE EXCEPTION 'SAVINGS_INACTIVE' USING ERRCODE = '23514';
  END IF;

  SELECT p.*
    INTO v_owner
    FROM public.profiles AS p
    WHERE p.id = v_savings.user_id;

  IF NOT FOUND OR v_owner.role <> 'user' OR v_owner.status <> 'active' THEN
    RAISE EXCEPTION 'SAVINGS_OWNER_INACTIVE' USING ERRCODE = '23514';
  END IF;

  v_before := v_savings.saldo;
  IF p_type = 'deposit' THEN
    v_after := v_before + p_amount;
    v_action := 'CREATE_DEPOSIT';
    v_type_label := 'setoran';
  ELSE
    IF p_amount > v_before THEN
      RAISE EXCEPTION 'INSUFFICIENT_BALANCE' USING ERRCODE = '23514';
    END IF;
    v_after := v_before - p_amount;
    v_action := 'CREATE_WITHDRAWAL';
    v_type_label := 'penarikan';
  END IF;

  UPDATE public.savings
    SET saldo = v_after
    WHERE id = v_savings.id;

  INSERT INTO public.transactions (
    savings_id,
    user_id,
    admin_id,
    type,
    amount,
    balance_before,
    balance_after,
    description,
    transaction_date
  ) VALUES (
    v_savings.id,
    v_savings.user_id,
    v_actor.id,
    p_type,
    p_amount,
    v_before,
    v_after,
    coalesce(p_description, ''),
    p_transaction_date
  )
  RETURNING * INTO v_transaction;

  INSERT INTO public.audit_logs (
    user_id,
    action,
    description,
    ip_address,
    user_agent
  ) VALUES (
    v_actor.id,
    v_action,
    format(
      'Admin %s melakukan %s Rp%s kepada %s (rekening %s).',
      v_actor.username,
      v_type_label,
      p_amount::text,
      v_owner.name,
      v_savings.nomor_rekening
    ),
    p_ip_address,
    p_user_agent
  );

  RETURN v_transaction;
END;
$$;

REVOKE ALL ON FUNCTION public.record_savings_transaction(
  uuid, uuid, text, numeric, text, timestamptz, inet, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_savings_transaction(
  uuid, uuid, text, numeric, text, timestamptz, inet, text
) TO service_role;

COMMIT;
