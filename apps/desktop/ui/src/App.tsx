import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, ServiceError, type Status, type Draft, type PageDraft, type DeviceSummary } from './api.ts';
import Wizard from './Wizard.tsx';

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Decided once, from the first status, and then owned by the wizard.
  //
  // This must NOT be derived from status.configured on every poll. Setup makes
  // configured flip to true several steps before the wizard is finished, and
  // re-deriving swapped the wizard out for the dashboard mid-flow. The screen
  // that got skipped was the recovery phrase, which is shown exactly once and
  // cannot be recovered, so the bug silently cost the user their only copy.
  const [inWizard, setInWizard] = useState<boolean | null>(null);

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

  useEffect(() => {
    if (status && inWizard === null) setInWizard(!status.configured);
  }, [status, inWizard]);

  if (!status || inWizard === null) return <Splash error={error} />;
  if (inWizard) {
    return <Wizard onDone={() => { setInWizard(false); void reload(); }} />;
  }
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
// Devices
//
// Pairing is easy to lose track of once it has happened more than once, and a
// device you cannot see is a device you cannot revoke. Pairing again ADDS a
// device rather than replacing one, which is not obvious and is why the pairing
// dialog now says so.
// ---------------------------------------------------------------------------

/** "3 minutes ago", because an ISO timestamp answers the wrong question. */
function ago(iso: string | null): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return 'just now';
  const units: Array<[number, string]> = [
    [60, 'minute'], [3600, 'hour'], [86400, 'day'], [604800, 'week'],
  ];
  let label = 'a long time';
  for (const [size, name] of units) {
    const n = Math.floor(seconds / size);
    if (n >= 1 && n < 100) label = `${n} ${name}${n === 1 ? '' : 's'}`;
  }
  return `${label} ago`;
}

function Devices({ onClose }: { onClose: () => void }) {
  const [devices, setDevices] = useState<DeviceSummary[] | null>(null);
  const [self, setSelf] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.devices();
      setDevices(result.devices);
      setSelf(result.self);
    } catch (e) {
      setError(e instanceof ServiceError ? `${e.code}: ${e.message}` : (e as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function revoke(device: DeviceSummary) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.revokeDevice(device.id);
      setMessage(
        result.deletedBlobs > 0
          ? `Revoked ${result.label}, and discarded ${result.deletedBlobs} page(s) it had uploaded.`
          : `Revoked ${result.label}.`,
      );
      setConfirming(null);
      await load();
    } catch (e) {
      setError(e instanceof ServiceError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal" onClick={onClose}>
      <div className="card wide" onClick={(e) => e.stopPropagation()}>
        <h2>Paired devices</h2>

        {error && <p className="bad">{error}</p>}
        {message && <p className="good">{message}</p>}
        {devices === null && !error && <p className="muted">asking the server...</p>}

        {devices?.length === 0 && <p className="muted">Nothing is paired yet.</p>}

        {devices?.map((d) => (
          <div key={d.id} className="device">
            <div>
              <strong>{d.label}</strong>
              <span className="muted"> {d.role === 'pc' ? 'desktop' : 'phone'}</span>
              {d.id === self && <span className="muted"> this one</span>}
              <div className="muted">
                last seen {ago(d.lastSeenAt)}, paired {ago(d.createdAt)}
                {d.pendingBlobs > 0 && `, ${d.pendingBlobs} page(s) on the server`}
              </div>
            </div>
            <div className="spacer" />
            {d.id === self
              ? <span className="muted">cannot revoke itself</span>
              : confirming === d.id
                ? (
                  <>
                    {/* Revoking destroys anything that device uploaded and has
                        not been collected, so the count is in the button. */}
                    <button className="danger" disabled={busy} onClick={() => void revoke(d)}>
                      {d.pendingBlobs > 0
                        ? `Revoke and discard ${d.pendingBlobs} page(s)`
                        : 'Really revoke'}
                    </button>
                    <button disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
                  </>
                )
                : <button disabled={busy} onClick={() => setConfirming(d.id)}>Revoke</button>}
          </div>
        ))}

        <p className="muted">
          Revoking a device stops it uploading. On a phone you still have, use Unpair
          in the app instead, which also clears its copy of the keys.
        </p>
        <button onClick={onClose}>Close</button>
      </div>
    </div>
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
  const [showDevices, setShowDevices] = useState(false);

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
        <button onClick={() => setShowDevices(true)} disabled={busy !== null}>Devices</button>
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
            <p className="muted">
              Pairing again does not replace the old device. It adds one, so revoke
              anything you no longer use from Devices.
            </p>
            <button onClick={() => setQr(null)}>Close</button>
          </div>
        </div>
      )}

      {showDevices && <Devices onClose={() => { setShowDevices(false); onChange(); }} />}

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
  // Issue #8. Good unless the reader says otherwise, so approving without an
  // opinion still works and simply records no complaint.
  const [verdicts, setVerdicts] = useState<Array<'good' | 'bad'>>(
    draft.pages.map(() => 'good'),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      // Corrections are derived on the server, by diffing this text against
      // what the model produced. An earlier version did it here by splitting
      // on punctuation with no noise filter, which put words like "the" into
      // the glossary.
      await api.approve(draft.sessionId, {
        title: title.trim(),
        course: course.trim(),
        pages: draft.pages.map((p, i) => ({
          blobId: p.blobId,
          markdown: pages[i],
          verdict: verdicts[i],
        })),
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
          verdict={verdicts[i]}
          onVerdict={(v) => setVerdicts((prev) => prev.map((p, j) => (j === i ? v : p)))}
          onChange={(v) => setPages((prev) => prev.map((p, j) => (j === i ? v : p)))}
        />
      ))}

      <Explanations draft={draft} />
    </section>
  );
}

/**
 * What the model added, shown before it reaches the vault.
 *
 * Decision 21 made this a full editor and CLAUDE.md rule 7 says nothing reaches
 * the vault without a human. Explanations were going into the written note
 * without ever appearing on this screen, which quietly broke both. The
 * disputed ones matter most: they mean the sources contradict the page, which
 * usually means the page is wrong.
 */
function Explanations({ draft }: { draft: Draft }) {
  const expansions = draft.expansions ?? [];
  if (expansions.length === 0 && !draft.expansionError) return null;

  const flagged = expansions.filter(
    (e) => e.confidence === 'disputed' || e.confidence === 'unsupported',
  );

  return (
    <div className="pane">
      <div className="pane-head">
        <strong>Explanations</strong>
        <span className="muted">added by the model, not on your page</span>
        {flagged.length > 0 && (
          <span className="warn">{flagged.length} need checking</span>
        )}
      </div>
      <div className="explanations">
        {draft.expansionError && (
          <p className="warn">These could not be generated: {draft.expansionError}</p>
        )}
        {expansions.map((e) => (
          <div key={e.term} className={`expansion ${e.confidence}`}>
            <strong>{e.term}</strong>
            <span className="muted"> {e.confidence}</span>
            {e.text && <p>{e.text}</p>}
            {e.reason && <p className="muted">{e.reason}</p>}
            {e.sources.length > 0 && (
              <p className="muted">
                Sources: {e.sources.map((s) => hostOf(s.url)).join(', ')}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Bare hostname. These URLs came from a search engine, so they are named
 *  rather than linked: CLAUDE.md rule 5, generated content stays inert. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function PagePane({ page, index, total, value, verdict, onVerdict, onChange }: {
  page: PageDraft;
  index: number;
  total: number;
  value: string;
  verdict: 'good' | 'bad';
  onVerdict: (v: 'good' | 'bad') => void;
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
        <div className="spacer" />
        {/* Issue #8. A rejected page becomes a golden corpus candidate, which
            is what the corpus is short of: pages the pipeline got wrong. */}
        <button
          className={verdict === 'bad' ? 'verdict active' : 'verdict'}
          onClick={() => onVerdict(verdict === 'bad' ? 'good' : 'bad')}
          title="Mark this page as badly transcribed, so it becomes a test case"
        >
          {verdict === 'bad' ? 'Marked as bad' : 'This came out wrong'}
        </button>
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
