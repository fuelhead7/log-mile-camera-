import { useCallback, useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, FlatList, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import * as Picker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import { randomUUID } from 'expo-crypto';
import { captureRef } from 'react-native-view-shot';
import { listEntries, photoFile, saveEntry, type Entry, type PhotoTag } from '@/lib/logbook';
import { lookupRoad, sourceLabel, type Fix, type Lookup, type Match } from '@/lib/roadway';

const colors = { bg: '#111827', card: '#1c2738', line: '#354559', text: '#f5f8fc', muted: '#aab9cb', blue: '#36baf2', button: '#087fb4', green: '#17814a' };
const blankTag = (): PhotoTag => ({ route: '', direction: '', county: '', mile: '', notes: '', fix: null, estimate: null, source: 'unset' });
const demoFix = { latitude: 36.169075, longitude: -86.873255, accuracy: 8, heading: 327, speed: 0, timestamp: 0 };
const demoMatch = { route: 'SR 155', county: 'Davidson County', mile: 26.03, routeId: 'demo', distance: 0 };
type Draft = { uri: string; width: number; height: number; createdAt: number; tag: PhotoTag; simulated: boolean; imported: boolean; originalMime: string; lookup?: Lookup };
type Screen = 'camera' | 'review' | 'logbook' | 'entry';

function Button({ label, onPress, primary, disabled, selected }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean; selected?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled, selected }} disabled={disabled}
    onPress={onPress} style={({ pressed }) => [styles.button, primary && styles.primary, selected && styles.selected, (disabled || pressed) && styles.dim]}>
    <Text style={styles.buttonText}>{label}</Text>
  </Pressable>;
}

function Panel({ title, children }: { title?: string; children: ReactNode }) {
  return <View style={styles.panel}>{title && <Text style={styles.label}>{title}</Text>}{children}</View>;
}

function coordinates(fix: Fix | null) {
  return fix ? `${fix.latitude.toFixed(5)}°, ${fix.longitude.toFixed(5)}°` : 'GPS unavailable';
}
function applyMatch(tag: PhotoTag, match: Match): PhotoTag {
  return { ...tag, route: match.route, mile: match.mile.toFixed(2), county: match.county, estimate: match, source: 'tdot' };
}
function tagSource(tag: PhotoTag) {
  if (tag.source === 'tdot') return 'TDOT GIS estimate';
  if (tag.source === 'manual') return 'Manual entry';
  return 'Location unverified';
}

export default function CameraWorkflow() {
  const camera = useRef<CameraView>(null);
  const stamp = useRef<ComponentRef<typeof View>>(null);
  const working = useRef(false);
  const saving = useRef(false);
  const gpsRequest = useRef(0);
  const [screen, setScreen] = useState<Screen>('camera');
  const [permission, askCamera] = useCameraPermissions();
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  const [simulated, setSimulated] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [gps, setGps] = useState<{ fix: Fix | null; lookup?: Lookup; message: string }>({ fix: null, message: 'Enable GPS to look up log miles' });

  const refreshEntries = useCallback(async () => {
    try { setEntries(await listEntries()); }
    catch { Alert.alert('Logbook unavailable', 'Your photos could not be read. Try opening the logbook again.'); }
  }, []);
  useEffect(() => { void refreshEntries(); }, [refreshEntries]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      setActive(state === 'active');
      if (state !== 'active') setReady(false);
    });
    return () => subscription.remove();
  }, []);

  const go = useCallback((destination: Screen) => {
    setReady(false);
    setScreen(destination);
  }, []);
  const back = useCallback(() => {
    if (working.current || saving.current) return true;
    if (screen === 'review') {
      setDraft(null);
      go('camera');
    } else if (screen === 'entry') go('logbook');
    else if (screen === 'logbook') go('camera');
    else return false;
    return true;
  }, [go, screen]);
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', back);
    return () => listener.remove();
  }, [back]);

  const locate = useCallback(async (requestPermission = false) => {
    const request = ++gpsRequest.current;
    const update = (next: typeof gps) => { if (request === gpsRequest.current) setGps(next); };
    try {
      const permission = requestPermission ? await Location.requestForegroundPermissionsAsync() : await Location.getForegroundPermissionsAsync();
      if (!permission.granted) {
        update({ fix: null, message: 'Enable GPS to look up log miles' });
        return;
      }
      if (request === gpsRequest.current) setGps(previous => ({ ...previous, message: 'Acquiring GPS…' }));
      const result = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const fix = { ...result.coords, timestamp: result.timestamp };
      update({ fix, message: 'Looking up TDOT route…' });
      const lookup = await lookupRoad(fix);
      update({ fix, lookup, message: lookup.kind === 'matched' ? 'Review TDOT estimate before saving' : lookup.message });
    } catch {
      update({ fix: null, message: 'GPS unavailable. You can enter a location manually.' });
    }
  }, []);
  useEffect(() => {
    if (screen !== 'camera' || !active || simulated) return;
    void locate();
    const timer = setInterval(() => { void locate(); }, 20_000);
    return () => { clearInterval(timer); gpsRequest.current++; };
  }, [screen, active, simulated, locate]);

  async function openDraft(imported: boolean) {
    if (working.current || (!imported && !ready)) return;
    working.current = true;
    setBusy(true);
    try {
      const createdAt = Date.now();
      const photo = imported
        ? (await Picker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 })).assets?.[0]
        : await camera.current?.takePictureAsync({ quality: 0.9 });
      if (!photo) return;
      const isDemo = !imported && simulated;
      let tag = blankTag();
      let lookup: Lookup | undefined;
      if (isDemo) {
        tag = { ...applyMatch(tag, demoMatch), fix: demoFix };
      } else if (!imported && gps.fix && Math.abs(createdAt - gps.fix.timestamp) <= 15_000) {
        tag.fix = gps.fix;
        lookup = gps.lookup;
        if (lookup?.kind === 'matched') tag = applyMatch(tag, lookup.match);
      }
      setImageReady(false);
      const originalMime = imported
        ? ('mimeType' in photo ? photo.mimeType : null) || 'application/octet-stream'
        : 'image/jpeg';
      setDraft({ uri: photo.uri, originalMime, width: photo.width, height: photo.height, createdAt, tag, imported, simulated: isDemo, lookup });
      go('review');
    } catch {
      Alert.alert(imported ? 'Import failed' : 'Capture failed', 'Please try again.');
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  function edit(values: Partial<PhotoTag>, manual = false) {
    setDraft(previous => previous && ({ ...previous, tag: { ...previous.tag, ...values, ...(manual ? { source: 'manual' } : {}) } }));
  }

  async function submit(share: boolean) {
    if (!draft || !stamp.current || !imageReady || draft.simulated || saving.current) return;
    const mile = draft.tag.mile.trim();
    if (mile && (!/^\d+(\.\d{1,2})?$/.test(mile) || Number(mile) > 999.99 || !draft.tag.route.trim() || !draft.tag.county.trim())) {
      Alert.alert('Check the location', 'Enter a route, county, and a log mile from 0 to 999.99. You may also leave the log mile blank.');
      return;
    }
    saving.current = true;
    setBusy(true);
    try {
      const stamped = await captureRef(stamp, { format: 'jpg', quality: 0.94, result: 'tmpfile' });
      const record: Entry = { ...draft.tag, mile, id: randomUUID(), originalMime: draft.originalMime, createdAt: draft.createdAt };
      saveEntry(record, draft.uri, stamped);
      setDraft(null);
      setEntry(record);
      go('entry');
      void refreshEntries();
      if (share) {
        try { await shareEntry(record); }
        catch { Alert.alert('Saved to Logbook', 'Sharing failed. You can retry from the saved photo.'); }
      }
    } catch {
      Alert.alert('Photo could not be saved', 'Your review is still open. Please try saving again.');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  async function shareEntry(record: Entry, original = false) {
    if (!await Sharing.isAvailableAsync()) {
      Alert.alert('Sharing unavailable', 'This device does not offer a share sheet.');
      return;
    }
    const mimeType = original ? record.originalMime ?? 'image/jpeg' : 'image/jpeg';
    await Sharing.shareAsync(photoFile(record.id, original ? mimeType : undefined).uri, { mimeType, dialogTitle: 'Share inspection photo' });
  }

  if (screen === 'camera') {
    const match = simulated ? demoMatch : gps.lookup?.kind === 'matched' ? gps.lookup.match : undefined;
    return <View style={styles.full}>
      {permission?.granted && active && <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back"
        onCameraReady={() => setReady(true)} onMountError={() => { setReady(false); Alert.alert('Camera unavailable', 'You can import a photo instead.'); }} />}
      <SafeAreaView style={styles.cameraOverlay} pointerEvents="box-none">
        <View style={styles.roadCard}>
          <View style={styles.shield}><Text style={styles.shieldText}>{match?.route.startsWith('I-') ? 'I' : 'SR'}</Text></View>
          <View style={styles.flex}>
            <Text style={styles.accent}>{simulated ? 'SIMULATED · TRAINING ONLY' : 'COUNTY LOG MILE'}</Text>
            <Text style={styles.title}>{match ? match.mile.toFixed(2) : 'Awaiting location'}</Text>
            {match && <Text style={styles.body}>{match.route} · {match.county}</Text>}
            <Text style={styles.secondary}>{simulated ? 'Sample location. Saving is disabled.' : gps.message}</Text>
          </View>
        </View>
        <View style={styles.wrap}>
          <Button label={simulated ? 'Return to live GPS' : gps.fix ? coordinates(gps.fix) : 'Enable / refresh GPS'} onPress={() => simulated ? setSimulated(false) : void locate(true)} />
          {!simulated && <Button label="Simulate GPS" onPress={() => setSimulated(true)} />}
        </View>
        {!permission?.granted && <View style={styles.middle}>
          <Text style={styles.title}>LogMile Camera</Text>
          <Text style={styles.secondary}>Capture or import a roadway inspection photo.</Text>
          <Button label="Enable camera" primary onPress={() => void askCamera().then(result => {
            if (!result.granted && !result.canAskAgain) Alert.alert('Camera access is off', 'Enable camera access in Android Settings, or import a photo.');
          })} />
        </View>}
        <View style={styles.controls}>
          <Button label={`Logbook${entries.length ? ` · ${entries.length}` : ''}`} disabled={busy} onPress={() => { void refreshEntries(); go('logbook'); }} />
          <Pressable accessibilityRole="button" accessibilityLabel="Take photo" disabled={!ready || busy} onPress={() => void openDraft(false)}
            style={[styles.shutter, (!ready || busy) && styles.dim]}><View style={styles.shutterCenter}>{busy ? <ActivityIndicator color={colors.bg} /> : <View style={styles.shutterMark} />}</View></Pressable>
          <Button label="Import" disabled={busy} onPress={() => void openDraft(true)} />
        </View>
      </SafeAreaView>
    </View>;
  }

  if (screen === 'review' && draft) {
    const { tag } = draft;
    const nudge = (delta: number) => edit({ mile: Math.max(0, Math.min(999.99, (Number(tag.mile) || 0) + delta)).toFixed(2) }, true);
    const saveDisabled = draft.simulated || busy || !imageReady;
    return <SafeAreaView style={styles.full}>
      <View style={styles.header}>
        <Button label="Back" onPress={back} disabled={busy} />
        <Text style={styles.heading} accessibilityRole="header">Review &amp; Tag Photo</Text>
        <Button label="Save" primary disabled={saveDisabled} onPress={() => void submit(false)} />
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" removeClippedSubviews={false}>
        <View style={styles.preview} ref={stamp} collapsable={false}>
          <Image source={{ uri: draft.uri }} resizeMode="contain" style={{ width: '100%', aspectRatio: Math.max(0.5, Math.min(2.25, draft.width / draft.height || 1)) }}
            onLoad={() => setImageReady(true)} onError={() => Alert.alert('Photo unavailable', 'Go back and capture or import the photo again.')} />
          <View style={styles.stamp}>
            <Text style={styles.accent}>{draft.simulated ? 'SIMULATED · TRAINING ONLY' : tagSource(tag).toUpperCase()}</Text>
            <Text style={styles.heading}>{tag.mile.trim() ? `COUNTY LOG MILE ${tag.mile.trim()}` : 'COUNTY LOG MILE UNVERIFIED'}</Text>
            <Text style={styles.body}>{[tag.route.trim(), tag.direction, tag.county.trim()].filter(Boolean).join(' · ') || 'Route and county unverified'}</Text>
            <Text style={styles.secondary}>{coordinates(tag.fix)} · {new Date(draft.createdAt).toLocaleString()}</Text>
          </View>
        </View>
        {draft.imported && <Text style={styles.secondary}>Imported photo. Enter its original location manually.</Text>}
        {draft.lookup?.kind === 'review' && <Panel title="Verify location">
          <Text style={styles.body}>{draft.lookup.message}</Text>
          {draft.lookup.candidates?.map(candidate => <Button key={candidate.routeId}
            label={`${candidate.route} · ${candidate.county} · ${candidate.mile.toFixed(2)}`}
            onPress={() => edit(applyMatch(tag, candidate))} />)}
        </Panel>}
        <Panel title="Adjust county log mile">
          <View style={styles.mileRow}>
            <Button label="−1" onPress={() => nudge(-1)} />
            <Button label="−0.1" onPress={() => nudge(-0.1)} />
            <TextInput accessibilityLabel="County log mile" value={tag.mile} onChangeText={mile => edit({ mile }, true)} keyboardType="decimal-pad"
              placeholder="—" placeholderTextColor={colors.muted} maxLength={6} style={[styles.input, styles.mile]} />
            <Button label="+0.1" onPress={() => nudge(0.1)} />
            <Button label="+1" onPress={() => nudge(1)} />
          </View>
        </Panel>
        <Panel title="Highway & direction">
          <Text style={styles.secondary}>Route / Highway Name</Text>
          <TextInput accessibilityLabel="Route" style={styles.input} value={tag.route} onChangeText={route => edit({ route }, true)} maxLength={60} />
          <View style={styles.wrap}>
            {['NB', 'SB', 'EB', 'WB'].map(direction => <Button key={direction} label={direction} selected={tag.direction === direction}
              onPress={() => edit({ direction: tag.direction === direction ? '' : direction })} />)}
          </View>
          <Text style={styles.secondary}>County</Text>
          <TextInput accessibilityLabel="County" style={styles.input} value={tag.county} onChangeText={county => edit({ county }, true)} maxLength={60} />
        </Panel>
        <Panel title="Field notes / defect tag">
          <TextInput accessibilityLabel="Field notes" style={[styles.input, styles.notes]} value={tag.notes} onChangeText={notes => edit({ notes })}
            placeholder="e.g. Damaged guardrail, shoulder erosion…" placeholderTextColor={colors.muted} multiline maxLength={2500} />
        </Panel>
        <Panel title="Location details">
          <Text style={styles.body}>Source · {draft.simulated ? 'Training sample' : tagSource(tag)}</Text>
          <Text style={styles.secondary}>{coordinates(tag.fix)}{tag.fix?.accuracy != null ? ` · ±${Math.round(tag.fix.accuracy)} m` : ''}</Text>
          <Text style={styles.secondary}>Heading {tag.fix?.heading != null && tag.fix.heading >= 0 ? `${Math.round(tag.fix.heading)}°` : '—'} · Speed {tag.fix?.speed != null && tag.fix.speed >= 0 ? `${Math.round(tag.fix.speed * 2.23694)} mph` : '—'}</Text>
        </Panel>
        <View style={styles.wrap}>
          <Button label="Save & Share" disabled={saveDisabled} onPress={() => void submit(true)} />
          <Button label="Save Photo" primary disabled={saveDisabled} onPress={() => void submit(false)} />
        </View>
      </ScrollView>
    </SafeAreaView>;
  }

  if (screen === 'entry' && entry) return <SafeAreaView style={styles.full}>
    <View style={styles.header}><Button label="Logbook" onPress={() => go('logbook')} /><Text style={styles.heading}>Saved photo</Text><Button label="Camera" onPress={() => go('camera')} /></View>
    <ScrollView contentContainerStyle={styles.content}>
      <Image source={{ uri: photoFile(entry.id).uri }} resizeMode="contain" style={styles.savedImage} />
      <Panel title={[entry.route, entry.direction, entry.county].filter(Boolean).join(' · ') || 'Inspection photo'}>
        <Text style={styles.body}>{entry.mile ? `County log mile ${entry.mile}` : 'County log mile unverified'}</Text>
        <Text style={styles.secondary}>{tagSource(entry)} · {coordinates(entry.fix)}</Text>
        {!!entry.notes && <Text style={styles.body}>{entry.notes}</Text>}
      </Panel>
      <View style={styles.wrap}>
        <Button label="Share stamped photo" primary onPress={() => void shareEntry(entry).catch(() => Alert.alert('Sharing failed'))} />
        <Button label="Share original" onPress={() => void shareEntry(entry, true).catch(() => Alert.alert('Sharing failed'))} />
      </View>
    </ScrollView>
  </SafeAreaView>;

  return <SafeAreaView style={styles.full}>
    <View style={styles.header}><Button label="Camera" onPress={() => go('camera')} /><Text accessibilityRole="header" style={styles.heading}>Logbook</Text><View style={styles.balance} /></View>
    <FlatList data={entries} keyExtractor={item => item.id} contentContainerStyle={styles.content}
      ListEmptyComponent={<Panel><Text style={styles.body}>No inspection photos saved yet.</Text></Panel>}
      renderItem={({ item }) => <Pressable accessibilityRole="button" style={styles.entryRow} onPress={() => { setEntry(item); go('entry'); }}>
        <Image style={styles.thumbnail} source={{ uri: photoFile(item.id).uri }} />
        <View style={styles.flex}>
          <Text style={styles.heading}>{item.route || 'Inspection photo'}{item.mile ? ` · LM ${item.mile}` : ''}</Text>
          <Text style={styles.secondary}>{item.county || 'Location unverified'} · {new Date(item.createdAt).toLocaleDateString()}</Text>
          {!!item.notes && <Text style={styles.body} numberOfLines={1}>{item.notes}</Text>}
        </View>
      </Pressable>} />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  full: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  cameraOverlay: { flex: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12, gap: 12 },
  roadCard: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, backgroundColor: '#142134ed', borderWidth: 1, borderColor: colors.line, borderRadius: 20 },
  shield: { backgroundColor: colors.green, borderWidth: 2, borderColor: colors.text, borderRadius: 9, paddingVertical: 13, paddingHorizontal: 15 },
  shieldText: { color: colors.text, fontSize: 24, fontWeight: '900' },
  title: { color: colors.text, fontSize: 26, fontWeight: '800' },
  heading: { color: colors.text, fontSize: 17, fontWeight: '800', flexShrink: 1 },
  body: { color: colors.text, fontSize: 15, lineHeight: 21 },
  secondary: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  accent: { color: colors.blue, fontSize: 12, fontWeight: '800', letterSpacing: 0.7 },
  button: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 11, paddingHorizontal: 10, paddingVertical: 10, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  primary: { backgroundColor: colors.button, borderColor: colors.button },
  selected: { backgroundColor: '#174864', borderColor: colors.blue },
  buttonText: { color: colors.text, fontSize: 13, fontWeight: '700', textAlign: 'center' },
  dim: { opacity: 0.5 },
  controls: { marginTop: 'auto', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  shutter: { width: 76, height: 76, borderWidth: 3, borderRadius: 38, borderColor: colors.text, padding: 5 },
  shutterCenter: { flex: 1, borderRadius: 32, backgroundColor: colors.blue, justifyContent: 'center', alignItems: 'center' },
  shutterMark: { width: 22, height: 22, borderRadius: 11, borderWidth: 3, borderColor: colors.bg },
  middle: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8, gap: 8, borderBottomWidth: 1, borderBottomColor: colors.line },
  balance: { width: 65 },
  content: { padding: 15, gap: 14 },
  panel: { padding: 13, gap: 9, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 15 },
  label: { color: colors.muted, fontWeight: '800', textTransform: 'uppercase', fontSize: 13, letterSpacing: 0.5 },
  preview: { borderRadius: 15, overflow: 'hidden', backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line },
  stamp: { borderTopWidth: 3, borderTopColor: colors.blue, padding: 11, gap: 4, backgroundColor: colors.card },
  mileRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  input: { backgroundColor: colors.bg, color: colors.text, borderWidth: 1, borderColor: colors.line, borderRadius: 9, minHeight: 45, paddingHorizontal: 9, paddingVertical: 7, fontSize: 16 },
  mile: { flex: 1, minWidth: 50, color: colors.blue, textAlign: 'center', fontWeight: '800' },
  notes: { minHeight: 94, textAlignVertical: 'top' },
  entryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, backgroundColor: colors.card, borderRadius: 13 },
  thumbnail: { width: 76, height: 62, borderRadius: 8, backgroundColor: colors.bg },
  savedImage: { width: '100%', height: 380, backgroundColor: colors.card, borderRadius: 14 },
});
