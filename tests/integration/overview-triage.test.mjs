import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {createAppServer} from '../../server/app.mjs';
import {createTriage, TRIAGE_STORAGE_KEY} from '../../public/triage.js';
import {createState, transition, overviewSignature, announcement, queryParams} from '../../public/state.js';

const rows = JSON.parse(await readFile(new URL('../../.runtime/incidents.json', import.meta.url), 'utf8'));
// Independent of both the server reducer and existing regression oracle.
function matches(options = {}) {
  return rows.filter(row => {
    if (options.q && !['id', 'title', 'description'].some(key => row[key].toUpperCase().includes(options.q.toUpperCase()))) return false;
    for (const key of ['service', 'status', 'severity']) if (options[key]?.length && !options[key].includes(row[key])) return false;
    const day = Date.parse(row.openedAt.substring(0, 10));
    return (!options.from || day >= Date.parse(options.from)) && (!options.to || day <= Date.parse(options.to));
  });
}
function measures(options = {}) {
  const found = matches(options);
  return [...new Set(found.map(row => row.service))].map(service => {
    const group = found.filter(row => row.service === service);
    const resolved = group.filter(row => row.status === 'resolved');
    return {service, incidentCount: group.length,
      unresolvedCount: group.filter(row => ['open', 'in_progress'].includes(row.status)).length,
      highSeverityCount: group.filter(row => ['critical', 'high'].includes(row.severity)).length,
      averageResolutionHours: resolved.length ? resolved.reduce((sum, row) => sum + (Date.parse(row.resolvedAt) - Date.parse(row.openedAt)) / 3600000, 0) / resolved.length : null};
  }).sort((a, b) => b.unresolvedCount - a.unresolvedCount || a.service.localeCompare(b.service));
}
function params(options) {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) for (const item of Array.isArray(value) ? value : [value]) result.append(key, item);
  return result;
}
async function close(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
}
const filters = {q: 'incident', service: ['Billing', 'Notifications'], severity: ['critical', 'high', 'medium'], status: ['open', 'in_progress', 'resolved'], from: '2026-04-15', to: '2026-06-13'};

test('combined HTTP: canonical service measures, UTC/facets/literal search, ties and pagination independence', {timeout: 20000}, async () => {
  const server = await createAppServer();
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const check = async options => {
      const response = await fetch(`${base}/api/overview?${params(options)}`, {signal: AbortSignal.timeout(5000)});
      assert.equal(response.status, 200);
      const body = await response.json(); assert.deepEqual(body, {services: measures(options)}); return body;
    };
    assert.ok(matches(filters).length > 50);
    const whole = await check(filters);
    for (const pageSize of [25, 50]) for (const page of [1, 2, 3]) {
      assert.deepEqual(await check({...filters, pageSize, page, sort: 'severity', direction: 'asc'}), whole);
    }
    const unresolved = await check({status: ['open', 'in_progress']});
    assert.ok(unresolved.services.length); assert.ok(unresolved.services.every(x => x.averageResolutionHours === null));
    const resolved = await check({status: ['resolved']});
    assert.ok(resolved.services.length > 1);
    assert.deepEqual(resolved.services.map(x => x.service), resolved.services.map(x => x.service).sort());
    for (const options of [{}, {q: 'sEcOnD LiNe: <SAMPLE>'}, {q: 'INC-000001'}, {q: '.*'},
      {from: '2026-04-01', to: '2026-04-01'}, {from: '2026-06-29', to: '2026-06-29'},
      {from: '2026-06-29'}, {to: '2026-04-01'}, {service: ['Billing', 'Billing', 'Search']}]) await check(options);
    assert.deepEqual(await check({q: 'no incident matches this phrase'}), {services: []});
  } finally { await close(server); }
});

test('combined production persistence: canonical snapshots survive malformed/read/write failure with literal notes and unique membership', () => {
  const note = '<img src=x onerror="throw 1"> & "retry"\n<script>literal</script>';
  for (const initial of ['{bad JSON', JSON.stringify({version: 9, entries: []}), JSON.stringify({version: 1, entries: [{incident: rows[0], note: ''}, {incident: rows[0], note: 'duplicate'}]})]) {
    const store = {getItem: () => initial, setItem() { throw new Error('quota'); }};
    const triage = createTriage(store);
    assert.match(triage.warning, /could not be read/);
    assert.equal(triage.add(rows[0]), true); assert.equal(triage.add(rows[1]), true);
    assert.equal(triage.setNote(rows[0].id, note), true); assert.equal(triage.add(rows[0]), false);
    assert.deepEqual(triage.entries.map(x => x.incident.id), [rows[0].id, rows[1].id]);
    assert.equal(triage.entries[0].note, note); assert.match(triage.warning, /visit only/);
    triage.remove(rows[0].id); triage.add(rows[0]); assert.equal(triage.entries[1].note, '');
  }
  for (const store of [null, {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }}]) {
    const triage = createTriage(store); assert.ok(triage.warning);
    triage.add(rows[0]); triage.setNote(rows[0].id, note);
    assert.equal(triage.entries[0].note, note); triage.remove(rows[0].id); assert.deepEqual(triage.entries, []);
  }
});

test('combined ownership: superseded overview/list/detail endings cannot change current failure, retry, announcements or triage', () => {
  let state = createState();
  const send = (type, payload = {}) => { state = transition(state, {type, ...payload}); };
  const beginOverview = () => { const signature = overviewSignature(state.intent); send('overview:start', {signature}); return {token: state.overviewOp.token, signature}; };
  const listData = options => ({page: 1, totalPages: 2, total: matches(options).length, items: matches(options).slice(0, 25)});
  send('result:start'); send('result:success', {token: state.resultOp.token, data: listData({})});
  const initialOverview = beginOverview(); send('overview:success', {...initialOverview, data: {services: measures()}});
  const snapshot = state.overview;
  send('detail:select', {id: rows[0].id}); send('detail:start'); const detail = state.detail.token;
  send('result:start'); const result = state.resultOp.token; const old = beginOverview();
  send('intent', {patch: {q: 'Billing', status: ['open']}});
  assert.equal(state.detail.id, null);
  send('result:start'); const failedResult = state.resultOp.token; const current = beginOverview();
  send('overview:failure', {...current, error: 'current overview offline'});
  send('result:failure', {token: failedResult, error: 'current list offline'});
  assert.equal(announcement(state), 'current list offline'); assert.equal(state.overview, snapshot);
  const obsolete = () => {
    for (const ending of ['success', 'failure', 'finish']) {
      for (const [operation, payload] of [['overview', old], ['result', {token: result}], ['detail', {token: detail}]]) {
        const before = state; send(`${operation}:${ending}`, {...payload, data: listData({}), error: 'obsolete'}); assert.equal(state, before);
      }
    }
  };
  obsolete();
  send('result:start'); send('result:success', {token: state.resultOp.token, data: listData({q: 'Billing', status: ['open']})});
  assert.equal(announcement(state), 'current overview offline');
  send('detail:select', {id: rows[1].id}); send('detail:start');
  assert.equal(announcement(state), 'Loading incident details.');
  send('detail:failure', {token: state.detail.token, error: 'current detail offline'});
  const closed = state.detail.token; assert.equal(announcement(state), 'current detail offline');
  send('detail:close'); assert.equal(announcement(state), 'current overview offline');
  const retry = beginOverview(); assert.equal(announcement(state), 'Loading service overview.');
  const before = state; send('overview:finish', current); assert.equal(state, before); obsolete();
  for (const ending of ['success', 'failure', 'finish']) { const before = state; send(`detail:${ending}`, {token: closed, data: rows[1], error: 'closed'}); assert.equal(state, before); }
  const triage = createTriage(null), query = queryParams(state.intent).toString();
  triage.add(rows[1]); triage.setNote(rows[1].id, '<b>follow up</b>');
  send('overview:success', {...retry, data: {services: measures({q: 'Billing', status: ['open']})}});
  assert.equal(state.overview.signature, overviewSignature(state.intent)); assert.equal(state.overviewOp.error, null);
  assert.equal(queryParams(state.intent).toString(), query); assert.equal(triage.entries[0].note, '<b>follow up</b>');
  assert.equal(announcement(state), `${matches({q: 'Billing', status: ['open']}).length} matching incidents.`);
});

const alias = dirname(execFileSync('bash', ['-c', 'command -v qualification-chromium'], {encoding: 'utf8'}).trim());
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(alias, '../browsers');
await mkdir('.runtime/browser-tmp', {recursive: true});
for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = '.runtime/browser-tmp';
const {chromium} = await import('playwright');
async function until(read, wanted) {
  const deadline = Date.now() + 10000;
  let actual;
  do {
    actual = await read();
    if (JSON.stringify(actual) === JSON.stringify(wanted)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.deepEqual(actual, wanted);
}

test('combined real Chromium: overview update/failure/retry and persisted keyboard/phone triage journey', {timeout: 90000}, async () => {
  let server, browser, context, port;
  const start = async () => { server = await createAppServer(); server.listen(port || 0, '127.0.0.1'); await once(server, 'listening'); port = server.address().port; };
  try {
    await start();
    browser = await chromium.launch({channel: 'chromium', headless: true, chromiumSandbox: true, env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      LD_LIBRARY_PATH: resolve(alias, '../host-libs/usr/lib/x86_64-linux-gnu'),
      ALSA_CONFIG_PATH: resolve(alias, '../host-libs/usr/share/alsa/alsa.conf'),
      TMPDIR: '.runtime/browser-tmp', TMP: '.runtime/browser-tmp', TEMP: '.runtime/browser-tmp'
    }});
    context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const search = async q => { await page.locator('#search').fill(q); await page.locator('#search').press('Enter'); };
    const ready = async () => { await until(() => page.locator('#freshness').textContent(), 'Current selections'); await until(() => page.locator('#results').getAttribute('aria-busy'), 'false'); };
    const checkOverview = async options => {
      await until(() => page.locator('#overview-message').textContent(), '');
      const expected = measures(options).map(x => [x.service, String(x.incidentCount), String(x.unresolvedCount), String(x.highSeverityCount), x.averageResolutionHours === null ? 'Unavailable' : x.averageResolutionHours.toLocaleString(undefined, {maximumFractionDigits: 2})]);
      await until(() => page.locator('#overview-rows tr').evaluateAll(nodes => nodes.map(row => [...row.cells].map(cell => cell.textContent))), expected);
      assert.match(await page.locator('#overview-selection').textContent(), /^Representing:/);
    };
    await page.goto(`http://127.0.0.1:${port}/`); await ready(); await checkOverview({});
    await search('Billing'); await ready(); await checkOverview({q: 'Billing'});
    await page.locator('#status').getByLabel('open', {exact: true}).check(); await ready(); await checkOverview({q: 'Billing', status: ['open']});
    assert.ok((await page.locator('#overview-rows').textContent()).includes('Unavailable'));
    await page.getByRole('button', {name: 'Clear search and filters', exact: true}).click(); await ready(); await checkOverview({});
    const whole = await page.locator('#overview-rows').textContent();
    await page.locator('#next').click(); await ready(); assert.equal(await page.locator('#overview-rows').textContent(), whole);
    await page.locator('#page-size').selectOption('50'); await ready(); assert.equal(await page.locator('#overview-rows').textContent(), whole);
    await close(server); await search('Search');
    await until(() => page.locator('#overview-message button').textContent(), 'Retry');
    await until(() => page.locator('#results').getAttribute('aria-busy'), 'false');
    assert.equal(await page.locator('#overview-rows').textContent(), whole);
    assert.match(await page.locator('#overview-selection').textContent(), /^Previous selection:/);
    await start(); await page.locator('#overview-message button').click(); await checkOverview({q: 'Search'});
    await page.locator('#result-message button').click(); await ready();
    const address = page.url(), incidentButton = page.locator('#rows button').first();
    const id = await incidentButton.getAttribute('data-incident'); const row = rows.find(x => x.id === id);
    await incidentButton.focus(); await page.keyboard.press('Enter');
    await until(() => page.locator('#detail-content dd').count(), 11);
    assert.equal(await page.locator('#detail-content dd').nth(2).textContent(), row.description);
    await page.getByRole('button', {name: 'Add to personal triage', exact: true}).click();
    assert.equal(await page.getByRole('button', {name: 'Already in triage', exact: true}).isDisabled(), true);
    await page.keyboard.press('Escape');
    await until(() => incidentButton.evaluate(x => x === document.activeElement), true);
    assert.notEqual(await incidentButton.evaluate(x => getComputedStyle(x).outlineStyle), 'none');
    await page.getByRole('button', {name: `Open details for ${id}`, exact: true}).click();
    await until(() => page.locator('#detail-content dd').count(), 11);
    assert.equal(await page.getByRole('button', {name: 'Already in triage', exact: true}).isDisabled(), true);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('[data-triage-note]').count(), 1);
    const note = '<img src=x onerror="throw 1"> & "retry"\n<script>literal note</script>';
    await page.getByLabel(`Note for ${id}`, {exact: true}).fill('draft');
    await page.getByLabel(`Note for ${id}`, {exact: true}).fill(note);
    assert.equal(page.url(), address);
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), TRIAGE_STORAGE_KEY);
    assert.deepEqual(stored.entries, [{incident: row, note}]);
    await page.reload(); await ready(); await checkOverview({q: 'Search'});
    assert.equal(page.url(), address); assert.equal(await page.getByLabel(`Note for ${id}`, {exact: true}).inputValue(), note);
    assert.equal(await page.locator('#triage-list script, #triage-list img').count(), 0);
    await page.setViewportSize({width: 375, height: 812});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const cells = page.locator('#overview-rows tr').first().locator('td');
    assert.equal(await cells.count(), 5);
    for (let i = 0; i < 5; i++) {
      const cell = cells.nth(i); await cell.scrollIntoViewIfNeeded();
      assert.equal(await cell.evaluate(x => { const r = x.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.width > 0; }), true);
    }
    const open = page.getByRole('button', {name: `Open details for ${id}`, exact: true});
    await open.scrollIntoViewIfNeeded(); await open.focus(); await page.keyboard.press('Enter');
    await until(() => page.locator('#detail-content dd').count(), 11); assert.equal(page.url(), address);
    await page.keyboard.press('Escape');
    const remove = page.getByRole('button', {name: `Remove ${id} from triage`, exact: true});
    await remove.scrollIntoViewIfNeeded();
    assert.equal(await remove.evaluate(x => { const r = x.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }), true);
    await remove.focus(); await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).entries, TRIAGE_STORAGE_KEY), []);
    await page.reload(); await ready(); assert.equal(await page.locator('[data-triage-note]').count(), 0);
    assert.deepEqual(errors, []);
  } finally { try { await context?.close(); } finally { try { await browser?.close(); } finally { await close(server); } } }
});
