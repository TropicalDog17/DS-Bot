import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dateLocale, hostText, language, t } from '../src/client/i18n.ts'

test('copy is English: keys fill their slots and host messages show as sent', () => {
  assert.equal(t('Message {name}', { name: 'Chief' }), 'Message Chief')
  assert.equal(t('{count} of {total}', { count: 1 }), '1 of {total}')
  assert.equal(t('Model'), 'Model')
  assert.equal(hostText('A Bot named Writer already exists'), 'A Bot named Writer already exists')
  assert.equal(language(), 'en')
  assert.equal(dateLocale(), 'en-US')
})
