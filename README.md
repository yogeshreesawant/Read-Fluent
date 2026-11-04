# Read Fluent — Intelligent Text-to-Speech & Document Studio

**Read Fluent** is a high-performance text-to-speech reader and document synthesis workstation engineered to stream large textual documents (supporting files up to 1GB across TXT, PDF, and Word `.docx`) with zero interface lag, smooth audio seek scrubbing, synchronized karaoke-style highlighting, and **cloud persistence powered by Supabase**.

Hosted directly on **GitHub Pages** with backend services on **Supabase**.

---

## 🌟 Key Features

1. **User Authentication (Supabase Auth)**
   - Sign up with full name, email, and password.
   - Secure sign in with session persistence and auto-refresh.
   - Forgot password recovery via emailed password reset links.
   - Direct password reset and update handling.
   - Sign out with instant state clearance.

2. **User-Wise Cloud Documents & File Storage**
   - Each registered user has a private, user-isolated cloud library.
   - Documents, reading bookmarks, audio voice profiles, and playback speeds are saved per user.
   - Uploaded TXT, PDF, and Word `.docx` original files are stored in Supabase Storage under `${user.id}/*`.
   - Strict Row Level Security (RLS) guarantees users can only access their own files.
   - Per-user duplicate document title guardrails.
   - Full offline fallback for guest users.

3. **Admin Login & User Management Console**
   - Dedicated Admin Console for users with the `admin` role.
   - **View All Users**: Real-time table displaying user names, emails, roles, join dates, last sign-in timestamps, and total documents saved.
   - **Add Users**: Administrators can directly create user accounts with assigned roles (`user` or `admin`).
   - **Delete Users**: Administrators can remove users, automatically cascading deletion to their saved documents and storage files.
   - **Role Management**: Promote users to `admin` or demote administrators to standard `user`.
   - **Document Inspector**: View the documents saved by any user with word counts and original file links.

4. **Speech & Document Engine**
   - Chunked FileReader handling documents up to 1GB with zero UI freezing.
   - Web Speech API integration with Chrome 15-second cutoff keep-alive workaround.
   - Fluid seek scrubber slider with sentence-level seek preview.
   - Dynamic speech rate adjustment (0.5x to 3.0x).
   - Synchronized Fluent Reader Mode with real-time sentence glow and word-level karaoke tracking.

---

## 🚀 How to Host on GitHub Pages

Because Read Fluent is built as a modern client-side web application, it can be deployed on **GitHub Pages** in minutes:

### Step 1: Push Repository to GitHub
Open your terminal in this directory (`c:\ReadFluent`) and run:
```bash
# Initialize git if not already initialized
git init

# Add all files and make initial commit
git add .
git commit -m "Initial commit: Read Fluent with Supabase Auth, Cloud Storage, and Admin Dashboard"

# Rename branch to main
git branch -M main

# Add your GitHub repository remote
git remote add origin https://github.com/<your-username>/ReadFluent.git

# Push to GitHub
git push -u origin main
```

### Step 2: Enable GitHub Pages
1. Go to your repository on GitHub (`https://github.com/<your-username>/ReadFluent`).
2. Click **Settings** → **Pages** (under "Code and automation").
3. Under **Build and deployment**:
   - **Source**: Select **GitHub Actions** (the included `.github/workflows/deploy.yml` will deploy automatically), OR select **Deploy from a branch**, choose `main` and `/ (root)`.
4. Click **Save**.
5. Within 1-2 minutes, your website will be live at:
   `https://<your-username>.github.io/ReadFluent/`

---

## ⚡ Supabase Backend Setup

For complete, step-by-step instructions with SQL queries, see [SUPABASE_SETUP.md](SUPABASE_SETUP.md).

### Quick 3-Step Setup:
1. Create a free project at [supabase.com](https://supabase.com).
2. Open the **SQL Editor** in your Supabase dashboard and run the entire script [`supabase_schema.sql`](supabase_schema.sql).
3. Connect credentials:
   - Click the **"Supabase"** button in Read Fluent's top header and enter your **Project URL** and **Anon Key**, OR
   - Paste them into [`config.js`](config.js):
     ```javascript
     window.READFLUENT_CONFIG = {
       SUPABASE_URL: "https://<your-project-id>.supabase.co",
       SUPABASE_ANON_KEY: "<your-anon-public-key>"
     };
     ```

### Creating Your First Admin:
1. Sign up through the Read Fluent web UI (e.g. `admin@example.com`).
2. Run this in the Supabase SQL Editor:
   ```sql
   UPDATE public.profiles
   SET role = 'admin'
   WHERE email = 'admin@example.com';
   ```
3. Refresh the page. You will now see the **Admin** badge and have access to the **Admin Console**!

---

## 📁 Project Structure

```
c:\ReadFluent/
├── index.html               # Main workspace, reader, auth modals & admin console
├── style.css                # Obsidian Dark & Clean Light design tokens, glassmorphism styles
├── app.js                   # Application controller, speech engine & UI bindings
├── supabase-client.js       # Supabase service (Auth, RLS storage, Admin RPC)
├── config.js                # Supabase Project URL & Anon Key configuration
├── supabase_schema.sql      # Database schema, RLS policies, storage bucket & admin functions
├── SUPABASE_SETUP.md        # Step-by-step Supabase backend guide
├── PRD.md                   # Product Requirements Document
├── .gitignore               # Ignored files for clean git tracking
└── .github/
    └── workflows/
        └── deploy.yml       # Automated GitHub Pages CI/CD deployment
```

---

## 🛡️ Security & Privacy Architecture

- **Row Level Security (RLS)**: PostgreSQL Row Level Security is enforced on both `public.profiles` and `public.documents`. Supabase guarantees that authenticated users cannot read or modify another user's documents.
- **`SECURITY DEFINER` Admin RPC**: Admin endpoints (`admin_create_user`, `admin_delete_user`, `admin_update_user_role`, `admin_list_users`) verify that the calling user has `role = 'admin'` before performing privileged actions.
- **Client-Side Document Parsing**: PDF and Word document extraction occurs entirely inside the user's browser via PDF.js and Mammoth.js before being saved to user storage.
