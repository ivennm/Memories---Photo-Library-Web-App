import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

type Session = {
  authenticated: boolean;
  username?: string;
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
};

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
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [trash, setTrash] = useState<Photo[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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

  useEffect(() => {
    void refresh().catch((reason: Error) => setError(reason.message));
  }, [refresh]);

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
    setError("");
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const data = new FormData();
        data.append("file", file);
        await api("/api/photos", { method: "POST", body: data });
      }
      await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
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
      setError((reason as Error).message);
    }
  }

  async function restore(photo: Photo) {
    setError("");
    try {
      await api(`/api/photos/${photo.id}/restore`, { method: "POST" });
      await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function logout() {
    await api("/api/logout", { method: "POST" });
    setPhotos([]);
    setTrash([]);
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
        <h1>{session.can_create_first_user ? "Set up your library" : "Welcome back"}</h1>
        <p className="muted">
          {session.can_create_first_user
            ? "Create the first account. You can add family accounts from the server later."
            : "Sign in to your private family photo library."}
        </p>
        <form onSubmit={submitCredentials}>
          <label>Username<input name="username" autoComplete="username" minLength={3} required /></label>
          <label>Password<input name="password" type="password" autoComplete={session.can_create_first_user ? "new-password" : "current-password"} minLength={session.can_create_first_user ? 12 : undefined} required /></label>
          {error && <p className="error">{error}</p>}
          <button className="primary-button" disabled={busy}>
            {busy ? "Please wait…" : session.can_create_first_user ? "Create library account" : "Sign in"}
          </button>
        </form>
        <p className="footnote">Private access for your family over Tailscale.</p>
      </main>
    );
  }

  const visiblePhotos = showTrash ? trash : photos;
  const groups = visiblePhotos.reduce<Record<string, Photo[]>>((result, photo) => {
    const date = new Date(photo.taken_at);
    const key = date.toLocaleDateString(undefined, { year: "numeric", month: "long" });
    (result[key] ??= []).push(photo);
    return result;
  }, {});

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#"><span className="brand-mark">✳</span><span>Gather<span className="brand-light"> / family</span></span></a>
        <p className="side-label">LIBRARY</p>
        <button className={`nav-item ${!showTrash ? "selected" : ""}`} onClick={() => setShowTrash(false)}>
          <span>▦</span> All photos <span className="nav-count">{photos.length}</span>
        </button>
        <button className={`nav-item ${showTrash ? "selected" : ""}`} onClick={() => setShowTrash(true)}>
          <span>⌑</span> Recently deleted <span className="nav-count">{trash.length}</span>
        </button>
        <div className="sidebar-bottom">
          <div className="avatar">{session.username?.slice(0, 1).toUpperCase()}</div>
          <div className="user-info"><strong>{session.username}</strong><span>Family member</span></div>
          <button className="icon-button" onClick={() => void logout()} aria-label="Sign out" title="Sign out">↪</button>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div><p className="eyebrow">SHARED FAMILY LIBRARY</p><h1>{showTrash ? "Recently deleted" : "All photos"}</h1></div>
          {!showTrash && (
            <button className="primary-button upload-button" disabled={busy} onClick={() => inputRef.current?.click()}>
              <span>＋</span> {busy ? "Uploading…" : "Upload photos"}
            </button>
          )}
          <input ref={inputRef} className="visually-hidden" type="file" multiple accept="image/*,video/*" onChange={(event) => void uploadFiles(event.target.files)} />
        </header>
        {error && <div className="error-banner">{error}<button onClick={() => setError("")}>Dismiss</button></div>}
        {showTrash && <p className="trash-note">Items are permanently removed 30 days after deletion.</p>}
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
                        {showTrash ? (
                          <button className="text-button" onClick={() => void restore(photo)}>Restore</button>
                        ) : (
                          <button className="text-button delete-button" onClick={() => void moveToTrash(photo)}>Move to trash</button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
