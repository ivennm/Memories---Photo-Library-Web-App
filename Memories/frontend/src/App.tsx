import { type FormEvent, type ReactNode, type TouchEvent as ReactTouchEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Album as AlbumIcon, Check, ChevronLeft, ChevronRight, CircleUser, Download, Ellipsis, EyeOff, FolderMinus, FolderPlus, Heart,
  Images, LoaderCircle, Maximize, Pause, Play, Plus, Settings, Trash, Trash2, Users, Volume2, VolumeX, X,
} from "lucide-react";

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
  // "Most compatible" download: a JPEG for photos, an MP4 for videos (files already in those formats as they are).
  compatible_url: string;
  compatible_name: string;
  compatible_type: string;
  thumbnail_url: string | null;
  processing: "pending" | "done" | "failed";
  // False when the item is in an album set to not show in All photos; it then only shows in albums.
  in_all_photos: boolean;
};

type Account = {
  id: number;
  username: string;
  is_admin: boolean;
  created_at: string;
  removed_at: string | null;
  photo_count: number;
};

type Invite = {
  id: number;
  created_at: string;
  expires_at: string;
};

type Notice = {
  key: string;
  message: string;
  restorePhotoId?: string;
};

// Shared by everyone. "favorites" and "uploader" albums are made automatically and can't be deleted;
// "uploader" albums (one per person) have no id because they follow who uploaded each item.
type AlbumInfo = {
  key: string;
  id: number | null;
  kind: "favorites" | "custom" | "uploader";
  name: string;
  // Custom albums can be set to keep their items out of All photos (and the "Uploaded by" albums).
  show_in_library: boolean;
  photo_ids: string[];
};

type View = "library" | "albums" | "trash" | "family" | "account" | "settings";

// Remembered on this device only (a person may want originals on their iPhone and JPEG/MP4 on a PC).
type DownloadFormat = "original" | "compatible";
const DOWNLOAD_FORMAT_KEY = "memories.downloadFormat";

function getDownloadFormat(): DownloadFormat {
  try {
    return localStorage.getItem(DOWNLOAD_FORMAT_KEY) === "compatible" ? "compatible" : "original";
  } catch {
    return "original";
  }
}

function storeDownloadFormat(format: DownloadFormat) {
  try {
    localStorage.setItem(DOWNLOAD_FORMAT_KEY, format);
  } catch {
    // Private browsing: the choice lasts until the page is reloaded.
  }
}

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

// Uploads one file, reporting how much has been sent (0 to 1). fetch() can't report upload
// progress, so this uses XMLHttpRequest; errors are thrown as ApiError, like api().
function uploadWithProgress<T>(data: FormData, onProgress: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/photos");
    request.responseType = "json";
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      const body = (request.response ?? {}) as ApiError["body"] & T;
      if (request.status >= 200 && request.status < 300) resolve(body);
      else reject(new ApiError(body.error ?? `Request failed (${request.status}).`, request.status, body));
    };
    request.onerror = () => reject(new Error("The upload was interrupted. Check the connection and try again."));
    request.send(data);
  });
}

// iPhones and iPads (iPads report themselves as a Mac, but have a touch screen).
const isAppleTouchDevice =
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

// With the picker's default "Automatic" format, iPhone converts every file before handing any of
// them over, which can take minutes with no progress shown. "Current" sends the originals at once.
function IphoneUploadTip({ onDismiss }: { onDismiss?: () => void }) {
  if (!isAppleTouchDevice) return null;
  return (
    <p className="upload-tip">
      <span>
        <strong>Uploading from iPhone?</strong> In the photo picker, tap <strong>Options</strong> and choose{" "}
        <strong>Current</strong>. It's much faster and keeps the original photos and videos. Keep the screen on until the upload finishes.
      </span>
      {onDismiss && <button className="text-button" onClick={onDismiss}>Got it</button>}
    </p>
  );
}

const TIP_DISMISSED_KEY = "memories.iphoneTipDismissed";

// iOS converts photos to JPEG unless HEIC is listed explicitly; keep the originals.
const ACCEPTED_FILES = "image/*,video/*,.heic,.heif,image/heic,image/heif";

// Invite links look like /join/<token>; the server sends the app for any page address.
function inviteTokenFromAddress() {
  return window.location.pathname.match(/^\/join\/([^/]+)$/)?.[1] ?? null;
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [inviteToken, setInviteToken] = useState(inviteTokenFromAddress);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [trash, setTrash] = useState<Photo[]>([]);
  const [albums, setAlbums] = useState<AlbumInfo[]>([]);
  const [view, setView] = useState<View>("library");
  const [openAlbumKey, setOpenAlbumKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [error, setError] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  // The album the next picked files go into (null = just the library).
  const uploadAlbumRef = useRef<AlbumInfo | null>(null);
  // The iPhone upload tip shows in All photos until dismissed (remembered on this device only).
  const [tipDismissed, setTipDismissed] = useState(() => {
    try {
      return localStorage.getItem(TIP_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  function dismissTip() {
    setTipDismissed(true);
    try {
      localStorage.setItem(TIP_DISMISSED_KEY, "1");
    } catch {
      // Private browsing: it stays hidden until the page is reloaded.
    }
  }

  const refresh = useCallback(async () => {
    const current = await api<Session>("/api/session");
    setSession(current);
    if (current.authenticated) {
      const [library, deleted, albumList] = await Promise.all([
        api<Photo[]>("/api/photos"),
        api<Photo[]>("/api/trash"),
        api<AlbumInfo[]>("/api/albums"),
      ]);
      setPhotos(library);
      setTrash(deleted);
      setAlbums(albumList);
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

  // New uploads get thumbnails and video streaming copies in the background; check back until done.
  useEffect(() => {
    if (!photos.some((photo) => photo.processing === "pending")) return;
    const timer = window.setTimeout(() => void refresh().catch(showError), 10000);
    return () => window.clearTimeout(timer);
  }, [photos, refresh, showError]);

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

  // Opens the file picker. With an album, everything picked also goes into that album.
  function chooseFiles(album: AlbumInfo | null = null) {
    uploadAlbumRef.current = album;
    inputRef.current?.click();
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    const selected = Array.from(files);
    const album = uploadAlbumRef.current;
    setError("");
    setNotices([]);
    setBusy(true);
    const newNotices: Notice[] = [];
    let uploaded = 0;
    // Into an album: files already in Memories are added to it instead of being refused.
    let alreadyInLibrary = 0;
    let restored = 0;
    // Progress is by size across the whole batch, so one big video doesn't look stuck.
    const totalBytes = selected.reduce((sum, file) => sum + file.size, 0) || 1;
    let finishedBytes = 0;
    try {
      for (const [index, file] of selected.entries()) {
        const showProgress = (fraction: number) => {
          const percent = Math.min(99, Math.floor(((finishedBytes + fraction * file.size) / totalBytes) * 100));
          setUploadStatus(
            selected.length > 1 ? `Uploading ${index + 1} of ${selected.length} · ${percent}%` : `Uploading… ${percent}%`,
          );
        };
        showProgress(0);
        const data = new FormData();
        data.append("file", file);
        if (album?.id != null) data.append("album_id", String(album.id));
        try {
          const result = await uploadWithProgress<{ status: string; restored?: boolean }>(data, showProgress);
          finishedBytes += file.size;
          if (result.status === "already_in_library") {
            alreadyInLibrary += 1;
            if (result.restored) restored += 1;
          } else {
            uploaded += 1;
          }
        } catch (reason) {
          if (reason instanceof ApiError && reason.status === 401) throw reason;
          finishedBytes += file.size;
          const trashedPhotoId =
            reason instanceof ApiError && reason.body.code === "in_trash" ? reason.body.photo_id : undefined;
          newNotices.push({
            key: `${file.name}-${index}`,
            message: trashedPhotoId ? (reason as Error).message : `${file.name}: ${(reason as Error).message}`,
            restorePhotoId: trashedPhotoId,
          });
        }
      }
      if (album) {
        const added = uploaded + alreadyInLibrary;
        const details = [
          `${uploaded} new`,
          alreadyInLibrary > 0 && `${alreadyInLibrary} already in Memories`,
          restored > 0 && `${restored} restored from Recently deleted`,
        ].filter(Boolean).join(", ");
        newNotices.unshift({
          key: "summary",
          message: `Added ${added} of ${selected.length} ${selected.length === 1 ? "item" : "items"} to ${album.name} (${details}).`,
        });
      } else if (uploaded > 0 && newNotices.length > 0) {
        newNotices.unshift({ key: "summary", message: `Uploaded ${uploaded} of ${selected.length} files.` });
      }
      setNotices(newNotices);
      await refresh();
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
      setUploadStatus("");
      uploadAlbumRef.current = null;
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

  // Adds or removes one item from an album. Returns false if it didn't work (the error is shown).
  async function setInAlbum(album: AlbumInfo, photo: Photo, include: boolean) {
    setError("");
    try {
      await (include
        ? api(`/api/albums/${album.id}/photos`, { method: "POST", body: JSON.stringify({ photo_id: photo.id }) })
        : api(`/api/albums/${album.id}/photos/${photo.id}`, { method: "DELETE" }));
      if (include && !album.show_in_library) {
        // Otherwise the item seems to vanish from All photos for no reason.
        setNotices((current) => [
          ...current.filter((notice) => notice.key !== `hidden-${photo.id}`),
          {
            key: `hidden-${photo.id}`,
            message: `Added ${photo.original_name} to ${album.name}. That album isn't shown in All photos, so it now appears only in its albums.`,
          },
        ]);
      }
      await refresh();
      return true;
    } catch (reason) {
      showError(reason);
      return false;
    }
  }

  // Asks for a name and makes a new shared album; returns its id, or null if cancelled or refused.
  async function createAlbum() {
    const name = window.prompt("Name for the new album:")?.trim();
    if (!name) return null;
    setError("");
    try {
      const created = await api<{ id: number }>("/api/albums", { method: "POST", body: JSON.stringify({ name }) });
      await refresh();
      return created.id;
    } catch (reason) {
      showError(reason);
      return null;
    }
  }

  // From the New album card: make the album and go straight into it, ready to upload.
  async function openNewAlbum() {
    const albumId = await createAlbum();
    if (albumId !== null) setOpenAlbumKey(`album-${albumId}`);
  }

  async function createAlbumWith(photo: Photo) {
    const albumId = await createAlbum();
    if (albumId === null) return;
    try {
      await api(`/api/albums/${albumId}/photos`, { method: "POST", body: JSON.stringify({ photo_id: photo.id }) });
      await refresh();
    } catch (reason) {
      showError(reason);
    }
  }

  async function renameAlbum(album: AlbumInfo) {
    const name = window.prompt("New name for this album:", album.name)?.trim();
    if (!name || name === album.name) return;
    setError("");
    try {
      await api(`/api/albums/${album.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      await refresh();
    } catch (reason) {
      showError(reason);
    }
  }

  async function setAlbumShownInLibrary(album: AlbumInfo, show: boolean) {
    setError("");
    try {
      await api(`/api/albums/${album.id}`, { method: "PATCH", body: JSON.stringify({ show_in_library: show }) });
      await refresh();
    } catch (reason) {
      showError(reason);
    }
  }

  async function deleteAlbum(album: AlbumInfo) {
    if (!window.confirm(`Delete the album "${album.name}" for everyone? The photos and videos in it stay in All photos.`)) return;
    setError("");
    try {
      await api(`/api/albums/${album.id}`, { method: "DELETE" });
      setOpenAlbumKey(null);
      await refresh();
    } catch (reason) {
      showError(reason);
    }
  }

  function openView(next: View) {
    setView(next);
    setOpenAlbumKey(null);
  }

  async function logout() {
    await api("/api/logout", { method: "POST" });
    setPhotos([]);
    setTrash([]);
    setAlbums([]);
    setNotices([]);
    openView("library");
    await refresh();
  }

  if (session === null) {
    return <main className="center-card"><p>Opening your library…</p></main>;
  }

  if (inviteToken) {
    const leaveInvite = () => {
      window.history.replaceState(null, "", "/");
      setInviteToken(null);
      void refresh().catch(showError);
    };
    return <JoinPage token={inviteToken} signedInAs={session.authenticated ? session.username : undefined} onDone={leaveInvite} />;
  }

  if (!session.authenticated) {
    return (
      <main className="center-card auth-card">
        <div className="brand-mark">M</div>
        <h1>{session.can_create_first_user ? "Set up Memories" : "Welcome back"}</h1>
        <p className="muted">
          {session.can_create_first_user
            ? "Create Admin account."
            : "Sign in"}
        </p>
        <form onSubmit={submitCredentials}>
          <label>Username<input name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} minLength={2} required /></label>
          <label>Password<input name="password" type="password" autoComplete={session.can_create_first_user ? "new-password" : "current-password"} minLength={session.can_create_first_user ? 12 : undefined} required /></label>
          {error && <p className="error">{error}</p>}
          <button className="primary-button" disabled={busy}>
            {busy ? "Please wait…" : session.can_create_first_user ? "Create admin account" : "Sign in"}
          </button>
          {!session.can_create_first_user && (
          <button type="button" className="forgot-button" disabled={busy}>
            Forgot Username or Password?
          </button>
        )}
        </form>
        
      </main>
    );
  }

  const showTrash = view === "trash";
  // photos also has items kept only in their albums; albums look them up here.
  const libraryPhotos = photos.filter((photo) => photo.in_all_photos);
  const visiblePhotos = showTrash ? trash : libraryPhotos;
  const photosById = new Map(photos.map((photo) => [photo.id, photo]));
  // Favorites and custom albums; "Uploaded by" albums fill themselves.
  const editableAlbums = albums.filter((album) => album.kind !== "uploader");
  const openAlbum = view === "albums" ? albums.find((album) => album.key === openAlbumKey) : undefined;

  const libraryMenu = (photo: Photo, currentAlbum?: AlbumInfo) => (
    <PhotoMenu
      photo={photo}
      albums={editableAlbums}
      currentAlbum={currentAlbum}
      onSetInAlbum={(album, include) => setInAlbum(album, photo, include)}
      onCreateAlbum={() => void createAlbumWith(photo)}
      onMoveToTrash={() => void moveToTrash(photo)}
    />
  );

  const trashActions = (photo: Photo) => (
    <div className="photo-actions">
      <button className="text-button" onClick={() => void restore(photo.id)}>Restore</button>
      {session.is_admin && (
        <button className="text-button delete-button" onClick={() => void deleteForever(photo)}>Delete forever</button>
      )}
    </div>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#"><span className="brand-mark">M</span><span>Memories</span><span className="app-version">v{__APP_VERSION__}</span></a>
        <p className="side-label">LIBRARY</p>
        <button className={`nav-item ${view === "library" ? "selected" : ""}`} onClick={() => openView("library")}>
          <Images className="icon" aria-hidden="true" /> All photos <span className="nav-count">{libraryPhotos.length}</span>
        </button>
        <button className={`nav-item ${view === "albums" ? "selected" : ""}`} onClick={() => openView("albums")}>
          <AlbumIcon className="icon" aria-hidden="true" /> Albums <span className="nav-count">{albums.length}</span>
        </button>
        <button className={`nav-item ${showTrash ? "selected" : ""}`} onClick={() => openView("trash")}>
          <Trash2 className="icon" aria-hidden="true" /> Recently deleted <span className="nav-count">{trash.length}</span>
        </button>
        {session.is_admin && (
          <button className={`nav-item ${view === "family" ? "selected" : ""}`} onClick={() => openView("family")}>
            <Users className="icon" aria-hidden="true" /> Family accounts
          </button>
        )}
        <button className={`nav-item nav-account ${view === "settings" ? "selected" : ""}`} onClick={() => openView("settings")}>
          <Settings className="icon" aria-hidden="true" /> Settings
        </button>
        <button className={`nav-item nav-account ${view === "account" ? "selected" : ""}`} onClick={() => openView("account")}>
          <CircleUser className="icon" aria-hidden="true" /> My account
        </button>
        <div className="sidebar-bottom">
          <div className="avatar">{session.username?.slice(0, 1).toUpperCase()}</div>
          <div className="user-info"><strong>{session.username}</strong><span>{session.is_admin ? "Admin" : "Family member"}</span></div>
          <button className="icon-button" onClick={() => void logout()} >Sign out</button>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <span className="app-version topbar-version">Memories v{__APP_VERSION__}</span>
          <div className="topbar-actions">
            {view === "library" && (
              <button className="primary-button upload-button" disabled={busy} onClick={() => chooseFiles()} aria-label="Upload photos" title="Upload photos">
                {busy ? uploadStatus || "Uploading…" : <Plus className="icon" aria-hidden="true" />}
              </button>
            )}
            <button className={`account-button ${view === "settings" ? "selected" : ""}`} onClick={() => openView("settings")} aria-label="Settings" title="Settings">
              <Settings className="icon" aria-hidden="true" />
            </button>
            <button className={`account-button ${view === "account" ? "selected" : ""}`} onClick={() => openView("account")} aria-label="My account" title="My account">
              <CircleUser className="icon" aria-hidden="true" />
            </button>
          </div>
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
        {view === "settings" ? (
          <SettingsPage />
        ) : view === "account" ? (
          <MyAccount username={session.username ?? ""} onChanged={refresh} onError={showError} onSignOut={() => void logout()} />
        ) : view === "family" ? (
          <FamilyAccounts currentUsername={session.username ?? ""} onChanged={refresh} onError={showError} />
        ) : view === "albums" ? (
          openAlbum ? (
            <AlbumDetail
              album={openAlbum}
              photos={openAlbum.photo_ids.flatMap((id) => photosById.get(id) ?? [])}
              onBack={() => setOpenAlbumKey(null)}
              onRename={() => void renameAlbum(openAlbum)}
              onDelete={() => void deleteAlbum(openAlbum)}
              onUpload={() => chooseFiles(openAlbum)}
              onShowInLibraryChange={(show) => void setAlbumShownInLibrary(openAlbum, show)}
              uploading={busy ? uploadStatus || "Uploading…" : null}
              renderActions={(photo) => libraryMenu(photo, openAlbum)}
            />
          ) : (
            <AlbumList albums={albums} photosById={photosById} onOpen={setOpenAlbumKey} onCreate={() => void openNewAlbum()} />
          )
        ) : (
          <>
            {showTrash && (
              <p className="trash-note">
                Items are permanently removed 30 days after deletion.
                {session.is_admin && ""}
              </p>
            )}
            {visiblePhotos.length === 0 ? (
              <section className="empty-state">
                <h2>{showTrash ? "Trash is empty" : "Your memories start here"}</h2>
                <p>{showTrash ? "Deleted photos will be kept here for 30 days." : "Upload photos and videos to start building your shared family library."}</p>
                {!showTrash && <button className="primary-button" onClick={() => chooseFiles()}>Choose photos</button>}
              </section>
            ) : (
              <>
                {!showTrash && !tipDismissed && <IphoneUploadTip onDismiss={dismissTip} />}
                <PhotoTimeline photos={visiblePhotos} renderActions={showTrash ? trashActions : (photo) => libraryMenu(photo)} />
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

const isVideo = (photo: Photo) => photo.content_type.startsWith("video/");

// Photos and videos grouped by the month they were taken, with each card's actions supplied by the page.
// Tapping a card opens the full-screen viewer, which steps through the items in the same order.
function PhotoTimeline({ photos, renderActions }: { photos: Photo[]; renderActions: (photo: Photo) => ReactNode }) {
  const [viewerId, setViewerId] = useState<string | null>(null);
  const groups = photos.reduce<Record<string, Photo[]>>((result, photo) => {
    const date = new Date(photo.taken_at);
    const key = date.toLocaleDateString(undefined, { year: "numeric", month: "long" });
    (result[key] ??= []).push(photo);
    return result;
  }, {});
  // The order shown on screen (Recently deleted is sorted by deletion date, not by month).
  const ordered = Object.values(groups).flat();

  return (
    <div className="timeline">
      {Object.entries(groups).map(([month, items]) => (
        <section className="month-group" key={month}>
          <div className="month-heading"><h2>{month}</h2><span>{items.length} {items.length === 1 ? "item" : "items"}</span></div>
          <div className="photo-grid">
            {items.map((photo) => (
              <article className="photo-card" key={photo.id}>
                <button className="photo-open" onClick={() => setViewerId(photo.id)} aria-label={`Open ${photo.original_name}`}>
                  {photo.thumbnail_url || !isVideo(photo) ? (
                    <img src={photo.thumbnail_url ?? photo.content_url} alt={photo.original_name} loading="lazy" />
                  ) : (
                    // A new video without a poster frame yet: the browser shows its first frame.
                    <video src={photo.content_url} muted playsInline preload="metadata" />
                  )}
                  {isVideo(photo) && <span className="play-badge"><Play className="icon" fill="currentColor" aria-hidden="true" /></span>}
                </button>
                {photo.processing === "pending" && isVideo(photo) && (
                  <span className="processing-badge">Processing…</span>
                )}
                <div className="photo-details">
                  <div className="photo-text">
                    <span className="photo-name" title={photo.original_name}>{photo.original_name}</span>
                    <span className="photo-byline">{new Date(photo.taken_at).toLocaleDateString()} · {photo.uploaded_by}</span>
                  </div>
                  {renderActions(photo)}
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
      {viewerId !== null && (
        <PhotoViewer photos={ordered} startId={viewerId} renderActions={renderActions} onClosed={() => setViewerId(null)} />
      )}
    </div>
  );
}

// Full-screen viewer, like the iPhone Photos app: swipe sideways (or arrow keys / buttons on a computer)
// to move through the items, swipe down or press Escape to close, tap a photo to hide the bars.
// Opening it adds a browser history entry, so the phone's Back gesture closes it instead of leaving the app.
function PhotoViewer({ photos, startId, renderActions, onClosed }: {
  photos: Photo[];
  startId: string;
  renderActions: (photo: Photo) => ReactNode;
  onClosed: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [currentId, setCurrentId] = useState(startId);
  const [barsHidden, setBarsHidden] = useState(false);
  const indexRef = useRef(Math.max(0, photos.findIndex((photo) => photo.id === startId)));
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const foundIndex = photos.findIndex((photo) => photo.id === currentId);
  // If the current item left the list (moved to trash, removed from the album), show its neighbour.
  const index = foundIndex >= 0 ? foundIndex : Math.min(indexRef.current, photos.length - 1);
  const current = photos[index];
  const photoIds = photos.map((photo) => photo.id).join(",");

  // The parent passes a new function on every render; keep the latest without re-running effects.
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const close = useCallback(() => {
    if ((window.history.state as { memoriesViewer?: boolean } | null)?.memoriesViewer) window.history.back();
    else onClosedRef.current();
  }, []);

  useEffect(() => {
    if (!(window.history.state as { memoriesViewer?: boolean } | null)?.memoriesViewer) {
      window.history.pushState({ memoriesViewer: true }, "");
    }
    const onBack = () => onClosedRef.current();
    window.addEventListener("popstate", onBack);
    // The page behind stays where it was.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("popstate", onBack);
      document.body.style.overflow = overflow;
    };
  }, []);

  useEffect(() => {
    if (photos.length === 0) close();
  }, [photos.length, close]);

  // Keep the track on the current item when opening, when the list changes and when the phone rotates.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track || index < 0) return;
    indexRef.current = index;
    if (current && current.id !== currentId) setCurrentId(current.id);
    const place = () => {
      track.scrollLeft = indexRef.current * track.clientWidth;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
    // Only when the items change (not on every re-render); scrolling itself updates currentId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoIds]);

  function onScroll() {
    const track = trackRef.current;
    if (!track || track.clientWidth === 0) return;
    const next = Math.round(track.scrollLeft / track.clientWidth);
    if (next !== indexRef.current && photos[next]) {
      indexRef.current = next;
      setCurrentId(photos[next].id);
    }
  }

  const go = useCallback((step: number) => {
    const track = trackRef.current;
    const next = indexRef.current + step;
    if (!track || next < 0 || next >= photos.length) return;
    track.scrollTo({ left: next * track.clientWidth, behavior: "smooth" });
  }, [photos.length]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // The "..." menu handles its own Escape.
      if (event.key === "Escape" && !document.querySelector(".viewer .menu-list")) close();
      else if (event.key === "ArrowLeft") go(-1);
      else if (event.key === "ArrowRight") go(1);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close, go]);

  // Only the item on screen plays.
  useEffect(() => {
    trackRef.current?.querySelectorAll("video").forEach((video) => {
      if (video.dataset.id !== currentId && !video.paused) video.pause();
    });
  }, [currentId]);

  function onTouchStart(event: ReactTouchEvent) {
    touchStart.current = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
  }

  function onTouchEnd(event: ReactTouchEvent) {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || event.changedTouches.length !== 1) return;
    const dx = event.changedTouches[0].clientX - start.x;
    const dy = event.changedTouches[0].clientY - start.y;
    if (dy > 90 && Math.abs(dx) < dy / 2) close();
  }

  if (!current) return null;
  const takenAt = new Date(current.taken_at);

  return (
    <div className={`viewer ${barsHidden ? "bars-hidden" : ""}`} role="dialog" aria-modal="true" aria-label="Photo viewer">
      <header className="viewer-bar">
        <button className="viewer-button" onClick={close} aria-label="Close" title="Close (Esc)">
          <X className="icon" aria-hidden="true" />
        </button>
        <div className="viewer-caption">
          <strong>{takenAt.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</strong>
          <span>
            {takenAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · {current.uploaded_by} · {index + 1} of {photos.length}
          </span>
        </div>
        <div className="viewer-actions">{renderActions(current)}</div>
      </header>
      <div className="viewer-track" ref={trackRef} onScroll={onScroll} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {photos.map((photo, position) => (
          <div className="viewer-slide" key={photo.id}>
            {/* Only the items next to the one on screen are loaded. */}
            {Math.abs(position - index) <= 1 && (
              isVideo(photo) ? (
                <ViewerVideo
                  photo={photo}
                  active={position === index}
                  // The one that was tapped in the grid starts playing.
                  autoPlay={photo.id === startId}
                />
              ) : (
                <ViewerImage photo={photo} onTap={() => setBarsHidden((hidden) => !hidden)} />
              )
            )}
          </div>
        ))}
      </div>
      {index > 0 && (
        <button className="viewer-button viewer-prev" onClick={() => go(-1)} aria-label="Previous" title="Previous (←)">
          <ChevronLeft className="icon" aria-hidden="true" />
        </button>
      )}
      {index < photos.length - 1 && (
        <button className="viewer-button viewer-next" onClick={() => go(1)} aria-label="Next" title="Next (→)">
          <ChevronRight className="icon" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

// Computers with a mouse: desktop browsers hide their own video controls while a video plays, so these
// get a control bar that stays on screen. Phones and tablets keep the built-in controls.
const hasMouse = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = String(whole % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

function ViewerVideo({ photo, active, autoPlay }: { photo: Photo; active: boolean; autoPlay: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }, []);

  // Space plays/pauses the video on screen.
  useEffect(() => {
    if (!hasMouse || !active) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== " " || (event.target as HTMLElement).closest("button, input")) return;
      event.preventDefault();
      togglePlay();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, togglePlay]);

  const common = {
    "data-id": photo.id,
    src: photo.content_url,
    poster: photo.thumbnail_url ?? undefined,
    playsInline: true,
    preload: active ? "metadata" : "none",
    autoPlay,
  } as const;

  if (!hasMouse) return <video {...common} controls />;

  return (
    <div className="viewer-video" ref={boxRef}>
      <video
        {...common}
        ref={videoRef}
        onClick={togglePlay}
        onDoubleClick={() => void (document.fullscreenElement ? document.exitFullscreen() : boxRef.current?.requestFullscreen())}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onVolumeChange={(event) => setMuted(event.currentTarget.muted)}
      />
      <div className="video-controls">
        <button className="video-control" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (space)" : "Play (space)"}>
          {playing ? <Pause className="icon" fill="currentColor" aria-hidden="true" /> : <Play className="icon" fill="currentColor" aria-hidden="true" />}
        </button>
        <span className="video-time">{formatTime(time)}</span>
        <input
          className="video-seek"
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(time, duration || 0)}
          onChange={(event) => {
            const video = videoRef.current;
            if (video) video.currentTime = Number(event.target.value);
            setTime(Number(event.target.value));
          }}
          aria-label="Seek"
        />
        <span className="video-time">{formatTime(duration)}</span>
        <button
          className="video-control"
          onClick={() => {
            if (videoRef.current) videoRef.current.muted = !videoRef.current.muted;
          }}
          aria-label={muted ? "Unmute" : "Mute"}
          title={muted ? "Unmute" : "Mute"}
        >
          {muted ? <VolumeX className="icon" aria-hidden="true" /> : <Volume2 className="icon" aria-hidden="true" />}
        </button>
        <button
          className="video-control"
          onClick={() => void (document.fullscreenElement ? document.exitFullscreen() : boxRef.current?.requestFullscreen())}
          aria-label="Full screen"
          title="Full screen"
        >
          <Maximize className="icon" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

// The thumbnail shows at once (it's usually cached from the grid); the full-size photo fades in over it.
function ViewerImage({ photo, onTap }: { photo: Photo; onTap: () => void }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="viewer-image" onClick={onTap}>
      {photo.thumbnail_url && !loaded && <img src={photo.thumbnail_url} alt="" aria-hidden="true" />}
      <img
        className={loaded || !photo.thumbnail_url ? "" : "loading"}
        src={photo.content_url}
        alt={photo.original_name}
        decoding="async"
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
}

function AlbumCover({ photo, kind }: { photo?: Photo; kind: AlbumInfo["kind"] }) {
  // The newest item's thumbnail; a video without a poster frame yet gets the placeholder.
  const src = photo && (photo.thumbnail_url ?? (photo.content_type.startsWith("video/") ? null : photo.content_url));
  return (
    <span className="album-cover">
      {src ? (
        <img src={src} alt="" loading="lazy" />
      ) : kind === "favorites" ? (
        <Heart className="icon" aria-hidden="true" />
      ) : (
        <Images className="icon" aria-hidden="true" />
      )}
    </span>
  );
}

function AlbumList({ albums, photosById, onOpen, onCreate }: {
  albums: AlbumInfo[];
  photosById: Map<string, Photo>;
  onOpen: (key: string) => void;
  onCreate: () => void;
}) {
  const card = (album: AlbumInfo) => (
    <button className="album-card" key={album.key} onClick={() => onOpen(album.key)}>
      <AlbumCover photo={photosById.get(album.photo_ids[0])} kind={album.kind} />
      <span className="album-name" title={album.name}>{album.name}</span>
      <span className="album-count">
        {itemCount(album.photo_ids.length)}
        {!album.show_in_library && <><EyeOff className="icon" aria-hidden="true" /> Not in All photos</>}
      </span>
    </button>
  );

  return (
    <div className="timeline">
      <section className="month-group">
        <div className="month-heading"><h2>Albums</h2><span>Shared with the whole family</span></div>
        <div className="album-grid">
          {albums.filter((album) => album.kind !== "uploader").map(card)}
          <button className="album-card new-album" onClick={onCreate}>
            <span className="album-cover"><Plus className="icon" aria-hidden="true" /></span>
            <span className="album-name">New album</span>
            <span className="album-count">Name it, then add photos</span>
          </button>
        </div>
      </section>
      <section className="month-group">
        <div className="month-heading"><h2>People</h2><span>Everything each person has uploaded</span></div>
        <div className="album-grid">{albums.filter((album) => album.kind === "uploader").map(card)}</div>
      </section>
    </div>
  );
}

function AlbumDetail({ album, photos, onBack, onRename, onDelete, onUpload, onShowInLibraryChange, uploading, renderActions }: {
  album: AlbumInfo;
  photos: Photo[];
  onBack: () => void;
  onRename: () => void;
  onDelete: () => void;
  onUpload: () => void;
  onShowInLibraryChange: (show: boolean) => void;
  // The upload progress text while uploading, otherwise null.
  uploading: string | null;
  renderActions: (photo: Photo) => ReactNode;
}) {
  const emptyHint = {
    favorites: "In All photos, tap ··· on a photo or video and choose Add to Favorites.",
    custom:
      "Tap Upload photos to add from your phone or computer. On iPhone, choose Albums in the picker, open an album and drag across the photos to select them all. Photos already in Memories are added without making copies. You can also use ··· > Add to album in All photos.",
    uploader: "Nothing uploaded yet.",
  }[album.kind];

  return (
    <>
      <div className="album-header">
        <button className="text-button back-button" onClick={onBack}>
          <ChevronLeft className="icon" aria-hidden="true" /> Albums
        </button>
        <div className="album-title">
          <h1>{album.name}</h1>
          <span>{itemCount(photos.length)}</span>
        </div>
        {album.kind === "custom" && (
          <span className="album-actions">
            <button className="primary-button album-upload" disabled={uploading !== null} onClick={onUpload}>
              {uploading ?? <><Plus className="icon" aria-hidden="true" /> Upload photos</>}
            </button>
            <button className="text-button" onClick={onRename}>Rename</button>
            <button className="text-button delete-button" onClick={onDelete}>Delete album</button>
          </span>
        )}
        {album.kind === "custom" && (
          <div className="album-setting">
            <label>
              <input
                type="checkbox"
                checked={album.show_in_library}
                onChange={(event) => onShowInLibraryChange(event.target.checked)}
              />
              Show in All photos
            </label>
            <span>
              {album.show_in_library
                ? "Photos and videos in this album also appear in All photos."
                : "Photos and videos in this album appear only in its albums, not in All photos or Uploaded by. Everyone in the family can still open this album."}
            </span>
          </div>
        )}
        {album.kind === "custom" && <IphoneUploadTip />}
      </div>
      {photos.length === 0 ? (
        <section className="empty-state">
          <h2>{album.kind === "favorites" ? "No favorites yet" : "This album is empty"}</h2>
          <p>{emptyHint}</p>
        </section>
      ) : (
        <PhotoTimeline photos={photos} renderActions={renderActions} />
      )}
    </>
  );
}

// Phones and tablets on HTTPS can hand the original file to the share sheet, whose "Save Video" /
// "Save Image" puts it straight into Photos. Computers (and plain HTTP) download it instead.
const canSaveToPhotos =
  window.isSecureContext && typeof navigator.canShare === "function" && navigator.maxTouchPoints > 1;
// The share sheet needs the whole file in memory first; bigger files are downloaded instead.
const SHARE_SIZE_LIMIT = 500 * 1024 * 1024;

type DownloadTarget = { url: string; name: string; type: string };

function downloadTarget(photo: Photo, format: DownloadFormat): DownloadTarget {
  return format === "compatible"
    ? { url: photo.compatible_url, name: photo.compatible_name, type: photo.compatible_type }
    : { url: photo.original_url, name: photo.original_name, type: photo.content_type };
}

function downloadFile(target: DownloadTarget) {
  const link = document.createElement("a");
  link.href = target.url;
  link.download = target.name;
  document.body.append(link);
  link.click();
  link.remove();
}

// "chosen" is the format picked in Settings; "original" is the extra Download original item.
type SaveState =
  | { step: "idle" }
  | { step: "preparing"; which: DownloadFormat }
  | { step: "ready"; which: DownloadFormat; file: File; target: DownloadTarget };

function PhotoMenu({ photo, albums, currentAlbum, onSetInAlbum, onCreateAlbum, onMoveToTrash }: {
  photo: Photo;
  // Favorites and custom albums (the ones items can be added to).
  albums: AlbumInfo[];
  // The album being viewed, if any, so the item can be taken out of it.
  currentAlbum?: AlbumInfo;
  onSetInAlbum: (album: AlbumInfo, include: boolean) => Promise<boolean>;
  onCreateAlbum: () => void;
  onMoveToTrash: () => void;
}) {
  const [open, setOpen] = useState(false);
  // "albums" shows the list of albums to tick, in place of the main menu.
  const [pane, setPane] = useState<"main" | "albums">("main");
  const [save, setSave] = useState<SaveState>({ step: "idle" });
  const menuRef = useRef<HTMLDivElement>(null);
  const fetchRef = useRef<AbortController | null>(null);
  const favorites = albums.find((album) => album.kind === "favorites");
  const isFavorite = favorites?.photo_ids.includes(photo.id) ?? false;
  const customAlbums = albums.filter((album) => album.kind === "custom");

  const close = useCallback(() => {
    fetchRef.current?.abort();
    fetchRef.current = null;
    setSave({ step: "idle" });
    setPane("main");
    setOpen(false);
  }, []);

  // Read when the menu opens, so a change in Settings applies straight away.
  const chosenFormat = open ? getDownloadFormat() : "original";

  // Returns false when Safari refused because the tap that started the save was too long ago.
  async function share(file: File, target: DownloadTarget) {
    try {
      await navigator.share({ files: [file] });
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "NotAllowedError") return false;
      if (!(reason instanceof DOMException && reason.name === "AbortError")) downloadFile(target);
    }
    return true;
  }

  async function saveToDevice(which: DownloadFormat) {
    const target = downloadTarget(photo, which);
    // The size is known for originals; converted copies are about the same size or smaller.
    if (!canSaveToPhotos || photo.size_bytes > SHARE_SIZE_LIMIT) {
      downloadFile(target);
      close();
      return;
    }
    const controller = new AbortController();
    fetchRef.current = controller;
    setSave({ step: "preparing", which });
    try {
      const response = await fetch(target.url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Download failed (${response.status}).`);
      // If the server couldn't convert the file it sends the original instead.
      const converted = (response.headers.get("Content-Type") ?? "").split(";")[0] === target.type;
      const name = converted ? target.name : photo.original_name;
      const file = new File([await response.blob()], name, { type: converted ? target.type : photo.content_type });
      if (!navigator.canShare({ files: [file] })) {
        downloadFile(target);
      } else if (!(await share(file, target))) {
        // Downloading took long enough that Safari wants a fresh tap before opening the share sheet.
        setSave({ step: "ready", which, file, target });
        return;
      }
    } catch (reason) {
      if (controller.signal.aborted) return;
      downloadFile(target);
    }
    close();
  }

  const saveLabel = canSaveToPhotos ? "Save to Photos" : "Download";
  const saveItem = (which: DownloadFormat, label: string) =>
    save.step === "ready" && save.which === which ? (
      <button className="menu-item" role="menuitem" onClick={() => void share(save.file, save.target).then(close)}>
        <Download className="icon" aria-hidden="true" /> Tap to save
      </button>
    ) : (
      <button className="menu-item" role="menuitem" disabled={save.step !== "idle"} onClick={() => void saveToDevice(which)}>
        {save.step === "preparing" && save.which === which ? (
          <><LoaderCircle className="icon spin" aria-hidden="true" /> Preparing…</>
        ) : (
          <><Download className="icon" aria-hidden="true" /> {label}</>
        )}
      </button>
    );

  useEffect(() => {
    if (!open) return;
    // Close when tapping anywhere outside the menu, or on Escape.
    function closeOnOutsideTap(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) close();
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("pointerdown", closeOnOutsideTap);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideTap);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, close]);

  return (
    <div className="photo-menu" ref={menuRef}>
      <button
        className="menu-button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-label={`More options for ${photo.original_name}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Ellipsis className="icon" aria-hidden="true" />
      </button>
      {open && pane === "albums" && (
        <div className="menu-list album-picker" role="menu">
          <button className="menu-item" role="menuitem" onClick={() => setPane("main")}>
            <ChevronLeft className="icon" aria-hidden="true" /> Back
          </button>
          {customAlbums.map((album) => {
            const included = album.photo_ids.includes(photo.id);
            return (
              <button
                key={album.key}
                className="menu-item"
                role="menuitemcheckbox"
                aria-checked={included}
                onClick={() => void onSetInAlbum(album, !included)}
              >
                <Check className={`icon ${included ? "" : "unchecked"}`} aria-hidden="true" />
                <span className="menu-label" title={album.name}>{album.name}</span>
              </button>
            );
          })}
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              close();
              onCreateAlbum();
            }}
          >
            <Plus className="icon" aria-hidden="true" /> New album…
          </button>
        </div>
      )}
      {open && pane === "main" && (
        <div className="menu-list" role="menu">
          {saveItem(chosenFormat, saveLabel)}
          {chosenFormat === "compatible" && saveItem("original", canSaveToPhotos ? "Save original" : "Download original")}
          {favorites && (
            <button
              className="menu-item"
              role="menuitem"
              onClick={() => {
                close();
                void onSetInAlbum(favorites, !isFavorite);
              }}
            >
              <Heart className="icon" fill={isFavorite ? "currentColor" : "none"} aria-hidden="true" />
              {isFavorite ? "Remove from Favorites" : "Add to Favorites"}
            </button>
          )}
          <button className="menu-item" role="menuitem" onClick={() => setPane("albums")}>
            <FolderPlus className="icon" aria-hidden="true" /> Add to album…
          </button>
          {currentAlbum?.kind === "custom" && (
            <button
              className="menu-item"
              role="menuitem"
              onClick={() => {
                close();
                void onSetInAlbum(currentAlbum, false);
              }}
            >
              <FolderMinus className="icon" aria-hidden="true" /> Remove from this album
            </button>
          )}
          <button
            className="menu-item delete-button"
            role="menuitem"
            onClick={() => {
              close();
              onMoveToTrash();
            }}
          >
            <Trash className="icon" aria-hidden="true" /> Move to trash
          </button>
        </div>
      )}
    </div>
  );
}

function FamilyAccounts({ currentUsername, onChanged, onError }: {
  currentUsername: string;
  onChanged: () => Promise<void>;
  onError: (reason: unknown) => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [newInviteUrl, setNewInviteUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const inviteInputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<{ id: number; field: "password" | "username" } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [users, openInvites] = await Promise.all([
      api<Account[]>("/api/admin/users"),
      api<Invite[]>("/api/admin/invites"),
    ]);
    setAccounts(users);
    setInvites(openInvites);
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
    if (reset) setEditing(null);
  }

  async function renameAccount(event: FormEvent<HTMLFormElement>, account: Account) {
    event.preventDefault();
    const username = String(new FormData(event.currentTarget).get("username") ?? "").trim();
    const renamed = await run(
      () => api(`/api/admin/users/${account.id}/username`, { method: "POST", body: JSON.stringify({ username }) }),
      `Renamed ${account.username} to ${username}. They sign in with the new username from now on.`,
    );
    if (renamed) {
      setEditing(null);
      if (account.username === currentUsername) await onChanged();
    }
  }

  async function createInvite() {
    setCopied(false);
    await run(async () => {
      const invite = await api<{ path: string }>("/api/admin/invites", { method: "POST" });
      setNewInviteUrl(window.location.origin + invite.path);
    }, "Invite link created. Send it to one family member; it works once and expires in 7 days.");
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(newInviteUrl);
    } catch {
      // The clipboard API needs HTTPS; over plain HTTP, copy the selected text the older way.
      inviteInputRef.current?.select();
      document.execCommand("copy");
    }
    setCopied(true);
  }

  async function shareInvite() {
    try {
      await navigator.share({ title: "Join Memories", text: "Create your Memories account:", url: newInviteUrl });
    } catch {
      // Share sheet closed without sharing.
    }
  }

  async function revokeInvite(invite: Invite) {
    if (!window.confirm("Revoke this invite link? It will stop working immediately.")) return;
    await run(() => api(`/api/admin/invites/${invite.id}`, { method: "DELETE" }), "Invite link revoked.");
  }

  function toggleEditing(account: Account, field: "password" | "username") {
    setEditing(editing?.id === account.id && editing.field === field ? null : { id: account.id, field });
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
        <h3 className="panel-subheading">Invite link</h3>
        <p className="muted">Send a link so they can choose their own username and password. Each link works once and expires after 7 days.</p>
        {newInviteUrl ? (
          <div className="inline-form invite-link">
            <label>Invite link<input ref={inviteInputRef} value={newInviteUrl} readOnly onFocus={(event) => event.currentTarget.select()} /></label>
            <button className="primary-button" type="button" onClick={() => void copyInvite()}>{copied ? "Copied" : "Copy"}</button>
            {"share" in navigator && window.isSecureContext && (
              <button className="primary-button" type="button" onClick={() => void shareInvite()}>Share</button>
            )}
            <button className="text-button" type="button" onClick={() => setNewInviteUrl("")}>Done</button>
          </div>
        ) : (
          <button className="primary-button" type="button" disabled={busy} onClick={() => void createInvite()}>Create invite link</button>
        )}
        {invites.length > 0 && (
          <ul className="invite-list">
            {invites.map((invite) => (
              <li key={invite.id}>
                <span>Unused link · created {new Date(invite.created_at).toLocaleDateString()} · expires {new Date(invite.expires_at).toLocaleDateString()}</span>
                <button className="text-button delete-button" onClick={() => void revokeInvite(invite)}>Revoke</button>
              </li>
            ))}
          </ul>
        )}
        <h3 className="panel-subheading">Or create the account yourself</h3>
        <form className="inline-form" onSubmit={addAccount}>
          <label>Username<input name="username" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} minLength={2} maxLength={40} required /></label>
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
                    <button className="text-button" onClick={() => toggleEditing(account, "username")}>Rename</button>
                    <button className="text-button" onClick={() => toggleEditing(account, "password")}>Reset password</button>
                    {!account.is_admin && (
                      <button className="text-button delete-button" onClick={() => void removeAccount(account)}>Remove</button>
                    )}
                  </span>
                )}
              </div>
              {editing?.id === account.id && editing.field === "username" && (
                <form className="inline-form" onSubmit={(event) => void renameAccount(event, account)}>
                  <label>New username for {account.username}<input name="username" defaultValue={account.username} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} minLength={2} maxLength={40} required autoFocus /></label>
                  <button className="primary-button" disabled={busy}>Save username</button>
                </form>
              )}
              {editing?.id === account.id && editing.field === "password" && (
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

function SettingsPage() {
  const [format, setFormat] = useState<DownloadFormat>(getDownloadFormat);
  function choose(next: DownloadFormat) {
    setFormat(next);
    storeDownloadFormat(next);
  }
  const options: { value: DownloadFormat; title: string; text: string }[] = [
    {
      value: "original",
      title: "Original files",
      text: "Exactly what was uploaded, at full quality (iPhone photos as HEIC, videos as MOV). Best for iPhone, iPad and Mac.",
    },
    {
      value: "compatible",
      title: "Most compatible (JPEG / MP4)",
      text: "Photos as full-size JPEG and videos as MP4, which open on any computer. Best for Windows PCs. Videos come as the 1080p copy the app plays, which is smaller but not full quality. Photos and videos keep the date they were taken.",
    },
  ];
  return (
    <div className="family-panel">
      <section className="panel-card">
        <h2>Downloads</h2>
        <p className="muted">
          What Save to Photos / Download in the ··· menu gives you. This is remembered on this device only, so you can choose
          differently on your phone and your computer.
        </p>
        <div className="choice-list" role="radiogroup" aria-label="Download format">
          {options.map((option) => (
            <label key={option.value} className={`choice ${format === option.value ? "selected" : ""}`}>
              <input
                type="radio"
                name="download-format"
                checked={format === option.value}
                onChange={() => choose(option.value)}
              />
              <span>
                <strong>{option.title}</strong>
                <span>{option.text}</span>
              </span>
            </label>
          ))}
        </div>
        {format === "compatible" && (
          <p className="muted settings-note">The ··· menu also has Download original, for when you need the untouched file.</p>
        )}
      </section>
    </div>
  );
}

function MyAccount({ username, onChanged, onError, onSignOut }: {
  username: string;
  onChanged: () => Promise<void>;
  onError: (reason: unknown) => void;
  onSignOut: () => void;
}) {
  const [message, setMessage] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>, url: string, success: (data: FormData) => string) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (data.has("confirm_password") && data.get("confirm_password") !== data.get("new_password")) {
      setMessage("");
      setFormError("The new passwords don't match.");
      return;
    }
    setMessage("");
    setFormError("");
    setBusy(true);
    try {
      await api(url, { method: "POST", body: JSON.stringify(Object.fromEntries(data)) });
      setMessage(success(data));
      form.reset();
      await onChanged();
    } catch (reason) {
      // Wrong current password or a taken username is shown here; a signed-out session is handled by the app.
      if (reason instanceof ApiError && reason.status !== 401) setFormError(reason.message);
      else onError(reason);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="family-panel">
      {message && <p className="success-note">{message}</p>}
      {formError && <p className="error">{formError}</p>}
      <StorageCard />
      <section className="panel-card">
        <h2>Change username</h2>
        <form className="inline-form" onSubmit={(event) => void submit(event, "/api/account/username", (data) => `Your username is now ${String(data.get("username")).trim()}. Use it the next time you sign in.`)}>
          <label>New username<input name="username" placeholder={username} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} minLength={2} maxLength={40} required /></label>
          <label>Current password<input name="current_password" type="password" autoComplete="current-password" required /></label>
          <button className="primary-button" disabled={busy}>Save username</button>
        </form>
      </section>
      <section className="panel-card">
        <h2>Change password</h2>
        <form className="inline-form" onSubmit={(event) => void submit(event, "/api/account/password", () => "Password changed. Your other devices have been signed out.")}>
          <label>Current password<input name="current_password" type="password" autoComplete="current-password" required /></label>
          <label>New password<input name="new_password" type="password" autoComplete="new-password" minLength={12} required /></label>
          <label>Confirm new password<input name="confirm_password" type="password" autoComplete="new-password" minLength={12} required /></label>
          <button className="primary-button" disabled={busy}>Change password</button>
        </form>
      </section>
      <section className="panel-card">
        <h2>Signed in as {username}</h2>
        <button className="text-button delete-button" onClick={onSignOut}>Sign out of this device</button>
      </section>
    </div>
  );
}

type StorageUsage = {
  drive: { total_bytes: number; used_bytes: number; free_bytes: number };
  library_bytes: number;
  library_items: number;
  trash_bytes: number;
  trash_items: number;
  my_bytes: number;
  my_items: number;
};

// Decimal units, like drive makers use, so the 1 TB drive shows as about 1 TB.
function formatBytes(bytes: number) {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function itemCount(count: number) {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

function StorageCard() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<StorageUsage>("/api/storage")
      .then(setUsage)
      .catch((reason: Error) => setError(reason.message));
  }, []);

  if (error) {
    return <section className="panel-card"><h2>Storage</h2><p className="error">{error}</p></section>;
  }
  if (!usage) {
    return <section className="panel-card"><h2>Storage</h2><p className="muted">Checking the photo drive…</p></section>;
  }

  const { total_bytes: total, used_bytes: used, free_bytes: free } = usage.drive;
  const memoriesBytes = usage.library_bytes + usage.trash_bytes;
  const percent = (bytes: number) => `${Math.min(100, (bytes / total) * 100)}%`;
  const usedPercent = Math.round((used / total) * 100);

  return (
    <section className="panel-card">
      <h2>Storage</h2>
      <p className="storage-headline">
        <strong>{formatBytes(used)}</strong> of {formatBytes(total)} used · {formatBytes(free)} free
      </p>
      <div className="storage-bar" role="img" aria-label={`Photo drive ${usedPercent}% full`}>
        <span className="storage-memories" style={{ width: percent(memoriesBytes) }} />
        <span className="storage-other" style={{ width: percent(Math.max(0, used - memoriesBytes)) }} />
      </div>
      <ul className="storage-legend">
        <li><span className="swatch storage-memories" />Memories library: {formatBytes(usage.library_bytes)} ({itemCount(usage.library_items)})</li>
        <li><span className="swatch storage-memories trash" />Recently deleted: {formatBytes(usage.trash_bytes)} ({itemCount(usage.trash_items)})</li>
        <li><span className="swatch storage-other" />Other files and drive overhead: {formatBytes(Math.max(0, used - memoriesBytes))}</li>
        <li>Your uploads: {formatBytes(usage.my_bytes)} ({itemCount(usage.my_items)})</li>
      </ul>
      <p className="footnote storage-note">Photos and videos are stored on the server's 1 TB drive. Items in Recently deleted still use space until they're removed after 30 days.</p>
    </section>
  );
}

function JoinPage({ token, signedInAs, onDone }: { token: string; signedInAs?: string; onDone: () => void }) {
  const [valid, setValid] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ valid: boolean }>(`/api/invites/${encodeURIComponent(token)}`)
      .then((result) => setValid(result.valid))
      .catch(() => setValid(false));
  }, [token]);

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (data.get("password") !== data.get("confirm_password")) {
      setError("The passwords don't match.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await api(`/api/invites/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        body: JSON.stringify({ username: String(data.get("username") ?? "").trim(), password: String(data.get("password") ?? "") }),
      });
      onDone();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 410) setValid(false);
      else setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (valid === null) {
    return <main className="center-card"><p>Checking your invite…</p></main>;
  }

  if (!valid) {
    return (
      <main className="center-card auth-card">
        <div className="brand-mark">M</div>
        <h1>Invite link not valid</h1>
        <p className="muted">This invite link has expired or has already been used. Ask the admin for a new one.</p>
        <button className="primary-button" onClick={onDone}>Go to sign in</button>
      </main>
    );
  }

  return (
    <main className="center-card auth-card">
      <div className="brand-mark">M</div>
      <p className="eyebrow">YOU'RE INVITED</p>
      <h1>Join Memories</h1>
      <p className="muted">
        Create your account for the private family photo library.
        {signedInAs && ` You're signed in as ${signedInAs} on this device; creating an account will switch to the new one.`}
      </p>
      <form onSubmit={join}>
        <label>Username<input name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} minLength={2} maxLength={40} required /></label>
        <label>Password<input name="password" type="password" autoComplete="new-password" minLength={12} required /></label>
        <label>Confirm password<input name="confirm_password" type="password" autoComplete="new-password" minLength={12} required /></label>
        <p className="footnote">Passwords need at least 12 characters.</p>
        {error && <p className="error">{error}</p>}
        <button className="primary-button" disabled={busy}>{busy ? "Please wait…" : "Create my account"}</button>
      </form>
      <p className="footnote"><button className="text-button" onClick={onDone}>Already have an account? Sign in</button></p>
    </main>
  );
}

export default App;
