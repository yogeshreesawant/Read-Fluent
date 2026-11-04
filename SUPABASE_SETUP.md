# Supabase Backend & Secure Proxy Setup Guide for Read Fluent

This guide walks you through setting up your Supabase backend to enable **Authentication**, **User-wise Document & File Storage**, and **Admin User Management** for Read Fluent with **zero client-side credential exposure**.

---

## 🔒 Security Architecture (Zero Credentials Leaked)

- **Supabase URL & API Keys**: Stored exclusively on the server side in `.env`.
- **Zero Frontend Exposure**: No Supabase keys or endpoint URLs are ever exposed in frontend JavaScript, HTML, network headers, or GitHub repositories.
- **Strict Authentication Guard**: `index.html` requires an active authenticated session. Unauthenticated visitors are automatically redirected to `login.html`.
- **User-Isolated Storage**: Every document, upload, and reading progress is tied strictly to the authenticated user's ID via Row Level Security (RLS).
- **Admin Management**: Administrators have exclusive access to manage users, assign roles, inspect document counts, and delete accounts.

---

## 1. Create a Supabase Project

1. Go to [https://supabase.com](https://supabase.com) and sign in or sign up.
2. Click **"New Project"**.
3. Select your organization, enter a project name (e.g., `ReadFluent`), and set a strong database password.
4. Choose your preferred region and click **"Create new project"**.
5. Wait ~1-2 minutes for your database to initialize.

---

## 2. Run Database & Storage Migration (`supabase_schema.sql`)

1. In your Supabase Dashboard left sidebar, click **"SQL Editor"** (icon: `>_`).
2. Click **"New Query"**.
3. Open the file [`supabase_schema.sql`](supabase_schema.sql) in this repository, copy all contents, and paste them into the SQL Editor.
4. Click **"Run"** (or press `Ctrl+Enter` / `Cmd+Enter`).
5. You should see `Success. No rows returned`.

### What this sets up automatically:
- **`public.profiles`**: Stores user profiles and roles (`user` or `admin`).
- **`public.documents`**: Stores user documents, bookmarks, audio settings, and file attachments.
- **`user_documents` Storage Bucket**: Private user-isolated storage for uploaded TXT, PDF, Word documents (`${auth.uid()}/*`).
- **Row Level Security (RLS)**: Users can strictly only see and manage their own documents; administrators can supervise.
- **Admin RPC Functions**:
  - `admin_list_users()`: Returns user list, emails, roles, join dates, and document counts.
  - `admin_create_user(email, password, full_name, role)`: Direct user creation with encrypted credentials.
  - `admin_delete_user(target_user_id)`: Removes user and cascades deletion to documents and storage.
  - `admin_update_user_role(target_user_id, new_role)`: Promotes/demotes between `user` and `admin`.
  - `admin_get_user_documents(target_user_id)`: Allows admin to inspect user documents.

---

## 3. Retrieve Your Project Credentials

1. In Supabase Dashboard left sidebar, go to **Project Settings** (gear icon) → **API**.
2. Find:
   - **Project URL**: `https://<your-project-ref>.supabase.co`
   - **Project API Keys** → `anon` `public` (or `service_role` secret key for backend)

---

## 4. Configure Backend Server (`.env`)

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and fill in your credentials:
   ```env
   PORT=8080
   SUPABASE_URL=https://<your-project-ref>.supabase.co
   SUPABASE_KEY=your-supabase-key-here
   ```
3. `.env` is listed in `.gitignore` and will never be committed to Git.

---

## 5. Enable Email Auth & URL Redirects

1. Go to **Authentication** → **URL Configuration**.
2. Set **Site URL** to `http://localhost:8080/` (or your deployed URL).
3. Add your production and local URLs to **Redirect URLs**:
   - `http://localhost:8080/*`
   - `http://127.0.0.1:8080/*`
   - `https://<your-domain>/*`
4. *(Optional)* If you want users to be able to sign in immediately without email confirmation:
   - Go to **Authentication** → **Providers** → **Email**.
   - Toggle **"Confirm email"** OFF (or leave ON for production email validation).

---

## 6. Run the Server

Start the zero-dependency backend server:
```bash
node server.js
```
Open [http://localhost:8080](http://localhost:8080) in your browser:
- You will be automatically redirected to `login.html`.
- Sign up or log in.
- Once authenticated, you will be directed to `index.html` where only your documents and library will appear.

---

## 7. Designate Your First Admin Account

1. Open `http://localhost:8080/login.html` in your browser.
2. Switch to **"Sign Up"** and register your admin email (e.g., `admin@example.com`).
3. In your Supabase Dashboard, go to **SQL Editor** and run:
   ```sql
   UPDATE public.profiles
   SET role = 'admin'
   WHERE email = 'admin@example.com';
   ```
4. Sign in as `admin@example.com`.
5. You will see the **"Admin"** badge in your header avatar and the **"Admin Console"** option in your profile menu!
6. Open the Admin Console to view all registered users, add new users, change roles, inspect user documents, and delete accounts.
