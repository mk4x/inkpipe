// The setup wizard (issue #7).
//
// Six steps rather than one long form, because two of them cannot be rushed:
// choosing a model needs Ollama to actually be there, and the recovery phrase
// is shown exactly once and can never be recovered if it is skipped.
//
// The phrase step deliberately refuses to advance until the user confirms, and
// it is the only step in the wizard that cannot be gone back to.

import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api, ServiceError, type OllamaStatus, type PullState } from './api.ts';

type Step = 'start' | 'server' | 'vault' | 'courses' | 'model' | 'recovery' | 'pair' | 'done';

const NEW_STEPS: Step[] = ['start', 'server', 'vault', 'courses', 'model', 'recovery', 'pair'];
const RESTORE_STEPS: Step[] = ['start', 'server', 'vault', 'courses', 'model', 'pair'];

export interface WizardForm {
  mode: 'new' | 'restore';
  recoveryPhrase: string;
  serverUrl: string;
  joinToken: string;
  vaultRoot: string;
  notesPath: string;
  attachmentsPath: string;
  courses: string;
  defaultCourse: string;
  modelName: string;
  modelHost: string;
  numCtx: number;
}

const EMPTY: WizardForm = {
  mode: 'new',
  recoveryPhrase: '',
  serverUrl: '',
  joinToken: '',
  vaultRoot: '',
  notesPath: 'School/Semesters/Semester 5',
  attachmentsPath: 'Images',
  courses: '',
  defaultCourse: 'General',
  modelName: 'qwen2.5vl:7b',
  modelHost: 'http://127.0.0.1:11434',
  numCtx: 4096,
};

export default function Wizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>('start');
  const [form, setForm] = useState<WizardForm>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phrase, setPhrase] = useState<string | null>(null);

  const steps = form.mode === 'new' ? NEW_STEPS : RESTORE_STEPS;
  const index = steps.indexOf(step);

  const set = <K extends keyof WizardForm>(key: K) =>
    (e: { target: { value: string } }) =>
      setForm((f) => ({ ...f, [key]: e.target.value as WizardForm[K] }));

  function next() {
    setError(null);
    setStep(steps[Math.min(index + 1, steps.length - 1)]);
  }
  function back() {
    setError(null);
    setStep(steps[Math.max(index - 1, 0)]);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const courses = form.courses
        .split('\n').map((l) => l.trim()).filter(Boolean)
        .map((name) => ({ name, glossary: [] }));

      const payload = {
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
        model: { name: form.modelName, host: form.modelHost, numCtx: form.numCtx },
      };

      if (form.mode === 'restore') {
        const result = await api.restore({ ...payload, recoveryPhrase: form.recoveryPhrase });
        if (!result.restored) {
          // The phrase was valid but this server has never seen it. Almost
          // always the wrong server or a phrase from a different install.
          setError(
            'That phrase is valid, but this server has no record of it. ' +
            'Check the server address: nothing was recovered, a new account was created.',
          );
        }
        setStep('pair');
      } else {
        const result = await api.setup(payload);
        setPhrase(result.recoveryPhrase);
        setStep('recovery');
      }
    } catch (e) {
      setError(e instanceof ServiceError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="narrow">
      <h1>Set up inkpipe</h1>
      {step !== 'start' && (
        <div className="steps">
          {steps.slice(1).map((s, i) => (
            <span key={s} className={`stepdot ${steps.indexOf(s) <= index ? 'on' : ''}`}>
              {i + 1}
            </span>
          ))}
        </div>
      )}

      {error && <p className="bad">{error}</p>}

      {step === 'start' && (
        <StartStep
          onNew={() => { setForm((f) => ({ ...f, mode: 'new' })); setStep('server'); }}
          onRestore={() => { setForm((f) => ({ ...f, mode: 'restore' })); setStep('server'); }}
        />
      )}

      {step === 'server' && (
        <StepShell title="Your server" onBack={back} onNext={next}
          canNext={form.serverUrl.trim().length > 0 && form.joinToken.trim().length > 0
            && (form.mode === 'new' || form.recoveryPhrase.trim().split(/\s+/).length === 24)}>
          <label>
            Server URL
            <input value={form.serverUrl} onChange={set('serverUrl')} placeholder="https://inkpipe.example.com" />
          </label>
          <label>
            Join token
            <input value={form.joinToken} onChange={set('joinToken')} placeholder="printed by ops/bootstrap-vps.sh" />
            <small>Run <code>sudo grep INKPIPE_JOIN_TOKEN /etc/inkpipe.env</code> on the server.</small>
          </label>
          {form.mode === 'restore' && (
            <label>
              Recovery phrase
              <textarea rows={4} value={form.recoveryPhrase} onChange={set('recoveryPhrase')}
                placeholder="the 24 words you wrote down when you first set inkpipe up" />
              <small>
                {form.recoveryPhrase.trim().split(/\s+/).filter(Boolean).length} of 24 words.
                Capitalisation, extra spaces and line breaks do not matter.
              </small>
            </label>
          )}
        </StepShell>
      )}

      {step === 'vault' && (
        <StepShell title="Your vault" onBack={back} onNext={next}
          canNext={form.vaultRoot.trim().length > 0 && form.notesPath.trim().length > 0}>
          <label>
            Vault folder
            <input value={form.vaultRoot} onChange={set('vaultRoot')} placeholder="C:\Users\you\vault" />
            <small>Must be a git repository. inkpipe commits every note it writes.</small>
          </label>
          <label>
            Notes go in
            <input value={form.notesPath} onChange={set('notesPath')} />
          </label>
          <label>
            Images go in
            <input value={form.attachmentsPath} onChange={set('attachmentsPath')} />
          </label>
        </StepShell>
      )}

      {step === 'courses' && (
        <StepShell title="Your courses" onBack={back} onNext={next} canNext>
          <label>
            One per line
            <textarea rows={6} value={form.courses} onChange={set('courses')}
              placeholder={'Operating Systems\nAlgorithms and Data Structures\nNetwork Flow'} />
            <small>
              Course vocabulary is what stops the model collapsing into a repetition loop on a
              dense page. It grows automatically from your corrections, so this is a starting
              point rather than a final list.
            </small>
          </label>
          <label>
            Default course
            <input value={form.defaultCourse} onChange={set('defaultCourse')} />
          </label>
        </StepShell>
      )}

      {/* The model step is the last one that collects anything, so it submits
          for both paths. An extra "Continue" here previously advanced to a
          recovery screen that had no phrase yet, and rendered blank. */}
      {step === 'model' && (
        <ModelStep form={form} setForm={setForm} onBack={back}
          onNext={submit} busy={busy}
          nextLabel={form.mode === 'restore' ? 'Restore my account' : 'Create my account'} />
      )}

      {step === 'recovery' && phrase && (
        <RecoveryStep phrase={phrase} onConfirmed={() => setStep('pair')} />
      )}

      {step === 'pair' && <PairStep onDone={onDone} />}
    </main>
  );
}

// ---------------------------------------------------------------------------

function StepShell({ title, children, onBack, onNext, canNext, nextLabel = 'Continue', busy }: {
  title: string;
  children: React.ReactNode;
  onBack: () => void;
  onNext: () => void;
  canNext: boolean;
  nextLabel?: string;
  busy?: boolean;
}) {
  return (
    <>
      <fieldset>
        <legend>{title}</legend>
        {children}
      </fieldset>
      <div className="wizard-actions">
        <button onClick={onBack} disabled={busy}>Back</button>
        <div className="spacer" />
        <button className="primary" onClick={onNext} disabled={!canNext || busy}>
          {busy ? 'Working...' : nextLabel}
        </button>
      </div>
    </>
  );
}

function StartStep({ onNew, onRestore }: { onNew: () => void; onRestore: () => void }) {
  return (
    <>
      <p className="muted">
        inkpipe turns photographs of your handwritten notes into Markdown in your Obsidian
        vault, transcribed by a model running on this machine.
      </p>
      <div className="choices">
        <button className="choice" onClick={onNew}>
          <strong>Set up a new account</strong>
          <span className="muted">First time on this server.</span>
        </button>
        <button className="choice" onClick={onRestore}>
          <strong>Restore from a recovery phrase</strong>
          <span className="muted">
            New machine, or a second desktop on an account you already have.
          </span>
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Model step: the one that needs Ollama to really be there
// ---------------------------------------------------------------------------

function ModelStep({ form, setForm, onBack, onNext, busy, nextLabel }: {
  form: WizardForm;
  setForm: React.Dispatch<React.SetStateAction<WizardForm>>;
  onBack: () => void;
  onNext: () => void;
  busy: boolean;
  nextLabel: string;
}) {
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [pull, setPull] = useState<PullState | null>(null);
  const [probe, setProbe] = useState<{ ok: boolean; message: string; suggestedNumCtx?: number } | null>(null);
  const [working, setWorking] = useState(false);
  const polling = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.ollamaStatus(form.modelHost));
    } catch { /* shown as not running */ }
  }, [form.modelHost]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  // While a pull runs, poll faster and stop as soon as it finishes.
  useEffect(() => {
    if (!pull || pull.done) {
      if (polling.current) { clearInterval(polling.current); polling.current = null; }
      return;
    }
    polling.current = window.setInterval(async () => {
      const next = await api.pullStatus();
      setPull(next);
      if (next.done) void refresh();
    }, 700);
    return () => { if (polling.current) clearInterval(polling.current); };
  }, [pull, refresh]);

  const installed = status?.models.some((m) => m.name === form.modelName) ?? false;

  async function startPull() {
    setWorking(true);
    try {
      await api.pullModel(form.modelName, form.modelHost);
      setPull({ model: form.modelName, status: 'starting', done: false });
    } finally {
      setWorking(false);
    }
  }

  async function runProbe() {
    setWorking(true);
    setProbe(null);
    try {
      setProbe(await api.probeModel(form.modelName, form.numCtx, form.modelHost));
    } catch (e) {
      setProbe({ ok: false, message: (e as Error).message });
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <fieldset>
        <legend>The model</legend>

        {!status && <p className="muted">Checking for Ollama...</p>}

        {status && !status.installed && (
          <div className="notice">
            <strong>Ollama is not installed.</strong>
            <p className="muted">
              inkpipe will not install it for you silently. Run this yourself, then press
              re-check. {status.install?.note}
            </p>
            <pre className="cmd">{status.install?.command}</pre>
            <button onClick={() => void refresh()}>Re-check</button>
          </div>
        )}

        {status?.installed && !status.running && (
          <div className="notice">
            <strong>Ollama is installed but not running.</strong>
            <pre className="cmd">ollama serve</pre>
            <button onClick={() => void refresh()}>Re-check</button>
          </div>
        )}

        {status?.running && (
          <>
            <label>
              Model
              <input value={form.modelName}
                onChange={(e) => setForm((f) => ({ ...f, modelName: e.target.value }))} />
              <small>
                {status.recommended.map((r) => (
                  <button key={r.name} className="chip" onClick={() =>
                    setForm((f) => ({ ...f, modelName: r.name }))}>
                    {r.label}{r.recommended ? ' (measured best)' : ''}
                  </button>
                ))}
              </small>
            </label>

            {status.rejected[form.modelName] && (
              <p className="warn">{status.rejected[form.modelName]}</p>
            )}

            {installed
              ? <p className="good">{form.modelName} is installed.</p>
              : (
                <div>
                  <p className="muted">{form.modelName} is not downloaded yet.</p>
                  {pull && !pull.done && (
                    <p className="muted">
                      {pull.status}{pull.percent !== undefined ? ` ${pull.percent}%` : ''}
                    </p>
                  )}
                  {pull?.error && <p className="bad">{pull.error}</p>}
                  <button onClick={() => void startPull()} disabled={working || (pull ? !pull.done : false)}>
                    {pull && !pull.done ? 'Downloading...' : `Download ${form.modelName}`}
                  </button>
                </div>
              )}

            <label>
              Context size
              <input type="number" value={form.numCtx}
                onChange={(e) => setForm((f) => ({ ...f, numCtx: Number(e.target.value) || 4096 }))} />
              <small>
                Image token cost varies more than fourfold between models, so this is checked
                against a real page rather than assumed. A page that overflows fails mid-session.
              </small>
            </label>

            <div>
              <button onClick={() => void runProbe()} disabled={working || !installed}>
                Check a real page fits
              </button>
              {probe && (
                <p className={probe.ok ? 'good' : 'warn'}>
                  {probe.message}
                  {probe.suggestedNumCtx && (
                    <>
                      {' '}
                      <button className="chip" onClick={() =>
                        setForm((f) => ({ ...f, numCtx: probe.suggestedNumCtx! }))}>
                        Use {probe.suggestedNumCtx}
                      </button>
                    </>
                  )}
                </p>
              )}
            </div>
          </>
        )}
      </fieldset>

      <div className="wizard-actions">
        <button onClick={onBack} disabled={busy}>Back</button>
        <div className="spacer" />
        <button className="primary" onClick={onNext} disabled={busy}>
          {busy ? 'Working...' : nextLabel}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Recovery: shown once, and only once
// ---------------------------------------------------------------------------

function RecoveryStep({ phrase, onConfirmed }: { phrase: string; onConfirmed: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const words = phrase.split(' ');
  const rows: string[][] = [];
  for (let i = 0; i < words.length; i += 4) rows.push(words.slice(i, i + 4));

  return (
    <>
      <fieldset>
        <legend>Your recovery phrase</legend>
        <p className="bad">
          <strong>Write this down now. It is shown once and never again.</strong>
        </p>
        <p className="muted">
          These 24 words are the only way to recover your notes if this machine dies. They are
          not stored anywhere, not on this computer and not on your server, so nobody can
          retrieve them for you. Without them, every page still waiting on the server becomes
          permanently unreadable.
        </p>
        <p className="muted">The same phrase also lets you add a second computer to this account.</p>

        <div className="phrase">
          {rows.map((row, r) => (
            <div key={r} className="phrase-row">
              {row.map((word, c) => (
                <span key={word + c} className="phrase-word">
                  <em>{r * 4 + c + 1}</em>{word}
                </span>
              ))}
            </div>
          ))}
        </div>

        <div className="row">
          <button onClick={() => {
            void navigator.clipboard.writeText(phrase);
            setCopied(true);
          }}>{copied ? 'Copied' : 'Copy to clipboard'}</button>
          <small className="muted">
            Paper is safer than a clipboard. Anything that can read your clipboard can read this.
          </small>
        </div>

        <label className="check">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          I have written down all 24 words and stored them somewhere safe.
        </label>
      </fieldset>

      <div className="wizard-actions">
        <div className="spacer" />
        <button className="primary" onClick={onConfirmed} disabled={!confirmed}>
          Continue
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function PairStep({ onDone }: { onDone: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const pairing = await api.pairing();
        setQr(await QRCode.toDataURL(pairing.qr, { width: 300, margin: 1 }));
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);

  return (
    <>
      <fieldset>
        <legend>Pair your phone</legend>
        <p className="muted">
          Install the inkpipe app on your Android phone and scan this. The code is valid for
          five minutes and can be used once. You can generate more later from the dashboard.
        </p>
        {error && <p className="bad">{error}</p>}
        {qr
          ? <div style={{ textAlign: 'center' }}><img src={qr} alt="pairing QR code" className="qr" /></div>
          : <p className="muted">Generating...</p>}
      </fieldset>
      <div className="wizard-actions">
        <div className="spacer" />
        <button className="primary" onClick={onDone}>Finish</button>
      </div>
    </>
  );
}
