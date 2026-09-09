import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, ScrollView, Image, ActivityIndicator, Alert,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import { randomUUID } from 'expo-crypto';

import { InkpipeClient } from '@inkpipe/client';
import { generateIdentityKeyPair, toBase64Url } from '@inkpipe/crypto';
import { parsePairingQr } from './src/pairing.ts';
import { uploadPending, type UploadProgress } from './src/upload.ts';
import {
  loadPairing, savePairing, saveIdentity, loadIdentity, clearPairing,
  readManifest, addCapture, updateCapture, capturesDir,
  type Pairing, type Capture,
} from './src/store.ts';
import { bytesUsed, shouldWarn, DEFAULT_RETENTION } from './src/retention.ts';

type Screen = 'loading' | 'pair' | 'capture' | 'queue';

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);

  const refresh = useCallback(async () => {
    setCaptures(await readManifest());
  }, []);

  useEffect(() => {
    void (async () => {
      const existing = await loadPairing();
      setPairing(existing);
      await refresh();
      setScreen(existing ? 'capture' : 'pair');
    })();
  }, [refresh]);

  if (screen === 'loading') {
    return (
      <View style={[styles.screen, styles.centre]}>
        <ActivityIndicator color="#6ea8fe" />
        <StatusBar style="light" />
      </View>
    );
  }

  if (screen === 'pair' || !pairing) {
    return (
      <PairScreen
        onPaired={async (next) => {
          setPairing(next);
          await refresh();
          setScreen('capture');
        }}
      />
    );
  }

  if (screen === 'queue') {
    return (
      <QueueScreen
        pairing={pairing}
        captures={captures}
        onBack={() => setScreen('capture')}
        onChanged={refresh}
        onUnpair={async () => {
          await clearPairing();
          setPairing(null);
          setScreen('pair');
        }}
      />
    );
  }

  return (
    <CaptureScreen
      captures={captures}
      onChanged={refresh}
      onOpenQueue={() => setScreen('queue')}
    />
  );
}

// ---------------------------------------------------------------------------
// Pair
// ---------------------------------------------------------------------------

function PairScreen({ onPaired }: { onPaired: (pairing: Pairing) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A camera fires the same code many times a second. Without this guard the
  // single-use pairing token is redeemed once and then fails on every repeat,
  // showing an error over a pairing that actually succeeded.
  const claimed = useRef(false);

  async function handleScan(raw: string) {
    if (claimed.current) return;
    claimed.current = true;
    setBusy(true);
    setError(null);

    try {
      const qr = parsePairingQr(raw);
      const identity = generateIdentityKeyPair();

      const paired = await new InkpipeClient({ baseUrl: qr.serverUrl })
        .post<{ deviceId: string; x25519PublicKey: string }>('/pair/complete', {
          pairingToken: qr.pairingToken,
          ed25519PublicKey: toBase64Url(identity.publicKey),
          label: 'phone',
        });

      await saveIdentity(identity);
      const pairing: Pairing = {
        serverUrl: qr.serverUrl,
        deviceId: paired.deviceId,
        x25519PublicKey: paired.x25519PublicKey,
        pairedAt: new Date().toISOString(),
      };
      await savePairing(pairing);
      onPaired(pairing);
    } catch (e) {
      setError((e as Error).message);
      claimed.current = false;
    } finally {
      setBusy(false);
    }
  }

  if (!permission) {
    return <View style={[styles.screen, styles.centre]}><ActivityIndicator color="#6ea8fe" /></View>;
  }

  if (!permission.granted) {
    return (
      <View style={[styles.screen, styles.centre, styles.pad]}>
        <Text style={styles.h1}>inkpipe</Text>
        <Text style={styles.muted}>
          The camera is needed to scan the pairing code shown by the desktop app,
          and to photograph your notes.
        </Text>
        <Pressable style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Allow camera</Text>
        </Pressable>
        <StatusBar style="light" />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => void handleScan(data)}
      />
      <View style={styles.scanOverlay}>
        <Text style={styles.h1}>Scan the pairing code</Text>
        <Text style={styles.muted}>Open the desktop app and press &quot;Pair a phone&quot;.</Text>
        {busy && <ActivityIndicator color="#6ea8fe" style={{ marginTop: 12 }} />}
        {error && <Text style={styles.bad}>{error}</Text>}
      </View>
      <StatusBar style="light" />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

function CaptureScreen({ captures, onChanged, onOpenQueue }: {
  captures: Capture[];
  onChanged: () => Promise<void>;
  onOpenQueue: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView | null>(null);
  const [sessionId, setSessionId] = useState(() => randomUUID());
  const [shots, setShots] = useState<Capture[]>([]);
  const [busy, setBusy] = useState(false);

  const pending = captures.filter((c) => c.state !== 'uploaded').length;

  async function shoot() {
    if (!camera.current || busy) return;
    setBusy(true);
    try {
      const photo = await camera.current.takePictureAsync({ quality: 0.9, skipProcessing: false });
      if (!photo?.uri) return;

      const blobId = randomUUID();
      const target = `${capturesDir()}${blobId}.jpg`;
      await FileSystem.moveAsync({ from: photo.uri, to: target });
      const info = await FileSystem.getInfoAsync(target, { size: true });

      const capture = {
        blobId,
        sessionId,
        seq: shots.length,
        uri: target,
        bytes: info.exists && 'size' in info ? info.size : 0,
        capturedAt: new Date().toISOString(),
      };
      await addCapture(capture);
      setShots((prev) => [...prev, { ...capture, state: 'pending' as const }]);
      await onChanged();
    } catch (error) {
      Alert.alert('Could not save that photo', (error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function finishSession() {
    // One note per capture session, decision 9. Starting a new session is how
    // the user says "that lecture is done".
    setShots([]);
    setSessionId(randomUUID());
    onOpenQueue();
  }

  if (!permission?.granted) {
    return (
      <View style={[styles.screen, styles.centre, styles.pad]}>
        <Text style={styles.h1}>Camera needed</Text>
        <Pressable style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" />

      {/* Framing guide. Getting the page square and upright is the single
          biggest lever on transcription accuracy, per ADR 0001. */}
      <View pointerEvents="none" style={styles.frameGuide} />

      <View style={styles.captureTop}>
        <Text style={styles.muted}>
          {shots.length === 0 ? 'Page 1' : `${shots.length} page${shots.length === 1 ? '' : 's'} in this note`}
        </Text>
        <Text style={styles.hint}>Fill the frame. Avoid shadows. Keep the page upright.</Text>
      </View>

      <View style={styles.captureBottom}>
        <Pressable style={styles.secondary} onPress={onOpenQueue}>
          <Text style={styles.secondaryText}>Queue{pending > 0 ? ` (${pending})` : ''}</Text>
        </Pressable>

        <Pressable style={[styles.shutter, busy && styles.shutterBusy]} onPress={shoot} disabled={busy} />

        <Pressable
          style={[styles.secondary, shots.length === 0 && styles.disabled]}
          onPress={finishSession}
          disabled={shots.length === 0}
        >
          <Text style={styles.secondaryText}>Done</Text>
        </Pressable>
      </View>

      <StatusBar style="light" />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

function QueueScreen({ pairing, captures, onBack, onChanged, onUnpair }: {
  pairing: Pairing;
  captures: Capture[];
  onBack: () => void;
  onChanged: () => Promise<void>;
  onUnpair: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const pending = captures.filter((c) => c.state !== 'uploaded');
  const used = bytesUsed(captures);
  const warn = shouldWarn(captures);

  async function upload() {
    const identity = await loadIdentity();
    if (!identity) {
      Alert.alert('Not paired', 'This phone has lost its key. Pair it again from the desktop.');
      return;
    }

    setBusy(true);
    setSummary(null);
    try {
      const result = await uploadPending(pending, pairing, identity, async (p) => {
        setProgress(p);
        if (p.state === 'uploaded') await updateCapture(p.blobId, { state: 'uploaded', error: undefined });
        if (p.state === 'failed') await updateCapture(p.blobId, { state: 'failed', error: p.error });
      });
      await onChanged();
      setSummary(
        result.failed === 0
          ? `${result.uploaded} page${result.uploaded === 1 ? '' : 's'} uploaded.`
          : `${result.uploaded} uploaded, ${result.failed} failed.`,
      );
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <View style={[styles.screen, styles.pad]}>
      <View style={styles.row}>
        <Pressable onPress={onBack}><Text style={styles.link}>Back to camera</Text></Pressable>
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => Alert.alert(
          'Unpair this phone?',
          'Pages already uploaded are unaffected. Pages still waiting here can no longer be sent.',
          [{ text: 'Cancel', style: 'cancel' }, { text: 'Unpair', style: 'destructive', onPress: () => void onUnpair() }],
        )}>
          <Text style={styles.linkMuted}>Unpair</Text>
        </Pressable>
      </View>

      <Text style={styles.h1}>Queue</Text>
      <Text style={styles.muted}>
        {pending.length} waiting, {captures.length - pending.length} uploaded
      </Text>
      <Text style={warn ? styles.bad : styles.muted}>
        {(used / 1048576).toFixed(0)} MB of {(DEFAULT_RETENTION.bytes / 1073741824).toFixed(0)} GB used
        {warn ? '. Running low: upload and let old pages expire.' : ''}
      </Text>

      <Pressable
        style={[styles.button, (busy || pending.length === 0) && styles.disabled]}
        onPress={upload}
        disabled={busy || pending.length === 0}
      >
        <Text style={styles.buttonText}>
          {busy ? `Uploading page ${(progress?.seq ?? 0) + 1}...` : `Upload ${pending.length} page${pending.length === 1 ? '' : 's'}`}
        </Text>
      </Pressable>

      {summary && <Text style={styles.good}>{summary}</Text>}

      <ScrollView style={{ marginTop: 12 }}>
        {captures.slice().reverse().map((capture) => (
          <View key={capture.blobId} style={styles.queueRow}>
            <Image source={{ uri: capture.uri }} style={styles.thumb} />
            <View style={{ flex: 1 }}>
              <Text style={styles.queueTitle}>
                Page {capture.seq + 1} - {(capture.bytes / 1048576).toFixed(1)} MB
              </Text>
              <Text style={capture.state === 'failed' ? styles.bad : styles.muted}>
                {capture.state === 'uploaded' ? 'uploaded'
                  : capture.state === 'failed' ? (capture.error ?? 'failed')
                  : 'waiting'}
              </Text>
            </View>
          </View>
        ))}
        {captures.length === 0 && <Text style={styles.muted}>Nothing captured yet.</Text>}
      </ScrollView>

      <StatusBar style="light" />
    </View>
  );
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#14161a' },
  centre: { alignItems: 'center', justifyContent: 'center' },
  pad: { padding: 20, paddingTop: 56 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },

  h1: { color: '#e6e8ec', fontSize: 22, fontWeight: '600', marginBottom: 6 },
  muted: { color: '#949aa6', fontSize: 14, marginBottom: 4 },
  hint: { color: '#6f7784', fontSize: 12 },
  good: { color: '#4ec9a5', marginTop: 10 },
  bad: { color: '#e8756b', marginTop: 6 },
  link: { color: '#6ea8fe', fontSize: 14 },
  linkMuted: { color: '#949aa6', fontSize: 14 },

  button: {
    backgroundColor: '#6ea8fe', borderRadius: 10, paddingVertical: 13,
    alignItems: 'center', marginTop: 16,
  },
  buttonText: { color: '#10131a', fontWeight: '700', fontSize: 15 },
  disabled: { opacity: 0.4 },

  secondary: {
    borderColor: '#2c313b', borderWidth: 1, borderRadius: 9,
    paddingVertical: 10, paddingHorizontal: 16, backgroundColor: 'rgba(20,22,26,0.75)',
  },
  secondaryText: { color: '#e6e8ec', fontSize: 14 },

  scanOverlay: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    padding: 24, paddingBottom: 48, backgroundColor: 'rgba(20,22,26,0.85)',
  },

  frameGuide: {
    position: 'absolute', top: '12%', left: '6%', right: '6%', bottom: '22%',
    borderWidth: 2, borderColor: 'rgba(110,168,254,0.6)', borderRadius: 8,
  },
  captureTop: {
    position: 'absolute', top: 0, left: 0, right: 0,
    padding: 20, paddingTop: 52, backgroundColor: 'rgba(20,22,26,0.7)',
  },
  captureBottom: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: 20, paddingBottom: 40, backgroundColor: 'rgba(20,22,26,0.7)',
  },
  shutter: {
    width: 74, height: 74, borderRadius: 37,
    backgroundColor: '#e6e8ec', borderWidth: 5, borderColor: '#6ea8fe',
  },
  shutterBusy: { opacity: 0.5 },

  queueRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#22262e',
  },
  thumb: { width: 46, height: 60, borderRadius: 4, backgroundColor: '#0d0f13' },
  queueTitle: { color: '#e6e8ec', fontSize: 14, marginBottom: 2 },
});
