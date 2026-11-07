import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) { return next(/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) ? specifier + '.ts' : specifier, context); } });
const { default: worker } = await import('../src/index.ts');
const { sha256 } = await import('../src/documental.ts');
const A = 'a'.repeat(64), B = 'b'.repeat(64), sourceId = '12345678-1234-4234-8234-123456789abc';
const pdf = new TextEncoder().encode('%PDF-1.4\noriginal bytes\n%%EOF');

class SqlBinding {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec(readFileSync(new URL('../migrations/0001_core.sql', import.meta.url), 'utf8')); }
  prepare(sql) {
    const statement = this.db.prepare(sql);
    const wrap = values => ({ bind: (...next) => wrap(next), first: async field => { const value = statement.get(...values); return field ? value?.[field] ?? null : value ?? null; }, all: async () => ({ success: true, results: statement.all(...values) }), run: async () => { const result = statement.run(...values); return { success: true, meta: { changes: Number(result.changes) } }; } });
    return wrap([]);
  }
}
class BucketBinding {
  objects = new Map();
  async put(key, value, options) { if (options?.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null; const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value.slice() : new Uint8Array(value); this.objects.set(key, { bytes, options }); return { key, size: bytes.length }; }
  async head(key) { const value = this.objects.get(key); return value ? { key, size: value.bytes.length } : null; }
  async get(key) { const value = this.objects.get(key); if (!value) return null; const { bytes } = value; return { key, size: bytes.length, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), json: async () => JSON.parse(new TextDecoder().decode(bytes)), text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer }; }
}
function fixture() { return { DB: new SqlBinding(), DOCUMENTS: new BucketBinding(), INGEST_QUEUE: { messages: [], async send(body) { this.messages.push(structuredClone(body)); } }, GEMINI_MODEL: 'gemini-test-model', MAX_JOBS_PER_ACTOR_DAY: '20' }; }
const input = (extra = {}) => ({ idempotencyKey: crypto.randomUUID(), notebookId: 'my-notebook', title: 'Caderno documental', scope: 'personal', revision: 'diary-rev-1', sheet: { id: 'my-sheet', text: '  Texto original 👁️\nSegunda linha literal.  ', objects: [{ id: 'meal-original', type: 'food', label: 'Arroz', grams: 120, inference: false }] }, sources: [], ...extra });
async function request(env, path, { actor = A, method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { ...(actor ? { 'x-urutau-actor': actor, 'x-urutau-name': 'Pessoa da sessão' } : {}), ...headers } };
  if (body !== undefined) { init.body = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body); if (!(body instanceof Uint8Array)) init.headers['Content-Type'] ??= 'application/json'; }
  return worker.fetch(new Request('https://core.internal' + path, init), env);
}
async function save(env, value = input(), actor = A) { const response = await request(env, '/v1/contributions', { actor, method: 'POST', body: value }); assert.equal(response.status, 201); return response.json(); }
async function upload(env, actor = A) { const hash = await sha256(pdf); const response = await request(env, `/v1/sources/${sourceId}`, { actor, method: 'POST', body: pdf, headers: { 'Content-Type': 'application/pdf', 'x-content-sha256': hash, 'x-source-name': encodeURIComponent('Original conferível.pdf') } }); assert.equal(response.status, 201); return { id: sourceId, name: 'Original conferível.pdf', mimeType: 'application/pdf', sha256: hash }; }
async function enqueue(env, contributionId, action = 'structure', source = undefined) { const response = await request(env, '/v1/jobs', { method: 'POST', body: { contributionId, action, ...(source ? { sourceId: source } : {}) } }); assert.equal(response.status, 200); return response.json(); }
async function runQueued(env, index = 0) { const state = { acknowledged: false, retried: false }; await worker.queue({ messages: [{ body: env.INGEST_QUEUE.messages[index], ack() { state.acknowledged = true; }, retry() { state.retried = true; } }] }, env); return state; }
const generated = value => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] }), { headers: { 'Content-Type': 'application/json' } });

test('data routes require the gateway identity and body claims cannot select another owner', async () => {
  const env = fixture();
  assert.equal((await request(env, '/v1/capabilities', { actor: null })).status, 200);
  assert.equal((await request(env, '/v1/contributions', { actor: null })).status, 401);
  assert.equal((await request(env, '/v1/contributions', { actor: 'spoofed' })).status, 401);
  const raw = input({ actorId: B, ownerId: B, workspace_id: B });
  const saved = await save(env, raw);
  assert.equal(saved.actor.id, A);
  assert.equal(saved.original.sheet.text, raw.sheet.text);
  assert.deepEqual(saved.original.sheet.objects, raw.sheet.objects);
  assert.deepEqual(saved.manifest['@graph'].find(node => node['@type'] === 'cem:DocumentObject')['cem:originalObject'], raw.sheet.objects[0]);
  assert.equal((await request(env, `/v1/contributions/${saved.id}`, { actor: B })).status, 404);
  assert.ok([...env.DOCUMENTS.objects.keys()].every(key => key.startsWith(`owners/${A}/`)));
});

test('the compatible Lousa delta preserves literal objects as proposals and grants no graph write', async () => {
  const env = fixture(), raw = input({ scope: 'global' }), saved = await save(env, raw), delta = saved.manifest.lousaDelta;
  assert.equal(delta.schemaVersion, 'cura/semantic-delta@1'); assert.equal(delta.scope, 'private'); assert.equal(delta.status, 'proposed');
  assert.equal(saved.graph.schema, 'cura.library-graph'); assert.equal(saved.graph.scope, 'private');
  const object = saved.graph.nodes.find(node => node.kind === 'object'); assert.deepEqual(object.originalObject, raw.sheet.objects[0]);
  assert.ok(delta.operations.every(operation => operation.status === 'proposed' && operation.author === A && operation.scope === 'private'));
  const relation = delta.operations.find(operation => operation.action === 'add_relation'); assert.deepEqual(relation.body.members, [relation.body.source, relation.body.target]);
  assert.ok(delta.canonicalRefs.some(ref => ref.id === object.id));
});

test('metadata listing is owner-scoped, bounded and binds continuation cursors to their scope', async () => {
  const env = fixture();
  await save(env, input({ scope: 'personal' })); await save(env, input({ scope: 'personal' })); await save(env, input({ scope: 'global' })); await save(env, input(), B);
  const first = await (await request(env, '/v1/contributions?scope=personal&limit=1')).json(); assert.equal(first.contributions.length, 1); assert.ok(first.cursor); assert.equal(first.contributions[0].requestedScope, 'personal'); assert.equal(first.contributions[0].original, undefined);
  const second = await (await request(env, '/v1/contributions?scope=personal&limit=1&cursor=' + encodeURIComponent(first.cursor))).json(); assert.equal(second.contributions.length, 1); assert.notEqual(first.contributions[0].id, second.contributions[0].id); assert.equal(second.cursor, null);
  assert.equal((await request(env, '/v1/contributions?scope=global&cursor=' + encodeURIComponent(first.cursor))).status, 400);
  assert.equal((await request(env, '/v1/contributions?scope=personal&cursor=' + encodeURIComponent(first.cursor), { actor: B })).status, 400);
  assert.equal((await (await request(env, '/v1/contributions', { actor: B })).json()).contributions.length, 1);
});

test('idempotent retries reuse the immutable contribution and reject a changed payload', async () => {
  const env = fixture(), raw = input(), saved = await save(env, raw);
  const replay = await request(env, '/v1/contributions', { method: 'POST', body: raw });
  assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), saved);
  const conflict = await request(env, '/v1/contributions', { method: 'POST', body: { ...raw, sheet: { ...raw.sheet, text: 'changed' } } });
  assert.equal(conflict.status, 409);
  assert.equal(env.DOCUMENTS.objects.size, 1);
  assert.equal(env.DB.db.prepare('SELECT count(*) AS n FROM documental_contributions').get().n, 1);
  assert.equal((await (await request(env, `/v1/contributions/${saved.id}`)).json()).original.sheet.text, raw.sheet.text);
});

test('global intent stays a private proposal and trail intent grants no shared write authority', async () => {
  const env = fixture(), global = await save(env, input({ scope: 'global' })), trail = await save(env, input({ scope: 'trail' }));
  assert.equal(global.status, 'proposed'); assert.equal(global.effectiveScope, 'private_proposal'); assert.equal(global.delta.status, 'proposed'); assert.equal(global.visibility, 'private');
  assert.equal(trail.effectiveScope, 'owner_trail'); assert.equal(trail.visibility, 'private');
  assert.equal((await request(env, `/v1/contributions/${trail.id}`, { actor: B })).status, 404);
  assert.equal((await (await request(env, '/v1/capabilities')).json()).capabilities.globalPublishing, false);
});

test('uploads verify actual bytes, preserve immutable originals and isolate downloads by actor', async () => {
  const env = fixture(), source = await upload(env);
  const read = await request(env, `/v1/sources/${sourceId}`);
  assert.equal(read.status, 200); assert.equal(read.headers.get('x-content-sha256'), source.sha256); assert.deepEqual(new Uint8Array(await read.arrayBuffer()), pdf);
  assert.equal((await request(env, `/v1/sources/${sourceId}`, { actor: B })).status, 404);
  const bad = await request(env, `/v1/sources/${crypto.randomUUID()}`, { method: 'POST', body: pdf, headers: { 'Content-Type': 'application/pdf', 'x-content-sha256': '0'.repeat(64) } });
  assert.equal(bad.status, 422);
  const unsupported = await request(env, `/v1/sources/${crypto.randomUUID()}`, { method: 'POST', body: pdf, headers: { 'Content-Type': 'text/html', 'x-content-sha256': source.sha256 } }); assert.equal(unsupported.status, 415);
  const oversized = await request(env, `/v1/sources/${crypto.randomUUID()}`, { method: 'POST', body: pdf, headers: { 'Content-Type': 'application/pdf', 'x-content-sha256': source.sha256, 'Content-Length': String(25 * 1024 * 1024 + 1) } }); assert.equal(oversized.status, 413);
  const changed = new TextEncoder().encode('%PDF-different');
  const collision = await request(env, `/v1/sources/${sourceId}`, { method: 'POST', body: changed, headers: { 'Content-Type': 'application/pdf', 'x-content-sha256': await sha256(changed) } }); assert.equal(collision.status, 409);
  assert.equal(env.DOCUMENTS.objects.size, 1);
});

test('missing Google credentials preserve a resumable job without model calls or duplicate jobs', async () => {
  const env = fixture(), contribution = await save(env), first = await enqueue(env, contribution.id), second = await enqueue(env, contribution.id);
  assert.equal(first.status, 'needs_credentials'); assert.equal(second.id, first.id); assert.equal(env.INGEST_QUEUE.messages.length, 0);
  assert.equal((await request(env, `/v1/jobs/${first.id}`, { actor: B })).status, 404);
  env.GEMINI_API_KEY = 'test-only';
  const resumed = await enqueue(env, contribution.id); assert.equal(resumed.id, first.id); assert.equal(resumed.status, 'queued'); assert.equal(env.INGEST_QUEUE.messages.length, 1);
});

test('Google organization creates a separate advisory and leaves every original byte and object unchanged', async () => {
  const env = fixture(); env.GEMINI_API_KEY = 'test-only'; const raw = input(), contribution = await save(env, raw), job = await enqueue(env, contribution.id);
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (url, options) => { calls++; assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent'); assert.equal(options.headers['x-goog-api-key'], 'test-only'); const request = JSON.parse(options.body); assert.equal(request.generationConfig.responseMimeType, 'application/json'); assert.equal(request.tools, undefined); assert.ok(request.generationConfig.responseJsonSchema); return generated({ observations: [{ text: 'Uma observação proposta', quote: 'Texto original' }], suggestedRelations: [] }); };
  try { assert.deepEqual(await runQueued(env), { acknowledged: true, retried: false }); } finally { globalThis.fetch = originalFetch; }
  const ready = await (await request(env, `/v1/jobs/${job.id}`)).json();
  assert.equal(ready.status, 'ready'); assert.equal(ready.result.kind, 'advisory'); assert.equal(ready.result.verification, 'unreviewed');
  const unchanged = await (await request(env, `/v1/contributions/${contribution.id}`)).json(); assert.deepEqual(unchanged, contribution);
  assert.equal((await enqueue(env, contribution.id)).status, 'ready'); assert.equal(calls, 1);
});

test('document extraction returns proposed transcript pages linked to the actual preserved source hash', async () => {
  const env = fixture(); env.GEMINI_API_KEY = 'test-only'; const source = await upload(env), contribution = await save(env, input({ sources: [source] })), job = await enqueue(env, contribution.id, 'extract-document', source.id);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => { const body = JSON.parse(options.body), file = body.contents[0].parts.find(part => part.inlineData).inlineData; assert.equal(file.mimeType, 'application/pdf'); assert.equal(file.data, Buffer.from(pdf).toString('base64')); return generated({ pages: [{ page: 1, text: 'Texto transcrito proposto.' }] }); };
  try { await runQueued(env); } finally { globalThis.fetch = originalFetch; }
  const ready = await (await request(env, `/v1/jobs/${job.id}`)).json();
  assert.equal(ready.status, 'ready'); assert.equal(ready.result.sourceSha256, source.sha256); assert.deepEqual(ready.result.pages, [{ page: 1, text: 'Texto transcrito proposto.', textKind: 'transcript' }]); assert.equal(ready.result.verification, 'unreviewed');
  assert.deepEqual(new Uint8Array(await (await request(env, `/v1/sources/${source.id}`)).arrayBuffer()), pdf);
});

test('invented model quotes are rejected without changing the canonical source', async () => {
  const env = fixture(); env.GEMINI_API_KEY = 'test-only'; const contribution = await save(env), job = await enqueue(env, contribution.id), originalFetch = globalThis.fetch;
  globalThis.fetch = async () => generated({ observations: [{ text: 'Inventado', quote: 'Texto que nunca esteve na fonte' }], suggestedRelations: [] });
  try { await runQueued(env); } finally { globalThis.fetch = originalFetch; }
  const failure = await (await request(env, `/v1/jobs/${job.id}`)).json(); assert.equal(failure.status, 'failed'); assert.equal(failure.errorCode, 'provider_invented_quote'); assert.equal(failure.result, undefined);
  assert.deepEqual(await (await request(env, `/v1/contributions/${contribution.id}`)).json(), contribution);
});

test('daily budget is enforced atomically before provider calls', async () => {
  const env = fixture(); env.GEMINI_API_KEY = 'test-only'; env.MAX_JOBS_PER_ACTOR_DAY = '1';
  const first = await save(env), second = await save(env); await enqueue(env, first.id); const job = await enqueue(env, second.id);
  let calls = 0; const originalFetch = globalThis.fetch; globalThis.fetch = async () => { calls++; return generated({ observations: [], suggestedRelations: [] }); };
  try { await runQueued(env, 0); await runQueued(env, 1); } finally { globalThis.fetch = originalFetch; }
  assert.equal(calls, 1); const blocked = await (await request(env, `/v1/jobs/${job.id}`)).json(); assert.equal(blocked.status, 'needs_input'); assert.equal(blocked.errorCode, 'daily_budget_reached'); assert.equal(env.DB.db.prepare('SELECT used FROM documental_daily_budget').get().used, 1);
});

test('an interrupted provider attempt is not silently billed again by queue redelivery', async () => {
  const env = fixture(); env.GEMINI_API_KEY = 'test-only'; const contribution = await save(env), job = await enqueue(env, contribution.id);
  env.DB.db.prepare("UPDATE documental_jobs SET status='processing',attempt=1,lease_token='lost',lease_until='2020-01-01T00:00:00Z' WHERE id=?").run(job.id);
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error('must not be called'); };
  try { await runQueued(env); } finally { globalThis.fetch = originalFetch; }
  const interrupted = await (await request(env, `/v1/jobs/${job.id}`)).json(); assert.equal(interrupted.status, 'needs_input'); assert.equal(interrupted.errorCode, 'previous_attempt_interrupted'); assert.equal(interrupted.attempt, 1);
});

test('concurrent idempotent contribution requests create one immutable manifest', async () => {
  const env = fixture(), raw = input();
  const responses = await Promise.all([request(env, '/v1/contributions', { method: 'POST', body: raw }), request(env, '/v1/contributions', { method: 'POST', body: raw })]);
  assert.ok(responses.every(response => [200, 201].includes(response.status)));
  const values = await Promise.all(responses.map(response => response.json())); assert.equal(values[0].id, values[1].id); assert.deepEqual(values[0], values[1]); assert.equal(env.DOCUMENTS.objects.size, 1);
});


test('HTTP resume recovers an expired processing lease after queue delivery is lost',async()=>{
 const env=fixture(); env.GEMINI_API_KEY='test-only-secret';
 const saved=await save(env);const job=await enqueue(env,saved.id);
 env.DB.db.prepare("UPDATE documental_jobs SET status='processing',attempt=1,lease_token='lost',lease_until='2020-01-01T00:00:00Z' WHERE id=?").run(job.id);
 const response=await request(env,'/v1/jobs/'+job.id);assert.equal(response.status,200);
 assert.equal((await response.json()).status,'needs_input');
 const resumed=await enqueue(env,saved.id);assert.equal(resumed.id,job.id);assert.equal(resumed.status,'queued');
});

test('one image cannot acquire invented source page numbers from the model',async()=>{
 const {extractWithGemini}=await import('../src/gemini.ts');
 const source={id:sourceId,sha256:'a'.repeat(64),mimeType:'image/png',bytes:new Uint8Array([137,80,78,71])};
 await assert.rejects(extractWithGemini({key:'test',model:'gemini-test-model'},source,async()=>generated({pages:[{page:2,text:'invented page'}]})),e=>e.code==='provider_invalid_pages');
});
