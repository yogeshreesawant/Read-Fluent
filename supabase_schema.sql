-- ============================================================================
-- READ FLUENT — COMPLETE SUPABASE DATABASE & STORAGE SCHEMA
-- Run this entire script in your Supabase SQL Editor (Dashboard -> SQL Editor)
-- ============================================================================

-- 1. Enable pgcrypto for password hashing and UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 2. PUBLIC PROFILES TABLE
-- Stores user profile data and role ('user' or 'admin')
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT DEFAULT '',
  avatar_url TEXT DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for quick role and email lookups
CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(lower(email));

-- ============================================================================
-- 3. USER DOCUMENTS TABLE
-- Stores user-wise saved reading documents, audio bookmarks, and file attachments
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.documents (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  file_url TEXT,
  file_name TEXT,
  file_size BIGINT DEFAULT 0,
  word_count INTEGER DEFAULT 0,
  char_count INTEGER DEFAULT 0,
  progress_percent NUMERIC(5, 2) DEFAULT 0,
  active_sentence_index INTEGER DEFAULT 0,
  speed NUMERIC(3, 2) DEFAULT 1.0,
  voice_name TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique index to prevent duplicate file names per user (case-insensitive & trimmed)
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_user_title_unique 
  ON public.documents (user_id, lower(trim(title)));

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_documents_user_id ON public.documents(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON public.documents(updated_at DESC);

-- ============================================================================
-- 4. ROW LEVEL SECURITY (RLS) & HELPER FUNCTIONS
-- Ensures strict user-wise isolation and grants admin oversight
-- ============================================================================

-- Helper: Security definer function to check if current user is an admin.
-- Running with SECURITY DEFINER bypasses RLS and prevents infinite recursion!
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COALESCE(
    (SELECT role = 'admin' FROM public.profiles WHERE id = auth.uid()),
    false
  );
$$;

-- Helper: Security definer function to get the current user's profile safely.
CREATE OR REPLACE FUNCTION public.get_my_profile()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_rec RECORD;
BEGIN
  SELECT id, email, full_name, avatar_url, role, created_at, updated_at
  INTO v_rec
  FROM public.profiles
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RETURN json_build_object(
      'id', auth.uid(),
      'email', auth.jwt() ->> 'email',
      'role', 'user'
    );
  END IF;

  RETURN row_to_json(v_rec);
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.get_my_profile() TO authenticated, anon;

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

-- --- Profiles RLS Policies ---
DROP POLICY IF EXISTS "Users can view own profile or admins view all" ON public.profiles;
CREATE POLICY "Users can view own profile or admins view all"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (
    auth.uid() = id OR public.is_admin()
  );

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- --- Documents RLS Policies ---
DROP POLICY IF EXISTS "Users can select own documents or admins select all" ON public.documents;
CREATE POLICY "Users can select own documents or admins select all"
  ON public.documents FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id OR public.is_admin()
  );

DROP POLICY IF EXISTS "Users can insert own documents" ON public.documents;
CREATE POLICY "Users can insert own documents"
  ON public.documents FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own documents" ON public.documents;
CREATE POLICY "Users can update own documents"
  ON public.documents FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own documents or admins delete any" ON public.documents;
CREATE POLICY "Users can delete own documents or admins delete any"
  ON public.documents FOR DELETE
  TO authenticated
  USING (
    auth.uid() = user_id OR public.is_admin()
  );

-- ============================================================================
-- 5. TRIGGER: AUTOMATIC PROFILE CREATION ON USER SIGNUP
-- ============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role, created_at, updated_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'role', 'user'),
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE
  SET 
    email = EXCLUDED.email,
    full_name = CASE WHEN EXCLUDED.full_name <> '' THEN EXCLUDED.full_name ELSE public.profiles.full_name END,
    updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- 6. STORAGE BUCKET CONFIGURATION (USER-WISE FILES)
-- ============================================================================
-- Create bucket for uploaded documents if not exists
INSERT INTO storage.buckets (id, name, public)
VALUES ('user_documents', 'user_documents', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Policy: Users can upload files into their user folder: <user_id>/*
DROP POLICY IF EXISTS "Users can upload their own files" ON storage.objects;
CREATE POLICY "Users can upload their own files"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'user_documents' 
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Policy: Users can view their own files or admins view all
DROP POLICY IF EXISTS "Users can view their own files" ON storage.objects;
CREATE POLICY "Users can view their own files"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'user_documents'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR public.is_admin()
    )
  );

-- Policy: Users can delete their own files or admins delete any
DROP POLICY IF EXISTS "Users can delete their own files" ON storage.objects;
CREATE POLICY "Users can delete their own files"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'user_documents'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR public.is_admin()
    )
  );

-- ============================================================================
-- 7. ADMIN RPC FUNCTIONS (SECURITY DEFINER)
-- Allows administrators to manage users safely from the admin dashboard
-- ============================================================================

-- A. List all users with statistics
CREATE OR REPLACE FUNCTION public.admin_list_users()
RETURNS TABLE (
  id UUID,
  email TEXT,
  full_name TEXT,
  role TEXT,
  created_at TIMESTAMPTZ,
  last_sign_in_at TIMESTAMPTZ,
  document_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  -- Verify caller is an admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied. Administrator privileges required.';
  END IF;

  RETURN QUERY
  SELECT 
    p.id,
    p.email,
    p.full_name,
    p.role,
    p.created_at,
    u.last_sign_in_at,
    COUNT(d.id)::BIGINT AS document_count
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  LEFT JOIN public.documents d ON d.user_id = p.id
  GROUP BY p.id, p.email, p.full_name, p.role, p.created_at, u.last_sign_in_at
  ORDER BY p.created_at DESC;
END;
$$;

-- B. Create a new user (with password, email, and role)
CREATE OR REPLACE FUNCTION public.admin_create_user(
  p_email TEXT,
  p_password TEXT,
  p_full_name TEXT DEFAULT '',
  p_role TEXT DEFAULT 'user'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_new_id UUID;
  v_encrypted_pw TEXT;
  v_result JSONB;
BEGIN
  -- Verify caller is an admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied. Administrator privileges required.';
  END IF;

  -- Validate inputs
  IF p_email IS NULL OR trim(p_email) = '' THEN
    RAISE EXCEPTION 'Email cannot be blank.';
  END IF;
  IF p_password IS NULL OR length(p_password) < 6 THEN
    RAISE EXCEPTION 'Password must be at least 6 characters long.';
  END IF;
  IF p_role NOT IN ('user', 'admin') THEN
    RAISE EXCEPTION 'Role must be either "user" or "admin".';
  END IF;

  -- Check if email already exists
  IF EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = lower(trim(p_email))) THEN
    RAISE EXCEPTION 'A user with email "%" already exists.', trim(p_email);
  END IF;

  v_new_id := gen_random_uuid();
  v_encrypted_pw := crypt(p_password, gen_salt('bf'));

  -- Insert into Supabase Auth users
  INSERT INTO auth.users (
    id,
    instance_id,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    role,
    aud
  ) VALUES (
    v_new_id,
    '00000000-0000-0000-0000-000000000000',
    lower(trim(p_email)),
    v_encrypted_pw,
    now(),
    jsonb_build_object('provider', 'email', 'providers', array['email']),
    jsonb_build_object('full_name', p_full_name, 'role', p_role),
    now(),
    now(),
    'authenticated',
    'authenticated'
  );

  -- Insert/update profile
  INSERT INTO public.profiles (id, email, full_name, role, created_at, updated_at)
  VALUES (v_new_id, lower(trim(p_email)), p_full_name, p_role, now(), now())
  ON CONFLICT (id) DO UPDATE
  SET 
    full_name = p_full_name,
    role = p_role,
    updated_at = now();

  SELECT jsonb_build_object(
    'id', v_new_id,
    'email', lower(trim(p_email)),
    'full_name', p_full_name,
    'role', p_role,
    'created_at', now()
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- C. Delete user by ID (cascades to profile and documents)
CREATE OR REPLACE FUNCTION public.admin_delete_user(target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  -- Verify caller is an admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied. Administrator privileges required.';
  END IF;

  -- Protect current admin from deleting themselves
  IF target_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Admins cannot delete their own account from the dashboard.';
  END IF;

  -- Delete from auth.users (cascades to public.profiles & public.documents)
  DELETE FROM auth.users WHERE id = target_user_id;

  RETURN true;
END;
$$;

-- D. Update user role (promote to admin or demote to user)
CREATE OR REPLACE FUNCTION public.admin_update_user_role(target_user_id UUID, new_role TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  -- Verify caller is an admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied. Administrator privileges required.';
  END IF;

  IF new_role NOT IN ('user', 'admin') THEN
    RAISE EXCEPTION 'Role must be either "user" or "admin".';
  END IF;

  -- Protect last admin or self-demotion if desired
  IF target_user_id = auth.uid() AND new_role = 'user' THEN
    RAISE EXCEPTION 'You cannot remove your own admin privileges.';
  END IF;

  UPDATE public.profiles
  SET role = new_role, updated_at = now()
  WHERE id = target_user_id;

  RETURN true;
END;
$$;

-- E. Inspect documents saved by a specific user (admin inspection)
CREATE OR REPLACE FUNCTION public.admin_get_user_documents(target_user_id UUID)
RETURNS TABLE (
  id TEXT,
  user_id UUID,
  title TEXT,
  word_count INTEGER,
  char_count INTEGER,
  progress_percent NUMERIC,
  file_url TEXT,
  file_name TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  -- Verify caller is an admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied. Administrator privileges required.';
  END IF;

  RETURN QUERY
  SELECT 
    d.id,
    d.user_id,
    d.title,
    d.word_count,
    d.char_count,
    d.progress_percent,
    d.file_url,
    d.file_name,
    d.created_at,
    d.updated_at
  FROM public.documents d
  WHERE d.user_id = target_user_id
  ORDER BY d.updated_at DESC;
END;
$$;

-- ============================================================================
-- 8. HELPER: DESIGNATE YOUR FIRST ADMIN ACCOUNT
-- Replace 'admin@example.com' with the email you signed up with in the app:
-- 
-- UPDATE public.profiles 
-- SET role = 'admin' 
-- WHERE email = 'admin@example.com';
-- ============================================================================

