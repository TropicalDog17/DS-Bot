import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanPreview, handoffTitleOf, relayReplyText, roundEventText, settledQuestionPicks, stripLongNote } from '../screens/chat/settled.ts'
import { weekdayShort } from '../ui/i18n.ts'
import { workPhrase } from '../ui/phrases.ts'

test('settledQuestionPicks preserves option letters and custom slot from host answer item', () => {
  // Exact shape emitted by ds-bot/src/host/parts.js displayItems for kind: 'answer' (ask_user)
  const answerItem = {
    kind: 'answer' as const,
    at: 1794466440000,
    questions: [{
      id: 'q1',
      question: '从哪里开始?',
      options: [
        { label: '读 AGENTS.md, 公开仓 AGENTS.md, CONTRIBUTING.md' },
        { label: '先看线上 CI 状态' },
        { label: '直接检查发版脚本' },
      ],
      multiSelect: false,
    }],
    answers: [{ id: 'q1', selected: ['先看线上 CI 状态'], custom: '顺便看 release.yml' }],
  }
  const picks = settledQuestionPicks(answerItem.questions[0], answerItem.answers[0])
  assert.deepEqual(picks, [
    { label: '先看线上 CI 状态', letter: 'B' },
    { label: '顺便看 release.yml', letter: 'D' },
  ])
})

test('handoffTitleOf decodes host browser_handoff answer reasons', () => {
  // Exact shape emitted by ds-bot/src/host/parts.js readReply for answer_to_pending_handoff
  const handoff = { callId: 'call_1', reason: 'verification', note: '', outcome: 'done' as const }
  assert.equal(handoffTitleOf(handoff.reason), 'Verification needed')
  assert.equal(handoffTitleOf('confirmation'), 'Confirmation needed')
  assert.equal(handoffTitleOf('other'), 'Your turn in the browser')
})

test('workPhrase and weekdayShort name tool activity and schedule weekdays', () => {
  assert.equal(workPhrase({ tool: 'run_shell_command', target: 'npm test' }), 'Running shell commands · npm test')
  assert.equal(weekdayShort(1), 'Mon')
  assert.equal(weekdayShort(7), 'Sun')
})

test('stripLongNote preserves leading indentation and relayReplyText decodes archived host relay items', () => {
  const raw = '[A long message: 24810 characters. The full text is attached in message.txt.]\n第一段正文'
  assert.equal(stripLongNote(raw), '第一段正文')
  const indented = '[A long message: 24810 characters. The full text is attached in message.txt.]\n    const x = 1'
  assert.equal(stripLongNote(indented), '    const x = 1')

  assert.equal(roundEventText('Beacon', 'done'), 'Beacon finished its work')
  assert.equal(roundEventText('Beacon', 'stopped'), "You stopped Beacon's work")
  // Archived group-chat parts in ds-bot/src/host/parts.js emit { kind: 'relay', reply: { kind, ... } }
  assert.equal(relayReplyText({ kind: 'failed', name: 'Beacon', text: 'quota used up' }), 'Beacon could not answer: quota used up')
  assert.equal(relayReplyText({ kind: 'admin-passed', name: 'Beacon' }), 'Beacon did not answer or call anyone; call a member with @Name')
  assert.equal(relayReplyText({ kind: 'paused', idle: true, name: 'Beacon', names: ['Coder'], count: 6 }), 'Beacon and Coder went back and forth 6 times without progress and paused. Write here to go on')
  assert.equal(cleanPreview('[Browser handoff] verification — finish GitHub two-step check\nAnswer: done'), 'Verification needed · finish GitHub two-step check')
  assert.equal(cleanPreview('[Answer to question card] Where to start?\nAnswer: read AGENTS.md'), 'read AGENTS.md')
})
