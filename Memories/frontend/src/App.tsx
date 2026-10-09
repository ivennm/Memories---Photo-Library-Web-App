import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

type Session = {
  authenticated: boolean;
  username?: string;
  is_admin?: boolean;
  can_create_first_user: boolean;
};

type Photo = {
  id: string;
  original_name: string;
  content_type: string;
  size_bytes: number;
  taken_at: string;
  uploaded_at: string;
  uploaded_by: string;
  deleted_at: string | null;
  content_url: string;
  original_url: string;
};

type Account = {
  id: number;
  username: string;
  is_admin: boolean;
  created_at: string;
  removed_at: string | null;
  photo_count: number;
};

type Notice = {
  key: string;
  message: string;
  restorePhotoId?: string;
};

type View = "library" | "trash" | "family";

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: { error?: string; code?: string; photo_id?: string },
  ) {
    super(message);
  }
}

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, {
    ...options,
    headers,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError["body"];
    throw new ApiError(body.error ?? `Request failed (${response.status}).`, response.status, body);
  }
  return response.json() as Promise<T>;
}

// iOS converts photos to JPEG unless HEIC is listed explicitly; keep the originals.
const ACCEPTED_FILES = "image/*,video/*,.heic,.heif,image/heic,image/heif";

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [trash, setTrash] = useState<Photo[]>([]);
  const [view, setView] = useState<View>("library");
  const [busy, setBusy] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [error, setError] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const current = await api<Session>("/api/session");
    setSession(current);
    if (current.authenticated) {
      const [library, deleted] = await Promise.all([
        api<Photo[]>("/api/photos"),
        api<Photo[]>("/api/trash"),
      ]);
      setPhotos(library);
      setTrash(deleted);
    }
  }, []);

  const showError = useCallback(
    (reason: unknown) => {
      if (reason instanceof ApiError && reason.status === 401) {
        // Signed out elsewhere (password reset or account removed).
        void refresh();
        return;
      }
      setError((reason as Error).message);
    },
    [refresh],
  );

  useEffect(() => {
    void refresh().catch(showError);
  }, [refresh, showError]);

  async function submitCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const data = new FormData(event.currentTarget);
    const credentials = {
      username: String(data.get("username") ?? ""),
      password: String(data.get("password") ?? ""),
    };
    try {
      await api(session?.can_create_first_user ? "/api/first-user" : "/api/login", {
        method: "POST",
        body: JSON.stringify(credentials),
      });
      await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    const selected = Array.from(files);
    setError("");
    setNotices([]);
    setBusy(true);
    const newNotices: Notice[] = [];
    let uploaded = 0;
    try {
      for (const [index, file] of selected.entries()) {
        setUploadStatus(selected.length > 1 ? `Uploading ${index + 1} of ${selected.length}…` : "Uploading…");
        const data = new FormData();
        data.append("file", file);
        try {
          await api("/api/photos", { method: "POST", body: data });
          uploaded += 1;
        } catch (reason) {
          if (reason instanceof ApiError && reason.status === 401) throw reason;
          const trashedPhotoId =
            reason instanceof ApiError && reason.body.code === "in_trash" ? reason.body.photo_id : undefined;
          newNotices.push({
            key: `${file.name}-${index}`,
            message: trashedPhotoId ? (reason as Error).message : `${file.name}: ${(reason as Error).message}`,
            restorePhotoId: trashedPhotoId,
          });
        }
      }
      if (uploaded > 0 && newNotices.length > 0) {
        newNotices.unshift({ key: "summary", message: `Uploaded ${uploaded} of ${selected.length} files.` });
      }
      setNotices(newNotices);
      await refresh();
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
      setUploadStatus("");
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function moveToTrash(photo: Photo) {
    if (!window.confirm(`Move "${photo.original_name}" to the 30-day trash?`)) return;
    setError("");
    try {
      await api(`/api/photos/${photo.id}`, { method: "DELETE" });
      await refresh();
    } catch (reason) {
      showError(reason);
    }
  }

  async function restore(photoId: string) {
    setError("");
    try {
      await api(`/api/photos/${photoId}/restore`, { method: "POST" });
      setNotices((current) => current.filter((notice) => notice.restorePhotoId !== photoId));
      await refresh();
    } catch (reason) {
      showError(reason);
    }
  }

  async function deleteForever(photo: Photo) {
    if (!window.confirm(`Permanently delete "${photo.original_name}"? This cannot be undone.`)) return;
    setError("");
    try {
      await api(`/api/trash/${photo.id}`, { method: "DELETE" });
      await refresh();
    } catch (reason) {
      showError(reason);
    }
  }

  async function logout() {
    await api("/api/logout", { method: "POST" });
    setPhotos([]);
    setTrash([]);
    setNotices([]);
    setView("library");
    await refresh();
  }

  if (session === null) {
    return <main className="center-card"><p>Opening your library…</p></main>;
  }

  if (!session.authenticated) {
    return (
      <main className="center-card auth-card">
        <div className="brand-mark">✳</div>
        <p className="eyebrow">YOUR FAMILY, IN FOCUS</p>
        <h1>{session.can_create_first_user ? "Set up Memories" : "Welcome back"}</h1>
        <p className="muted">
          {session.can_create_first_user
            ? "Create the first account. It becomes the admin account, which can add family members."
            : "Sign in to your private family photo library."}
        </p>
        <form onSubmit={submitCredentials}>
          <label>Username<input name="username" autoComplete="username" minLength={3} required /></label>
          <label>Password<input name="password" type="password" autoComplete={session.can_create_first_user ? "new-password" : "current-password"} minLength={session.can_create_first_user ? 12 : undefined} required /></label>
          {error && <p className="error">{error}</p>}
          <button className="primary-button" disabled={busy}>
            {busy ? "Please wait…" : session.can_create_first_user ? "Create admin account" : "Sign in"}
          </button>
        </form>
        <p className="footnote">Private access for your family over Tailscale.</p>
      </main>
    );
  }

  const showTrash = view === "trash";
  const visiblePhotos = showTrash ? trash : photos;
  const groups = visiblePhotos.reduce<Record<string, Photo[]>>((result, photo) => {
    const date = new Date(photo.taken_at);
    const key = date.toLocaleDateString(undefined, { year: "numeric", month: "long" });
    (result[key] ??= []).push(photo);
    return result;
  }, {});
  const titles: Record<View, string> = {
    library: "All photos",
    trash: "Recently deleted",
    family: "Family accounts",
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#"><span className="brand-mark">✳</span><span>Memories</span></a>
        <p className="side-label">LIBRARY</p>
        <button className={`nav-item ${view === "library" ? "selected" : ""}`} onClick={() => setView("library")}>
          <span>▦</span> All photos <span className="nav-count">{photos.length}</span>
        </button>
        <button className={`nav-item ${showTrash ? "selected" : ""}`} onClick={() => setView("trash")}>
          <span>⌑</span> Recently deleted <span className="nav-count">{trash.length}</span>
        </button>
        {session.is_admin && (
          <button className={`nav-item ${view === "family" ? "selected" : ""}`} onClick={() => setView("family")}>
            <span>☺</span> Family accounts
          </button>
        )}
        <div className="sidebar-bottom">
          <div className="avatar">{session.username?.slice(0, 1).toUpperCase()}</div>
          <div className="user-info"><strong>{session.username}</strong><span>{session.is_admin ? "Admin" : "Family member"}</span></div>
          <button className="icon-button" onClick={() => void logout()} aria-label="Sign out" title="Sign out">↪</button>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div><p className="eyebrow">SHARED FAMILY LIBRARY</p><h1>{titles[view]}</h1></div>
          {view === "library" && (
            <button className="primary-button upload-button" disabled={busy} onClick={() => inputRef.current?.click()}>
              <span>＋</span> {busy ? uploadStatus || "Uploading…" : "Upload photos"}
            </button>
          )}
          <input ref={inputRef} className="visually-hidden" type="file" multiple accept={ACCEPTED_FILES} onChange={(event) => void uploadFiles(event.target.files)} />
        </header>
        {error && <div className="error-banner">{error}<button onClick={() => setError("")}>Dismiss</button></div>}
        {notices.length > 0 && (
          <div className="notice-list">
            {notices.map((notice) => (
              <div className="notice" key={notice.key}>
                <span>{notice.message}</span>
                <span className="notice-actions">
                  {notice.restorePhotoId && (
                    <button className="primary-button small-button" onClick={() => void restore(notice.restorePhotoId!)}>Restore</button>
                  )}
                  <button className="text-button" onClick={() => setNotices((current) => current.filter((item) => item !== notice))}>Dismiss</button>
                </span>
              </div>
            ))}
          </div>
        )}
        {view === "family" ? (
          <FamilyAccounts currentUsername={session.username ?? ""} onError={showError} />
        ) : (
          <>
            {showTrash && (
              <p className="trash-note">
                Items are permanently removed 30 days after deletion.
                {session.is_admin && " As admin, you can also delete them forever now."}
              </p>
            )}
            {visiblePhotos.length === 0 ? (
              <section className="empty-state">
                <div className="empty-icon">{showTrash ? "⌑" : "▧"}</div>
                <h2>{showTrash ? "Trash is empty" : "Your memories start here"}</h2>
                <p>{showTrash ? "Deleted photos will be kept here for 30 days." : "Upload photos and videos to start building your shared family library."}</p>
                {!showTrash && <button className="primary-button" onClick={() => inputRef.current?.click()}>Choose photos</button>}
              </section>
            ) : (
              <div className="timeline">
                {Object.entries(groups).map(([month, items]) => (
                  <section className="month-group" key={month}>
                    <div className="month-heading"><h2>{month}</h2><span>{items.length} {items.length === 1 ? "item" : "items"}</span></div>
                    <div className="photo-grid">
                      {items.map((photo) => (
                        <article className="photo-card" key={photo.id}>
                          {photo.content_type.startsWith("video/") ? (
                            <video src={photo.content_url} controls preload="metadata" />
                          ) : (
                            <img src={photo.content_url} alt={photo.original_name} loading="lazy" />
                          )}
                          <div className="photo-details">
                            <span className="photo-name" title={photo.original_name}>{photo.original_name}</span>
                            <span className="photo-byline">{new Date(photo.taken_at).toLocaleDateString()} · {photo.uploaded_by}</span>
                            <div className="photo-actions">
                              <a className="text-button" href={photo.original_url}>Download</a>
                              {showTrash ? (
                                <>
                                  <button className="text-button" onClick={() => void restore(photo.id)}>Restore</button>
                                  {session.is_admin && (
                                    <button className="text-button delete-button" onClick={() => void deleteForever(photo)}>Delete forever</button>
                                  )}
                                </>
                              ) : (
                                <button className="text-button delete-button" onClick={() => void moveToTrash(photo)}>Move to trash</button>
                              )}
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function FamilyAccounts({ currentUsername, onError }: { currentUsername: string; onError: (reason: unknown) => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [resettingId, setResettingId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setAccounts(await api<Account[]>("/api/admin/users"));
  }, []);

  useEffect(() => {
    void load().catch(onError);
  }, [load, onError]);

  async function run(action: () => Promise<unknown>, success: string) {
    setMessage("");
    setBusy(true);
    try {
      await action();
      setMessage(success);
      await load();
      return true;
    } catch (reason) {
      onError(reason);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const username = String(data.get("username") ?? "");
    const created = await run(
      () => api("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ username, password: String(data.get("password") ?? "") }),
      }),
      `Created an account for ${username}. Share the password with them privately.`,
    );
    if (created) form.reset();
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>, account: Account) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    const reset = await run(
      () => api(`/api/admin/users/${account.id}/password`, { method: "POST", body: JSON.stringify({ password }) }),
      `Password reset for ${account.username}. They have been signed out on all devices.`,
    );
    if (reset) setResettingId(null);
  }

  async function removeAccount(account: Account) {
    if (!window.confirm(`Remove ${account.username}'s account? Their photos stay in the library, still credited to them.`)) return;
    await run(
      () => api(`/api/admin/users/${account.id}`, { method: "DELETE" }),
      `Removed ${account.username}'s account.`,
    );
  }

  return (
    <div className="family-panel">
      {message && <p className="success-note">{message}</p>}
      <section className="panel-card">
        <h2>Add a family member</h2>
        <form className="inline-form" onSubmit={addAccount}>
          <label>Username<input name="username" autoComplete="off" minLength={3} maxLength={40} required /></label>
          <label>Password<input name="password" type="password" autoComplete="new-password" minLength={12} required /></label>
          <button className="primary-button" disabled={busy}>Add account</button>
        </form>
      </section>
      <section className="panel-card">
        <h2>Accounts</h2>
        <ul className="account-list">
          {accounts.map((account) => (
            <li key={account.id} className={account.removed_at ? "removed" : ""}>
              <div className="account-row">
                <div className="avatar">{account.username.slice(0, 1).toUpperCase()}</div>
                <div className="user-info">
                  <strong>{account.username}{account.username === currentUsername && " (you)"}</strong>
                  <span>
                    {account.removed_at ? "Removed" : account.is_admin ? "Admin" : "Family member"}
                    {" · "}{account.photo_count} {account.photo_count === 1 ? "upload" : "uploads"}
                  </span>
                </div>
                {!account.removed_at && (
                  <span className="account-actions">
                    <button className="text-button" onClick={() => setResettingId(resettingId === account.id ? null : account.id)}>Reset password</button>
                    {!account.is_admin && (
                      <button className="text-button delete-button" onClick={() => void removeAccount(account)}>Remove</button>
                    )}
                  </span>
                )}
              </div>
              {resettingId === account.id && (
                <form className="inline-form" onSubmit={(event) => void resetPassword(event, account)}>
                  <label>New password for {account.username}<input name="password" type="password" autoComplete="new-password" minLength={12} required autoFocus /></label>
                  <button className="primary-button" disabled={busy}>Set password</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export default App;
