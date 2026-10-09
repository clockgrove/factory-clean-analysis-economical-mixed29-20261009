export const TRIAGE_STORAGE_KEY = 'incident-explorer.triage.v1';
const fields = ['id', 'title', 'description', 'service', 'severity', 'status', 'openedAt', 'resolvedAt', 'team', 'region', 'tags'];
const text = value => typeof value === 'string';
const services = ['Accounts', 'Billing', 'Search', 'Uploads', 'Notifications', 'Integrations'];
const severities = ['critical', 'high', 'medium', 'low'];
const statuses = ['open', 'in_progress', 'resolved'];
const timestamp = value => text(value) && Number.isFinite(Date.parse(value));

function validIncident(value) {
  return value && typeof value === 'object' && fields.every(key => key === 'tags' ? Array.isArray(value.tags) && value.tags.every(text) : key === 'resolvedAt' ? value.resolvedAt === null || timestamp(value.resolvedAt) : text(value[key])) && /^INC-[0-9]{6}$/.test(value.id) && !!value.title && services.includes(value.service) && severities.includes(value.severity) && statuses.includes(value.status) && timestamp(value.openedAt);
}

function parseEnvelope(raw) {
  const envelope = JSON.parse(raw);
  if (!envelope || envelope.version !== 1 || !Array.isArray(envelope.entries)) throw new Error('Invalid triage envelope');
  const seen = new Set(), entries = [];
  for (const entry of envelope.entries) {
    if (!entry || !validIncident(entry.incident) || !text(entry.note) || entry.note.length > 2000 || seen.has(entry.incident.id)) throw new Error('Invalid triage entry');
    seen.add(entry.incident.id);
    entries.push({incident: {...entry.incident, tags: [...entry.incident.tags]}, note: entry.note});
  }
  return entries;
}

function browserStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

export function createTriage(storage = undefined) {
  const store = storage === undefined ? browserStorage() : storage;
  let entries = [], warning = '';
  if (!store) warning = 'Browser storage is unavailable. Triage will last only for this visit.';
  else {
    try {
      const raw = store.getItem(TRIAGE_STORAGE_KEY);
      if (raw !== null) entries = parseEnvelope(raw);
    } catch { warning = 'Saved triage could not be read because browser storage is unavailable or malformed. This visit remains usable.'; }
  }
  const persist = () => {
    if (!store) return;
    try {
      store.setItem(TRIAGE_STORAGE_KEY, JSON.stringify({version: 1, entries}));
      warning = '';
    } catch { warning = 'Browser storage is unavailable. Your triage changes remain available for this visit only.'; }
  };
  return {
    get entries() { return entries; },
    get warning() { return warning; },
    add(incident) {
      if (!validIncident(incident) || entries.some(entry => entry.incident.id === incident.id)) return false;
      entries = [...entries, {incident: {...incident, tags: [...incident.tags]}, note: ''}]; persist(); return true;
    },
    setNote(id, note) {
      if (!text(note) || note.length > 2000 || !entries.some(entry => entry.incident.id === id)) return false;
      entries = entries.map(entry => entry.incident.id === id ? {...entry, note} : entry); persist(); return true;
    },
    remove(id) {
      if (!entries.some(entry => entry.incident.id === id)) return false;
      entries = entries.filter(entry => entry.incident.id !== id); persist(); return true;
    }
  };
}
