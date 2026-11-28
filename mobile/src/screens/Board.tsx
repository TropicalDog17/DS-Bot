import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, AppState, FlatList, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { confirmDanger, Sheet, SheetHeader } from '../nav/sheet.tsx'
import { boardActions, boardColumns, boardErrorText, boardLinks, boardQuestion, boardReadOnlyText, readBoard, writeBoard, type BoardCard, type BoardNote, type BoardState, type BoardWrite } from '../team/board.ts'
import { useTeam } from '../team/context.tsx'
import { clockLabel, t } from '../ui/i18n.ts'
import { radius, type as typeScale, useTheme } from '../ui/tokens.ts'
import { BackRow } from './manage.tsx'

const labels: Record<BoardCard['status'], string> = {
  todo: 'Todo', active: 'In progress', review: 'Review', blocked: 'Blocked', done: 'Done', cancelled: 'Cancelled',
}

function BoardButton({ label, onPress, disabled, tone }: { label: string; onPress: () => void; disabled?: boolean; tone?: 'primary' | 'danger' }) {
  const { p } = useTheme()
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.button, {
        backgroundColor: tone === 'primary' && !disabled ? p.accent : pressed ? p.active : p.card,
        borderColor: p.line2,
      }]}>
      <Text style={[typeScale.small, { color: disabled ? p.ink2 : tone === 'primary' ? p.accentInk : tone === 'danger' ? p.danger : p.ink, fontWeight: '600' }]}>{label}</Text>
    </Pressable>
  )
}

function BoardMessage({ text, error = false }: { text: string; error?: boolean }) {
  const { p } = useTheme()
  return <Text accessibilityRole={error ? 'alert' : undefined} accessibilityLiveRegion="polite"
    style={[typeScale.small, styles.message, { color: error ? p.danger : p.ink2 }]}>{text}</Text>
}

function CardRow({ card, assignee, onOpen }: { card: BoardCard; assignee: string; onOpen: () => void }) {
  const { p } = useTheme()
  const summary = card.status === 'done' ? card.result || card.progress : card.need || card.progress
  return (
    <Pressable accessibilityRole="button" accessibilityHint={card.unread ? t('Unread. Opens card details.') : t('Opens card details.')}
      onPress={onOpen} style={({ pressed }) => [styles.card, { backgroundColor: pressed ? p.hover : p.card, borderColor: p.line2 }]}>
      <View style={styles.cardHeading}>
        <Text style={[typeScale.rowName, { color: p.ink, flex: 1, fontWeight: '600' }]} numberOfLines={3}>{card.title}</Text>
        {card.unread ? <View style={[styles.unread, { backgroundColor: p.accent }]} /> : null}
      </View>
      <Text style={[typeScale.caption, { color: p.ink2 }]} numberOfLines={1}>{card.key ? `${card.key} · ${assignee}` : assignee}</Text>
      {summary ? <Text style={[typeScale.rowPreview, { color: p.ink2 }]} numberOfLines={3}>{summary}</Text> : null}
    </Pressable>
  )
}

function CardText({ label, text }: { label: string; text?: string }) {
  const { p } = useTheme()
  if (!text) return null
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={[typeScale.headerTitle, { color: p.ink }]}>{label}</Text>
      <Text selectable style={[typeScale.bubble, { color: p.ink }]}>{text}</Text>
    </View>
  )
}

function NoteText({ note, author }: { note: BoardNote; author: string }) {
  const { p } = useTheme()
  return (
    <>
      <Text style={[typeScale.caption, { color: p.ink2 }]}>{author} · {clockLabel(note.at)}</Text>
      <Text selectable style={[typeScale.bubble, { color: p.ink }]}>{note.text}</Text>
    </>
  )
}

function CardDetail({ card, nameOf, canWrite, busy, notice, error, onAction }: {
  card: BoardCard
  nameOf: (id: string) => string
  canWrite: boolean
  busy: boolean
  notice: string | null
  error: string | null
  onAction: (action: BoardWrite) => Promise<boolean>
}) {
  const { p } = useTheme()
  const insets = useSafeAreaInsets()
  const [draft, setDraft] = useState('')
  const [linkError, setLinkError] = useState(false)
  const notes = card.notes ?? []
  const question = boardQuestion(notes)
  const history = question === undefined ? notes : notes.filter((_, index) => index !== question.index)
  const open = card.status !== 'done' && card.status !== 'cancelled'
  const editable = canWrite && open
  const links = boardLinks(card)

  const send = async () => {
    if (await onAction(boardActions.note(card.id, draft))) setDraft('')
  }
  const openLink = async (url: string) => {
    setLinkError(false)
    try { await Linking.openURL(url) } catch { setLinkError(true) }
  }
  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {notice ? <BoardMessage text={notice} /> : null}
      {error ? <BoardMessage text={error} error /> : null}
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.detail, { paddingBottom: insets.bottom + 20 }]}>
        <View style={styles.section}>
          <Text accessibilityRole="header" style={[typeScale.largeTitle, { color: p.ink }]}>{card.title}</Text>
          <Text style={[typeScale.rowPreview, { color: p.ink2 }]}>{[card.key, t(labels[card.status]), nameOf(card.assignee)].filter(Boolean).join(' · ')}</Text>
        </View>
        <CardText label={t('Needs you')} text={card.need} />
        {question !== undefined ? (
          <View style={styles.section}>
            <Text accessibilityRole="header" style={[typeScale.headerTitle, { color: p.ink }]}>{t('Question')}</Text>
            <NoteText note={notes[question.index]} author={nameOf(notes[question.index].by ?? 'user')} />
            {question.options.map(option => editable && question.answer === undefined
              ? <BoardButton key={option} label={option} disabled={busy} onPress={() => void onAction(boardActions.answer(card.id, option))} />
              : <Text key={option} style={[typeScale.rowPreview, { color: p.ink2, fontWeight: question.answer === option ? '600' : '400' }]}>
                {question.answer === option ? t('Selected · {option}', { option }) : option}
              </Text>)}
          </View>
        ) : null}
        <CardText label={t('Progress')} text={card.progress} />
        <CardText label={t('Result')} text={card.result} />
        <CardText label={t('Reason')} text={card.reason} />
        {links.length > 0 ? (
          <View style={styles.section}>
            <Text accessibilityRole="header" style={[typeScale.headerTitle, { color: p.ink }]}>{t('Links')}</Text>
            {links.map(link => (
              <Pressable key={link.url} accessibilityRole="link" onPress={() => void openLink(link.url)} style={styles.link}>
                <Text style={[typeScale.rowName, { color: p.accent, textDecorationLine: 'underline' }]}>{link.label}</Text>
              </Pressable>
            ))}
            {linkError ? <Text accessibilityRole="alert" style={[typeScale.small, { color: p.danger }]}>{t('Could not open the link.')}</Text> : null}
          </View>
        ) : null}
        <CardText label={t('Brief')} text={card.brief} />
        {editable ? (
          <View style={styles.actions}>
            {card.status === 'review' ? <BoardButton label={t('Move to Done')} disabled={busy} onPress={() => void onAction(boardActions.move(card.id, 'done'))} /> : null}
            <BoardButton label={t('Cancel card')} tone="danger" disabled={busy}
              onPress={() => confirmDanger(t('Cancel this card?'), t('Cancel card'), () => void onAction(boardActions.cancel(card.id)))} />
          </View>
        ) : null}
        {history.length > 0 ? (
          <View style={styles.section}>
            <Text accessibilityRole="header" style={[typeScale.headerTitle, { color: p.ink }]}>{t('Notes')}</Text>
            {history.map((note, index) => (
              <View key={`${note.at}:${index}`} style={[styles.note, { borderColor: p.line2 }]}>
                <NoteText note={note} author={nameOf(note.by ?? 'user')} />
              </View>
            ))}
          </View>
        ) : null}
        {editable ? (
          <View style={styles.section}>
            <Text accessibilityRole="header" style={[typeScale.headerTitle, { color: p.ink }]}>{t('Add a note')}</Text>
            <TextInput accessibilityLabel={t('Add a note')} value={draft} onChangeText={setDraft} editable={!busy} multiline
              placeholder={t('Write a note')} placeholderTextColor={p.ink2}
              style={[typeScale.bubble, styles.input, { color: p.ink, backgroundColor: p.card, borderColor: p.line2 }]} />
            <View style={styles.actions}>
              <BoardButton label={t('Send note')} tone="primary" disabled={busy || draft.trim() === ''} onPress={() => void send()} />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

export function Board({ navigation }: { navigation: { goBack: () => void } }) {
  const { computer } = useTeam()
  return <BoardPage key={computer?.hostDeviceId} onBack={() => navigation.goBack()} />
}

function BoardPage({ onBack }: { onBack: () => void }) {
  const { call, linked, online, error: linkError } = useTeam()
  const connected = linked ?? online
  const { p } = useTheme()
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const [state, setState] = useState<BoardState | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef<BoardState | null>(null)
  const pending = useRef(false)
  const seen = useRef<string | null>(null)
  const liveConnection = useRef(connected)
  liveConnection.current = connected

  const run = useCallback(async (action?: BoardWrite) => {
    const current = latest.current
    if (!liveConnection.current || pending.current || (action !== undefined && (current === null || current.readOnly))) return false
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      const next = action !== undefined && current !== null ? await writeBoard(call, current, action) : await readBoard(call)
      latest.current = next
      setState(next)
      setStale(false)
      return true
    } catch (failure) {
      setError(boardErrorText(failure))
      latest.current = null
      setStale(true)
      if (action !== undefined && liveConnection.current) {
        const next = await readBoard(call).catch(() => null)
        if (next !== null) {
          latest.current = next
          setState(next)
          setStale(false)
        }
      }
      return false
    } finally {
      pending.current = false
      setBusy(false)
    }
  }, [call])

  useEffect(() => {
    if (connected) void run()
  }, [connected, run])
  useEffect(() => {
    const subscription = AppState.addEventListener('change', status => { if (status === 'active') void run() })
    return () => subscription.remove()
  }, [run])

  const board = useMemo(() => state === null ? null : boardColumns(state), [state])
  const canWrite = connected && !stale && state !== null && !state.readOnly
  const notice = !connected ? (linkError ?? t('Connecting to the computer…')) : state?.readOnly ? boardReadOnlyText() : null
  const selectedCard = selected === null ? undefined : state?.cards[selected]
  useEffect(() => {
    if (!canWrite || busy || selectedCard?.unread !== true || seen.current === selectedCard.id) return
    seen.current = selectedCard.id
    void run(boardActions.seen(selectedCard.id))
  }, [busy, canWrite, run, selectedCard])
  const nameOf = (id: string) => id === 'user' ? t('You') : state?.bots.find(bot => bot.id === id)?.name ?? id
  const openCard = (card: BoardCard) => {
    seen.current = null
    setSelected(card.id)
  }
  const renderCard = ({ item }: { item: BoardCard }) => <CardRow card={item} assignee={nameOf(item.assignee)} onOpen={() => openCard(item)} />
  const done = board?.done.length ?? 0
  const open = board?.columns.reduce((count, column) => count + column.cards.length, 0) ?? 0
  const tabs = [{ done: false, label: t('Open cards') }, { done: true, label: t('Done ({count})', { count: done }) }]
  return (
    <View style={[styles.fill, { backgroundColor: p.main, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <BackRow title={t('Board')} onBack={onBack} />
      <View style={styles.toolbar}>
        <View accessibilityRole="tablist" style={[styles.tabs, { backgroundColor: p.hover }]}>
          {tabs.map(tab => (
            <Pressable key={tab.done ? 'done' : 'open'} accessibilityRole="tab" accessibilityState={{ selected: showDone === tab.done }}
              onPress={() => setShowDone(tab.done)} style={[styles.tab, showDone === tab.done && { backgroundColor: p.card }]}>
              <Text style={[typeScale.small, { color: p.ink, fontWeight: showDone === tab.done ? '600' : '400' }]}>{tab.label}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={t('Refresh board')} disabled={!connected || busy}
          onPress={() => void run()} style={styles.refresh}>
          {busy ? <ActivityIndicator size="small" color={p.accent} /> : <Text style={[typeScale.small, { color: connected ? p.accent : p.ink2 }]}>{t('Refresh')}</Text>}
        </Pressable>
      </View>
      {notice ? <BoardMessage text={notice} /> : null}
      {error ? <BoardMessage text={error} error /> : null}
      {board === null ? (
        connected && !error ? <BoardMessage text={t('Loading board…')} /> : null
      ) : showDone ? (
        <FlatList data={board.done} keyExtractor={card => card.id} renderItem={renderCard} contentContainerStyle={styles.doneList}
          ListEmptyComponent={<BoardMessage text={t('No completed cards.')} />} />
      ) : open === 0 ? <BoardMessage text={t('No open cards.')} /> : (
        <ScrollView horizontal style={styles.fill} contentContainerStyle={styles.columns}>
          {board.columns.map(column => (
            <View key={column.status} style={{ width: Math.min(320, width - insets.left - insets.right - 56) }}>
              <View style={styles.columnHeader}>
                <Text accessibilityRole="header" style={[typeScale.headerTitle, { color: p.ink }]}>{t(labels[column.status])}</Text>
                <Text style={[typeScale.caption, { color: p.ink2 }]}>{column.cards.length}</Text>
              </View>
              <FlatList data={column.cards} keyExtractor={card => card.id} renderItem={renderCard} nestedScrollEnabled style={styles.fill}
                ListEmptyComponent={<Text style={[typeScale.small, { color: p.ink2 }]}>{t('No cards')}</Text>} />
            </View>
          ))}
        </ScrollView>
      )}
      {selected !== null ? (
        <Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal onRequestClose={() => setSelected(null)}>
          <Sheet>
            <SheetHeader title={t('Card details')}
              left={{ label: t('Refresh'), onPress: () => void run(), disabled: !connected || busy }}
              right={{ label: t('Close'), onPress: () => setSelected(null), strong: true }} />
            {selectedCard === undefined ? <BoardMessage text={error ?? t('This card is no longer available.')} error={error !== null} />
              : <CardDetail key={selectedCard.id} card={selectedCard} nameOf={nameOf} canWrite={canWrite} busy={busy} notice={notice} error={error} onAction={run} />}
          </Sheet>
        </Modal>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  tabs: { flexDirection: 'row', flexShrink: 1, borderRadius: radius.card, padding: 2 },
  tab: { minHeight: 44, flexShrink: 1, justifyContent: 'center', borderRadius: radius.row, paddingHorizontal: 12, paddingVertical: 6 },
  refresh: { minHeight: 48, minWidth: 56, alignItems: 'center', justifyContent: 'center' },
  message: { paddingHorizontal: 16, paddingVertical: 10 },
  columns: { paddingHorizontal: 16, paddingBottom: 8, gap: 12 },
  columnHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10 },
  doneList: { padding: 16 },
  card: { borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 5, marginBottom: 8 },
  cardHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  unread: { width: 8, height: 8, borderRadius: 4, marginTop: 7 },
  detail: { padding: 18, gap: 20 },
  section: { gap: 8 },
  note: { borderTopWidth: StyleSheet.hairlineWidth, gap: 5, paddingTop: 8 },
  input: { minHeight: 80, maxHeight: 172, borderWidth: 1, borderRadius: radius.input, padding: 10, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { minHeight: 48, minWidth: 48, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.input },
  link: { minHeight: 48, justifyContent: 'center' },
})
