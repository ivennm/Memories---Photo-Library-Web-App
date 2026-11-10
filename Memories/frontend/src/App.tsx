import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  Album as AlbumIcon, Check, ChevronLeft, CircleUser, Download, Ellipsis, FolderMinus, FolderPlus, Heart,
  Images, LoaderCircle, Plus, Trash, Trash2, Users,
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
  thumbnail_url: string | null;
  processing: "pending" | "done" | "failed";
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
  photo_ids: string[];
};

type View = "library" | "albums" | "trash" | "family" | "account";

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
    try {
      for (const [index, file] of selected.entries()) {
        setUploadStatus(selected.length > 1 ? `Uploading ${index + 1} of ${selected.length}…` : "Uploading…");
        const data = new FormData();
        data.append("file", file);
        if (album?.id != null) data.append("album_id", String(album.id));
        try {
          const result = await api<{ status: string; restored?: boolean }>("/api/photos", { method: "POST", body: data });
          if (result.status === "already_in_library") {
            alreadyInLibrary += 1;
            if (result.restored) restored += 1;
          } else {
            uploaded += 1;
          }
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
  const visiblePhotos = showTrash ? trash : photos;
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
          <Images className="icon" aria-hidden="true" /> All photos <span className="nav-count">{photos.length}</span>
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
        {view === "account" ? (
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
              <PhotoTimeline photos={visiblePhotos} renderActions={showTrash ? trashActions : (photo) => libraryMenu(photo)} />
            )}
          </>
        )}
      </main>
    </div>
  );
}

// Photos and videos grouped by the month they were taken, with each card's actions supplied by the page.
function PhotoTimeline({ photos, renderActions }: { photos: Photo[]; renderActions: (photo: Photo) => ReactNode }) {
  const groups = photos.reduce<Record<string, Photo[]>>((result, photo) => {
    const date = new Date(photo.taken_at);
    const key = date.toLocaleDateString(undefined, { year: "numeric", month: "long" });
    (result[key] ??= []).push(photo);
    return result;
  }, {});

  return (
    <div className="timeline">
      {Object.entries(groups).map(([month, items]) => (
        <section className="month-group" key={month}>
          <div className="month-heading"><h2>{month}</h2><span>{items.length} {items.length === 1 ? "item" : "items"}</span></div>
          <div className="photo-grid">
            {items.map((photo) => (
              <article className="photo-card" key={photo.id}>
                {photo.content_type.startsWith("video/") ? (
                  // With a poster, nothing downloads until play is pressed.
                  <video
                    src={photo.content_url}
                    poster={photo.thumbnail_url ?? undefined}
                    controls
                    playsInline
                    preload={photo.thumbnail_url ? "none" : "metadata"}
                  />
                ) : (
                  <img src={photo.thumbnail_url ?? photo.content_url} alt={photo.original_name} loading="lazy" />
                )}
                {photo.processing === "pending" && photo.content_type.startsWith("video/") && (
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
      <span className="album-count">{itemCount(album.photo_ids.length)}</span>
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

function AlbumDetail({ album, photos, onBack, onRename, onDelete, onUpload, uploading, renderActions }: {
  album: AlbumInfo;
  photos: Photo[];
  onBack: () => void;
  onRename: () => void;
  onDelete: () => void;
  onUpload: () => void;
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

function downloadOriginal(photo: Photo) {
  const link = document.createElement("a");
  link.href = photo.original_url;
  link.download = photo.original_name;
  document.body.append(link);
  link.click();
  link.remove();
}

type SaveState = { step: "idle" } | { step: "preparing" } | { step: "ready"; file: File };

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

  // Returns false when Safari refused because the tap that started the save was too long ago.
  async function share(file: File) {
    try {
      await navigator.share({ files: [file] });
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "NotAllowedError") return false;
      if (!(reason instanceof DOMException && reason.name === "AbortError")) downloadOriginal(photo);
    }
    return true;
  }

  async function saveToDevice() {
    if (!canSaveToPhotos || photo.size_bytes > SHARE_SIZE_LIMIT) {
      downloadOriginal(photo);
      close();
      return;
    }
    const controller = new AbortController();
    fetchRef.current = controller;
    setSave({ step: "preparing" });
    try {
      const response = await fetch(photo.original_url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Download failed (${response.status}).`);
      const file = new File([await response.blob()], photo.original_name, { type: photo.content_type });
      if (!navigator.canShare({ files: [file] })) {
        downloadOriginal(photo);
      } else if (!(await share(file))) {
        // Downloading took long enough that Safari wants a fresh tap before opening the share sheet.
        setSave({ step: "ready", file });
        return;
      }
    } catch (reason) {
      if (controller.signal.aborted) return;
      downloadOriginal(photo);
    }
    close();
  }

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
          {save.step === "ready" ? (
            <button className="menu-item" role="menuitem" onClick={() => void share(save.file).then(close)}>
              <Download className="icon" aria-hidden="true" /> Tap to save
            </button>
          ) : (
            <button className="menu-item" role="menuitem" disabled={save.step === "preparing"} onClick={() => void saveToDevice()}>
              {save.step === "preparing" ? (
                <><LoaderCircle className="icon spin" aria-hidden="true" /> Preparing…</>
              ) : (
                <><Download className="icon" aria-hidden="true" /> {canSaveToPhotos ? "Save to Photos" : "Download"}</>
              )}
            </button>
          )}
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
