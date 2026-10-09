import test from 'node:test';
import assert from 'node:assert/strict';
import {createTriage, TRIAGE_STORAGE_KEY} from '../../public/triage.js';
import {createState, transition, queryParams} from '../../public/state.js';

const incident = id => ({id, title: `<img src=x> incident ${id}`, description: 'plain text', service: 'Billing', severity: 'high', status: 'open', openedAt: '2026-04-01T00:00:00.000Z', resolvedAt: null, team: 'Team 1', region: 'AMER', tags: ['support']});
function memoryStorage(initial = null) {
  const values = new Map(initial === null ? [] : [[TRIAGE_STORAGE_KEY, initial]]);
  return {values, getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, value)};
}

test('triage keeps ordered unique snapshots and plain-text notes in its own validated versioned key', () => {
  const storage = memoryStorage(), triage = createTriage(storage);
  assert.equal(triage.add(incident('INC-000001')), true);
  assert.equal(triage.add(incident('INC-000002')), true);
  assert.equal(triage.add(incident('INC-000001')), false);
  const note = '<script>alert("triage")</script> — follow-up';
  assert.equal(triage.setNote('INC-000002', note), true);
  assert.deepEqual(triage.entries.map(entry => entry.incident.id), ['INC-000001', 'INC-000002']);
  assert.equal(triage.entries[1].note, note);
  const saved = JSON.parse(storage.getItem(TRIAGE_STORAGE_KEY));
  assert.equal(saved.version, 1); assert.deepEqual(saved.entries[1].incident, incident('INC-000002')); assert.equal(saved.entries[1].note, note);
  const reloaded = createTriage(storage);
  assert.deepEqual(reloaded.entries, triage.entries); assert.equal(reloaded.warning, '');
  assert.equal(reloaded.remove('INC-000001'), true);
  assert.deepEqual(reloaded.entries.map(entry => entry.incident.id), ['INC-000002']);
  assert.equal(reloaded.setNote('INC-000001', 'must not return'), false);
  assert.deepEqual(JSON.parse(storage.getItem(TRIAGE_STORAGE_KEY)).entries.map(entry => entry.incident.id), ['INC-000002']);
});

test('malformed data and unavailable storage retain a usable visit state and explain the limitation', () => {
  const malformed = createTriage(memoryStorage('{not json'));
  assert.match(malformed.warning, /could not be read/);
  assert.equal(malformed.add(incident('INC-000003')), true);
  assert.equal(malformed.entries[0].incident.id, 'INC-000003');
  assert.equal(malformed.setNote('INC-000003', 'usable after malformed data'), true);
  assert.equal(malformed.remove('INC-000003'), true);

  const unreadable = createTriage({getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }});
  assert.match(unreadable.warning, /could not be read/);
  assert.equal(unreadable.add(incident('INC-000004')), true);
  assert.equal(unreadable.entries[0].incident.id, 'INC-000004');
  assert.equal(unreadable.setNote('INC-000004', 'still editable'), true);
  assert.equal(unreadable.remove('INC-000004'), true);
  assert.match(unreadable.warning, /remain available for this visit/);

  const unwritable = createTriage({getItem() { return null; }, setItem() { throw new Error('quota'); }});
  assert.equal(unwritable.add(incident('INC-000005')), true);
  assert.equal(unwritable.setNote('INC-000005', 'saved in memory'), true);
  assert.match(unwritable.warning, /remain available for this visit/);
  assert.equal(unwritable.entries[0].note, 'saved in memory');

  const noStorage = createTriage(null);
  assert.match(noStorage.warning, /only for this visit/);
  assert.equal(noStorage.add(incident('INC-000006')), true);
  assert.equal(noStorage.entries[0].incident.id, 'INC-000006');
  assert.equal(noStorage.setNote('INC-000006', 'memory note'), true);
});

test('invalid envelope versions, duplicate IDs, and non-text notes are rejected without losing the current visit', () => {
  for (const envelope of [
    {version: 2, entries: []},
    {version: 1, entries: [{incident: incident('INC-000007'), note: 7}]},
    {version: 1, entries: [{incident: incident('INC-000007'), note: ''}, {incident: incident('INC-000007'), note: 'duplicate'}]}
  ]) {
    const triage = createTriage(memoryStorage(JSON.stringify(envelope)));
    assert.match(triage.warning, /could not be read/); assert.equal(triage.entries.length, 0);
    assert.equal(triage.add(incident('INC-000008')), true);
    assert.equal(triage.entries.length, 1);
  }
});

test('triage add, note, and removal leave the current search and shareable query untouched', () => {
  const storage = memoryStorage(), triage = createTriage(storage);
  let state = transition(createState(), {type: 'intent', patch: {q: 'Billing follow-up', service: ['Billing'], pageSize: 50}});
  state = transition(state, {type: 'result:start'});
  state = transition(state, {type: 'result:success', token: state.resultOp.token, data: {page: 1, totalPages: 1, total: 1}});
  const intent = state.intent, query = queryParams(state.intent).toString();
  const assertSelectionUnchanged = () => {
    assert.equal(state.intent, intent);
    assert.equal(queryParams(state.intent).toString(), query);
  };
  assert.equal(triage.add(incident('INC-000008')), true);
  assertSelectionUnchanged();
  assert.equal(triage.setNote('INC-000008', 'revisit'), true);
  assertSelectionUnchanged();
  state = transition(state, {type: 'detail:select', id: 'INC-000008'});
  state = transition(state, {type: 'detail:start'});
  const oldDetailToken = state.detail.token;
  assert.equal(queryParams(state.intent).toString(), query);
  state = transition(state, {type: 'detail:close'});
  assert.equal(transition(state, {type: 'detail:success', token: oldDetailToken, data: incident('INC-000008')}), state);
  state = transition(state, {type: 'detail:select', id: 'INC-000008'});
  state = transition(state, {type: 'detail:start'});
  assert.equal(state.detail.id, 'INC-000008');
  assert.equal(transition(state, {type: 'detail:success', token: oldDetailToken, data: incident('INC-000008')}), state);
  state = transition(state, {type: 'detail:success', token: state.detail.token, data: incident('INC-000008')});
  assert.deepEqual(state.detail.data, incident('INC-000008'));
  assertSelectionUnchanged();
  assert.equal(triage.remove('INC-000008'), true);
  assertSelectionUnchanged();
  assert.equal(triage.entries.length, 0);
  assert.deepEqual(JSON.parse(storage.getItem(TRIAGE_STORAGE_KEY)).entries, []);
  assert.equal(state.intent, intent); assert.equal(queryParams(state.intent).toString(), query);
  assert.equal(state.result.data.total, 1);
});
