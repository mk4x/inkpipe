import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, ServiceError, type Status, type Draft, type PageDraft } from './api.ts';

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setStatus(await api.status());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, [reload]);

  if (!status) return <Splash error={error} />;
  if (!status.configured) return <Setup onDone={reload} />;
  return <Dashboard status={status} onChange={reload} />;
}

function Splash({ error }: { error: string | null }) {
  return (
    <main className="centre">
      <h1>inkpipe</h1>
      {error ? <p className="bad">{error}</p> : <p className="muted">connecting to the local service...</p>}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function Setup({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({
    serverUrl: '',
    joinToken: '',
    vaultRoot: '',
    notesPath: 'School/Semesters/Semester 5',
    attachmentsPath: 'Images',
    courses: '',
    defaultCourse: 'General',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const courses = form.courses
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((name) => ({ name, glossary: [] }));

      await api.setup({
        serverUrl: form.serverUrl.trim(),
        joinToken: form.joinToken.trim(),
        label: 'desktop',
        vault: {
          root: form.vaultRoot.trim(),
          notesPath: form.notesPath.trim(),
          attachmentsPath: form.attachmentsPath.trim(),
        },
        courses,
        defaultCourse: form.defaultCourse.trim() || 'General',
      });
      onDone();
    } catch (e) {
      setError(e instanceof ServiceError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="narrow">
      <h1>Set up inkpipe</h1>
      <p className="muted">
        Nothing here is hardcoded. These values live in your config file and can be changed later.
      </p>

      <form onSubmit={submit}>
        <fieldset>
          <legend>Your server</legend>
          <label>
            Server URL
            <input value={form.serverUrl} onChange={set('serverUrl')} placeholder="https://inkpipe.example.com" required />
          </label>
          <label>
            Join token
            <input value={form.joinToken} onChange={set('joinToken')} placeholder="printed by ops/bootstrap-vps.sh" required />
            <small>Printed on the server when you ran the bootstrap script.</small>
          </label>
        </fieldset>

        <fieldset>
          <legend>Your vault</legend>
          <label>
            Vault folder
            {/* JSX attributes are not escaped strings, so a single backslash
                here renders as a single backslash. */}
            <input value={form.vaultRoot} onChange={set('vaultRoot')} placeholder="C:\Users\you\vault" required />
            <small>Must be a git repository. inkpipe commits every note it writes.</small>
          </label>
          <label>
            Notes go in
            <input value={form.notesPath} onChange={set('notesPath')} required />
          </label>
          <label>
            Images go in
            <input value={form.attachmentsPath} onChange={set('attachmentsPath')} required />
          </label>
        </fieldset>

        <fieldset>
          <legend>Your courses</legend>
          <label>
            One per line
            <textarea value={form.courses} onChange={set('courses')} rows={5}
              placeholder={'Operating Systems\nAlgorithms and Data Structures\nNetwork Flow'} />
            <small>
              Course vocabulary is what stops the model looping on dense pages. It grows
              automatically from your corrections.
            </small>
          </label>
          <label>
            Default course
            <input value={form.defaultCourse} onChange={set('defaultCourse')} />
          </label>
        </fieldset>

        {error && <p className="bad">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Setting up...' : 'Finish setup'}</button>
      </form>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function Dashboard({ status, onChange }: { status: Status; onChange: () => void }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  const loadDrafts = useCallback(async () => {
    setDrafts((await api.drafts()).drafts);
  }, []);

  useEffect(() => { void loadDrafts(); }, [loadDrafts, status.drafts]);

  async function guarded(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ServiceError ? `${e.code}: ${e.message}` : (e as Error).message);
    } finally {
      setBusy(null);
      onChange();
    }
  }

  const current = drafts.find((d) => d.sessionId === open);

  return (
    <main>
      <header>
        <h1>inkpipe</h1>
        <div className="pills">
          <Pill ok={status.serverReachable} label="server" />
          <Pill ok={status.ollamaReachable} label={status.model ?? 'model'} />
          <Pill ok={status.vaultOk} label="vault" />
          <Pill ok={status.vaultClean} label="clean tree" />
        </div>
      </header>

      <section className="bar">
        <span><strong>{status.pending ?? 0}</strong> waiting on the server</span>
        <span><strong>{drafts.length}</strong> ready to review</span>
        <div className="spacer" />
        <button onClick={() => guarded('pair', async () => {
          const p = await api.pairing();
          setQr(await QRCode.toDataURL(p.qr, { width: 320, margin: 1 }));
        })} disabled={busy !== null}>Pair a phone</button>
        <button onClick={() => guarded('refresh', async () => {
          const r = await api.refresh();
          await loadDrafts();
          setMessage(`${r.drafts} note${r.drafts === 1 ? '' : 's'} ready`);
        })} disabled={busy !== null || !status.serverReachable}>
          {busy === 'refresh' ? 'Transcribing...' : 'Collect and transcribe'}
        </button>
        <button onClick={() => guarded('push', async () => {
          const r = await api.push();
          setMessage(`vault ${r.outcome}`);
        })} disabled={busy !== null}>Push vault</button>
      </section>

      {message && <p className="good">{message}</p>}
      {error && <p className="bad">{error}</p>}
      {status.lastError && !error && <p className="bad">last run: {status.lastError}</p>}

      {qr && (
        <div className="modal" onClick={() => setQr(null)}>
          <div className="card" onClick={(e) => e.stopPropagation()}>
            <h2>Scan with the inkpipe phone app</h2>
            <img src={qr} alt="pairing QR code" />
            <p className="muted">Valid for 5 minutes. Single use.</p>
            <button onClick={() => setQr(null)}>Close</button>
          </div>
        </div>
      )}

      {current
        ? <Preview draft={current} onClose={() => setOpen(null)} onApproved={async () => {
            setOpen(null);
            await loadDrafts();
            onChange();
          }} />
        : <DraftList drafts={drafts} onOpen={setOpen} />}
    </main>
  );
}

function Pill({ ok, label }: { ok: boolean | undefined; label: string }) {
  return <span className={`pill ${ok ? 'ok' : 'off'}`}>{label}</span>;
}

function DraftList({ drafts, onOpen }: { drafts: Draft[]; onOpen: (id: string) => void }) {
  if (drafts.length === 0) {
    return (
      <section className="empty">
        <p>Nothing to review.</p>
        <p className="muted">
          Photograph some pages on your phone, hit upload, then press
          {' '}<em>Collect and transcribe</em>.
        </p>
      </section>
    );
  }
  return (
    <section className="list">
      {drafts.map((draft) => {
        const failed = draft.pages.filter((p) => !p.ok).length;
        return (
          <button key={draft.sessionId} className="row" onClick={() => onOpen(draft.sessionId)}>
            <span className="title">{draft.suggestedTitle}</span>
            <span className="muted">{draft.course}</span>
            <span className="muted">{draft.pages.length} page{draft.pages.length === 1 ? '' : 's'}</span>
            {failed > 0 && <span className="warn">{failed} could not be read</span>}
          </button>
        );
      })}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Preview editor (decision 21: a full editor, not approve-or-reject)
// ---------------------------------------------------------------------------

function Preview({ draft, onClose, onApproved }: {
  draft: Draft;
  onClose: () => void;
  onApproved: () => void;
}) {
  const [title, setTitle] = useState(draft.suggestedTitle);
  const [course, setCourse] = useState(draft.course);
  const [pages, setPages] = useState(draft.pages.map((p) => p.markdown));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      // Terms the user typed that the model did not produce become glossary
      // candidates. This is the whole feedback loop: corrections make the next
      // transcription better AND become regression cases.
      const original = draft.pages.map((p) => p.markdown).join(' ').toLowerCase();
      const glossaryTerms = Array.from(new Set(
        pages.join(' ')
          .split(/[^A-Za-z()._-]+/)
          .filter((w) => w.length >= 4 && w.length <= 40)
          .filter((w) => !original.includes(w.toLowerCase())),
      )).slice(0, 25);

      await api.approve(draft.sessionId, {
        title: title.trim(),
        course: course.trim(),
        pages: draft.pages.map((p, i) => ({ blobId: p.blobId, markdown: pages[i] })),
        glossaryTerms,
      });
      onApproved();
    } catch (e) {
      setError(e instanceof ServiceError ? `${e.code}: ${e.message}` : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="preview">
      <div className="preview-head">
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Course
          <input value={course} onChange={(e) => setCourse(e.target.value)} />
        </label>
        <div className="spacer" />
        <button onClick={onClose} disabled={busy}>Back</button>
        <button className="primary" onClick={approve} disabled={busy || title.trim() === ''}>
          {busy ? 'Writing...' : 'Approve and commit'}
        </button>
      </div>

      {error && <p className="bad">{error}</p>}

      {draft.pages.map((page, i) => (
        <PagePane
          key={page.blobId}
          page={page}
          index={i}
          total={draft.pages.length}
          value={pages[i]}
          onChange={(v) => setPages((prev) => prev.map((p, j) => (j === i ? v : p)))}
        />
      ))}
    </section>
  );
}

function PagePane({ page, index, total, value, onChange }: {
  page: PageDraft;
  index: number;
  total: number;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="pane">
      <div className="pane-head">
        <strong>Page {index + 1} of {total}</strong>
        {page.ok
          ? <span className="muted">transcribed with the &quot;{page.variantUsed}&quot; prompt</span>
          : <span className="warn">could not be read: {page.failureReason}</span>}
        {page.sanitiserChanges.length > 0 && (
          <span className="warn">altered for safety: {page.sanitiserChanges.join('; ')}</span>
        )}
      </div>
      <div className="pane-body">
        {/* The photograph sits beside the text so a wrong transcription is
            visible rather than merely possible. */}
        <img src={page.imageDataUrl} alt={`page ${index + 1}`} />
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          placeholder={page.ok ? '' : 'This page could not be transcribed. Type it yourself, or leave it blank and keep the photograph.'}
        />
      </div>
    </div>
  );
}
