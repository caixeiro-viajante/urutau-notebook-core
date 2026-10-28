import { authenticate, buildManifest, canonicalJson, contributionId, HASH, InputError, normalizeContribution, record, sha256, uploadMime, UUID, type Actor, type FrozenContribution, type SourceFact } from './documental';
import { extractWithGemini, ProviderError, PROVIDER_SOURCE_BYTES, structureWithGemini } from './gemini';

export type CoreEnv = Env & { GEMINI_API_KEY?: string };
type QueueJob = { ownerId: string; jobId: string };
type SourceRow = { owner_id: string; id: string; name: string; mime_type: string; sha256: string; byte_size: number; object_key: string; created_at: string };
type ContributionRow = { owner_id: string; id: string; idempotency_key: string; actor_name: string; payload_hash: string; payload_json: string; notebook_id: string; title: string; requested_scope: 'personal' | 'trail' | 'global'; effective_scope: 'personal' | 'owner_trail' | 'private_proposal'; state: 'pending' | 'ready' | 'proposed'; manifest_key: string; created_at: string };
type JobRow = { owner_id: string; id: string; contribution_id: string; action: 'structure' | 'extract-document'; source_id: string; status: 'queued' | 'processing' | 'needs_credentials' | 'needs_input' | 'ready' | 'failed'; attempt: number; lease_token: string | null; lease_until: string | null; result_key: string | null; dispatched_at: string | null; error_code: string | null; error_message: string | null; created_at: string; updated_at: string };
const MAX_SOURCE_BYTES = 25 * 1024 * 1024, MAX_CONTRIBUTION_BYTES = 1024 * 1024;
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const ownerPrefix = (owner: string) => `owners/${owner}`;
const configured = (env: CoreEnv) => Boolean(env.GEMINI_API_KEY?.trim());
const jobLimit = (env: CoreEnv) => Math.max(1, Math.min(100, Number(env.MAX_JOBS_PER_ACTOR_DAY) || 20));

/** A single bounded byte buffer; the request is never read into an additional whole-body copy. */
export async function readBounded(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new InputError('O arquivo ou pedido ultrapassa o limite permitido.', 413);
  if (!request.body) throw new InputError('Envie o conteúdo do arquivo ou pedido.');
  const output = new Uint8Array(new ArrayBuffer(declared ? Number(declared) : limit));
  const reader = request.body.getReader(); let length = 0;
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; if (length + chunk.value.byteLength > output.byteLength || length + chunk.value.byteLength > limit) { await reader.cancel(); throw new InputError('O arquivo ou pedido ultrapassa o limite permitido.', 413); } output.set(chunk.value, length); length += chunk.value.byteLength; }
  } finally { reader.releaseLock(); }
  if (declared && length !== Number(declared)) throw new InputError('O tamanho recebido não corresponde ao informado.');
  return output.subarray(0, length);
}
async function bodyJson(request: Request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new InputError('Use JSON para este pedido.', 415);
  try { return JSON.parse(new TextDecoder().decode(await readBounded(request, MAX_CONTRIBUTION_BYTES))); } catch (error) { if (error instanceof InputError) throw error; throw new InputError('O pedido JSON é inválido.'); }
}
const sourceRow = (env: CoreEnv, owner: string, id: string) => env.DB.prepare('SELECT * FROM documental_sources WHERE owner_id = ? AND id = ?').bind(owner, id).first<SourceRow>();
const contributionRow = (env: CoreEnv, owner: string, id: string) => env.DB.prepare('SELECT * FROM documental_contributions WHERE owner_id = ? AND id = ?').bind(owner, id).first<ContributionRow>();
const jobRow = (env: CoreEnv, owner: string, id: string) => env.DB.prepare('SELECT * FROM documental_jobs WHERE owner_id = ? AND id = ?').bind(owner, id).first<JobRow>();

async function uploadSource(request: Request, env: CoreEnv, actor: Actor, id: string) {
  const expected = request.headers.get('x-content-sha256') || request.headers.get('x-source-sha256'), mimeType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!expected || !HASH.test(expected)) throw new InputError('Informe o SHA-256 do original antes do envio.');
  if (!uploadMime(mimeType)) throw new InputError('Envie PDF, imagem ou áudio em formato compatível.', 415);
  let name = request.headers.get('x-source-name') || request.headers.get('x-file-name') || 'Original';
  try { name = decodeURIComponent(name); } catch { throw new InputError('O nome do arquivo é inválido.'); }
  if (!name.trim() || name.length > 500 || /[\u0000-\u001f]/.test(name)) throw new InputError('O nome do arquivo é inválido.');
  const bytes = await readBounded(request, MAX_SOURCE_BYTES);
  if (!bytes.length) throw new InputError('O arquivo está vazio.');
  if (mimeType === 'application/pdf' && new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new InputError('Os bytes recebidos não correspondem a um PDF.');
  const digest = await sha256(bytes);
  if (digest !== expected.toLowerCase()) throw new InputError('O hash do arquivo recebido não corresponde ao original informado.', 422);
  const existing = await sourceRow(env, actor.id, id);
  if (existing) {
    if (existing.sha256 !== digest || existing.mime_type !== mimeType) throw new InputError('Esta identificação já pertence a outro original. O arquivo existente foi preservado.', 409);
    return json({ id, status: 'stored', sha256: digest, mimeType: existing.mime_type, size: existing.byte_size });
  }
  const key = `${ownerPrefix(actor.id)}/sources/${id}/${digest}`, at = new Date().toISOString();
  await env.DOCUMENTS.put(key, bytes, { httpMetadata: { contentType: mimeType }, customMetadata: { owner: actor.id, sha256: digest }, onlyIf: { etagDoesNotMatch: '*' } });
  await env.DB.prepare('INSERT OR IGNORE INTO documental_sources (owner_id,id,name,mime_type,sha256,byte_size,object_key,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(actor.id, id, name, mimeType, digest, bytes.length, key, at).run();
  const stored = await sourceRow(env, actor.id, id);
  if (!stored || stored.sha256 !== digest || stored.mime_type !== mimeType) throw new InputError('Outro original já foi associado a esta identificação.', 409);
  return json({ id, status: 'stored', sha256: digest, mimeType, size: bytes.length }, 201);
}

async function readSource(env: CoreEnv, actor: Actor, id: string) {
  const source = await sourceRow(env, actor.id, id);
  if (!source) throw new InputError('Original não encontrado.', 404);
  const object = await env.DOCUMENTS.get(source.object_key);
  if (!object) throw new InputError('O original está temporariamente indisponível.', 503);
  return new Response(object.body, { headers: { ...headers, 'Content-Type': source.mime_type, 'Content-Length': String(source.byte_size), 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(source.name)}`, ETag: `"sha256:${source.sha256}"`, 'X-Content-SHA256': source.sha256 } });
}

async function readContribution(env: CoreEnv, actor: Actor, id: string) {
  const row = await contributionRow(env, actor.id, id);
  if (!row) throw new InputError('Contribuição não encontrada.', 404);
  if (row.state === 'pending') return json({ id, contributionId: id, status: 'pending' }, 202);
  const stored = await env.DOCUMENTS.get(row.manifest_key);
  if (!stored) throw new InputError('A contribuição está temporariamente indisponível.', 503);
  return new Response(stored.body, { headers: { ...headers, 'Content-Type': 'application/ld+json', ETag: `"sha256:${row.payload_hash}"` } });
}

async function listContributions(env: CoreEnv, actor: Actor, url: URL) {
  const scope = url.searchParams.get('scope') || '', rawLimit = url.searchParams.get('limit') || '20';
  if (scope && !['personal', 'trail', 'global'].includes(scope) || !/^\d{1,2}$/.test(rawLimit)) throw new InputError('Filtro de contribuições inválido.');
  const limit = Math.max(1, Math.min(50, Number(rawLimit)));
  const cursor = url.searchParams.get('cursor'); let previous: { at: string; id: string } | null = null;
  if (cursor) {
    if (cursor.length > 600) throw new InputError('Cursor inválido.');
    try {
      const decoded = record(JSON.parse(atob(cursor)));
      if (decoded.owner !== actor.id || decoded.scope !== scope || typeof decoded.at !== 'string' || !Number.isFinite(Date.parse(decoded.at)) || typeof decoded.id !== 'string' || !UUID.test(decoded.id)) throw new Error('bad cursor');
      previous = { at: decoded.at, id: decoded.id };
    } catch { throw new InputError('Cursor inválido para esta consulta.'); }
  }
  const conditions = ['owner_id = ?', "state IN ('ready','proposed')"], values: (string | number)[] = [actor.id];
  if (scope) { conditions.push('requested_scope = ?'); values.push(scope); }
  if (previous) { conditions.push('(created_at < ? OR (created_at = ? AND id < ?))'); values.push(previous.at, previous.at, previous.id); }
  values.push(limit + 1);
  const result = await env.DB.prepare(`SELECT id,notebook_id,title,requested_scope,effective_scope,state,payload_hash,created_at FROM documental_contributions WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`).bind(...values).all<ContributionRow>();
  const rows = result.results.slice(0, limit), last = rows.at(-1);
  const next = result.results.length > limit && last ? btoa(JSON.stringify({ owner: actor.id, scope, at: last.created_at, id: last.id })) : null;
  return json({ contributions: rows.map(row => ({ id: row.id, contributionId: row.id, notebookId: row.notebook_id, title: row.title, requestedScope: row.requested_scope, effectiveScope: row.effective_scope, status: row.state, revision: `sha256:${row.payload_hash}`, createdAt: row.created_at })), cursor: next });
}

async function createContribution(request: Request, env: CoreEnv, actor: Actor) {
  const input = normalizeContribution(await bodyJson(request)), hash = await sha256(canonicalJson(input)), id = await contributionId(actor.id, input.idempotencyKey);
  let row = await contributionRow(env, actor.id, id);
  if (row && row.payload_hash !== hash) throw new InputError('Esta operação já foi usada com outro conteúdo.', 409);
  if (row && row.state !== 'pending') return readContribution(env, actor, id);
  if (!row) {
    const facts: SourceFact[] = [];
    for (const source of input.sources) {
      const stored = await sourceRow(env, actor.id, source.id);
      if (stored && (stored.mime_type !== source.mimeType || source.sha256 && stored.sha256 !== source.sha256)) throw new InputError('A referência não corresponde ao original preservado.', 409);
      facts.push(stored ? { id: source.id, name: source.name, mimeType: stored.mime_type, sha256: stored.sha256, size: stored.byte_size, status: 'stored' } : { ...source, status: 'declared' });
    }
    const at = new Date().toISOString(), effective = input.scope === 'global' ? 'private_proposal' : input.scope === 'trail' ? 'owner_trail' : 'personal';
    const frozen: FrozenContribution = { ...input, sourceFacts: facts }, key = `${ownerPrefix(actor.id)}/contributions/${id}/${hash}.jsonld`;
    await env.DB.prepare('INSERT OR IGNORE INTO documental_contributions (owner_id,id,idempotency_key,actor_name,payload_hash,payload_json,notebook_id,title,requested_scope,effective_scope,state,manifest_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(actor.id, id, input.idempotencyKey, actor.name, hash, canonicalJson(frozen), input.notebookId, input.title, input.scope, effective, 'pending', key, at).run();
    row = await contributionRow(env, actor.id, id);
    if (!row || row.payload_hash !== hash) throw new InputError('Esta operação já foi usada com outro conteúdo.', 409);
  }
  const frozen = JSON.parse(row.payload_json) as FrozenContribution;
  const manifest = buildManifest(frozen, { id: row.owner_id, name: row.actor_name }, row.id, `sha256:${row.payload_hash}`, row.created_at);
  await env.DOCUMENTS.put(row.manifest_key, JSON.stringify(manifest), { httpMetadata: { contentType: 'application/ld+json' }, onlyIf: { etagDoesNotMatch: '*' } });
  await env.DB.prepare("UPDATE documental_contributions SET state = ? WHERE owner_id = ? AND id = ? AND payload_hash = ? AND state = 'pending'").bind(input.scope === 'global' ? 'proposed' : 'ready', actor.id, row.id, row.payload_hash).run();
  return json(manifest, 201);
}

async function publicJob(env: CoreEnv, actor: Actor, id: string) {
  let row = await jobRow(env, actor.id, id);
  if (!row) throw new InputError('Trabalho não encontrado.', 404);
  if(row.status==='processing'&&row.lease_token&&(!row.lease_until||row.lease_until<=new Date().toISOString())){
    const key=`${ownerPrefix(row.owner_id)}/jobs/${row.id}/attempt-${row.attempt}.json`;
    if(await env.DOCUMENTS.head(key))await finishJob(env,row,row.lease_token,'ready',null,null,key);
    else await finishJob(env,row,row.lease_token,'needs_input','previous_attempt_interrupted','A tentativa anterior foi interrompida. Confira antes de pedir outro processamento.');
    row=(await jobRow(env,actor.id,id))!;
  }
  let result: unknown;
  if (row.status === 'ready') {
    const stored = row.result_key ? await env.DOCUMENTS.get(row.result_key) : null;
    if (!stored) throw new InputError('O resultado está temporariamente indisponível.', 503);
    result = await stored.json();
  }
  return json({ id: row.id, jobId: row.id, contributionId: row.contribution_id, action: row.action, status: row.status, attempt: row.attempt, ...(row.source_id ? { sourceId: row.source_id } : {}), ...(row.error_code ? { error: row.error_message, errorCode: row.error_code } : {}), ...(result ? { result } : {}), updatedAt: row.updated_at });
}

async function createJob(request: Request, env: CoreEnv, actor: Actor) {
  const raw = record(await bodyJson(request));
  if (typeof raw.contributionId !== 'string' || !UUID.test(raw.contributionId) || !['structure', 'extract-document'].includes(String(raw.action))) throw new InputError('Escolha uma contribuição e um processamento válidos.');
  const contribution = await contributionRow(env, actor.id, raw.contributionId);
  if (!contribution || contribution.state === 'pending') throw new InputError('Contribuição não encontrada ou ainda em preparação.', 404);
  const input = JSON.parse(contribution.payload_json) as FrozenContribution;
  let sourceId = '';
  if (raw.action === 'extract-document') {
    if (raw.sourceId !== undefined && (typeof raw.sourceId !== 'string' || !UUID.test(raw.sourceId))) throw new InputError('Escolha um original válido.');
    const sources = raw.sourceId ? input.sources.filter(source => source.id === raw.sourceId) : input.sources;
    if (sources.length !== 1) throw new InputError('Escolha um único original para esta extração.');
    sourceId = sources[0].id;
    if (!await sourceRow(env, actor.id, sourceId)) throw new InputError('Envie o original antes de solicitar a extração.');
  }
  const at = new Date().toISOString(), id = crypto.randomUUID(), keyReady = configured(env);
  await env.DB.prepare('INSERT OR IGNORE INTO documental_jobs (owner_id,id,contribution_id,action,source_id,status,attempt,error_code,error_message,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(actor.id, id, contribution.id, raw.action, sourceId, keyReady ? 'queued' : 'needs_credentials', 0, keyReady ? null : 'gemini_key_missing', keyReady ? null : 'O original e a contribuição foram preservados. Configure o Google AI para processar.', at, at).run();
  let row = await env.DB.prepare('SELECT * FROM documental_jobs WHERE owner_id = ? AND contribution_id = ? AND action = ? AND source_id = ?').bind(actor.id, contribution.id, raw.action, sourceId).first<JobRow>();
  if (!row) throw new InputError('Não consegui preparar o trabalho.', 503);
  if (['needs_credentials', 'needs_input', 'failed'].includes(row.status) && keyReady) {
    await env.DB.prepare("UPDATE documental_jobs SET status = 'queued', dispatched_at = NULL, error_code = NULL, error_message = NULL, updated_at = ? WHERE owner_id = ? AND id = ? AND status IN ('needs_credentials','needs_input','failed')").bind(at, actor.id, row.id).run();
    row = (await jobRow(env, actor.id, row.id))!;
  }
  if (row.status === 'queued' && !row.dispatched_at) {
    try {
      await env.INGEST_QUEUE.send({ ownerId: actor.id, jobId: row.id }, { contentType: 'json' });
      await env.DB.prepare("UPDATE documental_jobs SET dispatched_at = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND status = 'queued'").bind(at, at, actor.id, row.id).run();
    } catch { throw new InputError('O trabalho foi preservado, mas não entrou na fila. Tente novamente.', 503); }
  }
  return publicJob(env, actor, row.id);
}

async function finishJob(env: CoreEnv, row: JobRow, lease: string, status: JobRow['status'], code: string | null, message: string | null, resultKey: string | null = null) {
  await env.DB.prepare('UPDATE documental_jobs SET status = ?, result_key = ?, error_code = ?, error_message = ?, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE owner_id = ? AND id = ? AND lease_token = ?').bind(status, resultKey, code, message, new Date().toISOString(), row.owner_id, row.id, lease).run();
}

async function runJob(env: CoreEnv, message: Message<QueueJob>) {
  const body = record(message.body);
  if (typeof body.ownerId !== 'string' || !/^[a-f0-9]{64}$/.test(body.ownerId) || typeof body.jobId !== 'string' || !UUID.test(body.jobId)) { message.ack(); return; }
  let row = await jobRow(env, body.ownerId, body.jobId);
  if (!row || ['ready', 'needs_credentials', 'needs_input', 'failed'].includes(row.status)) { message.ack(); return; }
  const at = new Date().toISOString();
  if (row.status === 'processing') {
    if (row.lease_until && row.lease_until > at) { message.retry({ delaySeconds: 120 }); return; }
    const recoveredKey = `${ownerPrefix(row.owner_id)}/jobs/${row.id}/attempt-${row.attempt}.json`;
    const recovered = await env.DOCUMENTS.head(recoveredKey);
    if (recovered && row.lease_token) await finishJob(env, row, row.lease_token, 'ready', null, null, recoveredKey);
    else if (row.lease_token) await finishJob(env, row, row.lease_token, 'needs_input', 'previous_attempt_interrupted', 'A tentativa anterior foi interrompida. Confira antes de pedir outro processamento.');
    message.ack(); return;
  }
  const lease = crypto.randomUUID(), until = new Date(Date.now() + 120000).toISOString();
  const claimed = await env.DB.prepare("UPDATE documental_jobs SET status = 'processing', attempt = attempt + 1, lease_token = ?, lease_until = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND status = 'queued'").bind(lease, until, at, row.owner_id, row.id).run();
  if (!claimed.meta.changes) { message.retry({ delaySeconds: 120 }); return; }
  row = (await jobRow(env, row.owner_id, row.id))!;
  try {
    if (!configured(env)) { await finishJob(env, row, lease, 'needs_credentials', 'gemini_key_missing', 'Configure o Google AI para processar. O original continua preservado.'); message.ack(); return; }
    const contribution = await contributionRow(env, row.owner_id, row.contribution_id);
    if (!contribution || contribution.state === 'pending') throw new ProviderError('contribution_unavailable', 'A contribuição não está disponível.', true);
    const input = JSON.parse(contribution.payload_json) as FrozenContribution;
    let source: SourceRow | null = null;
    if (row.action === 'extract-document') {
      source = await sourceRow(env, row.owner_id, row.source_id);
      if (!source || !input.sources.some(item => item.id === source!.id)) throw new ProviderError('source_unavailable', 'O original não está disponível nesta contribuição.', true);
      if (!uploadMime(source.mime_type) || source.byte_size > PROVIDER_SOURCE_BYTES) throw new ProviderError('provider_source_too_large', 'O original foi preservado. Para esta extração, use um arquivo compatível de até 12 MB.', true);
    }
    const day = at.slice(0, 10);
    const budget = await env.DB.prepare('INSERT INTO documental_daily_budget (owner_id,day,used) VALUES (?,?,1) ON CONFLICT(owner_id,day) DO UPDATE SET used = used + 1 WHERE used < ? RETURNING used').bind(row.owner_id, day, jobLimit(env)).first<{ used: number }>();
    if (!budget) throw new ProviderError('daily_budget_reached', 'O limite diário de processamentos foi atingido. A contribuição continua guardada.', true);
    const config = { key: env.GEMINI_API_KEY!, model: env.GEMINI_MODEL };
    let result: unknown;
    if (row.action === 'structure') {
      const original = buildManifest(input, { id: row.owner_id, name: 'Participante' }, contribution.id, `sha256:${contribution.payload_hash}`, contribution.created_at);
      const nodeIds = original.manifest['@graph'].map(node => record(node)['@id']).filter((id): id is string => typeof id === 'string');
      result = await structureWithGemini(config, input, { contributionId: contribution.id, revision: `sha256:${contribution.payload_hash}`, nodeIds });
    } else {
      const stored = await env.DOCUMENTS.get(source!.object_key);
      if (!stored) throw new ProviderError('source_unavailable', 'O original está temporariamente indisponível.', true);
      result = await extractWithGemini(config, { id: source!.id, sha256: source!.sha256, mimeType: source!.mime_type, bytes: new Uint8Array(await stored.arrayBuffer()) });
    }
    const resultKey = `${ownerPrefix(row.owner_id)}/jobs/${row.id}/attempt-${row.attempt}.json`;
    await env.DOCUMENTS.put(resultKey, JSON.stringify(result), { httpMetadata: { contentType: 'application/json' }, onlyIf: { etagDoesNotMatch: '*' } });
    await finishJob(env, row, lease, 'ready', null, null, resultKey);
  } catch (error) {
    const provider = error instanceof ProviderError ? error : new ProviderError('processing_failed', 'O processamento não foi concluído. A fonte e a contribuição continuam preservadas.');
    await finishJob(env, row, lease, provider.needsInput ? 'needs_input' : 'failed', provider.code, provider.message);
  }
  message.ack();
}

export default {
  async fetch(request: Request, env: CoreEnv): Promise<Response> {
    try {
      const url = new URL(request.url), path = url.pathname;
      if (request.method === 'GET' && path === '/v1/capabilities') return json({ schemaVersion: 'urutau-notebook-core/0.1', available: true, provider: 'google-gemini', model: env.GEMINI_MODEL, credentialsConfigured: configured(env), capabilities: { recordContribution: true, preserveOriginal: true, structure: configured(env), extractDocument: configured(env), globalPublishing: false, sharedTrailWrite: false }, limits: { sourceBytes: MAX_SOURCE_BYTES, providerSourceBytes: PROVIDER_SOURCE_BYTES, contributionBytes: MAX_CONTRIBUTION_BYTES, pages: 100, jobsPerActorDay: jobLimit(env) } });
      const actor = authenticate(request);
      if (path === '/v1/contributions' && request.method === 'GET') return await listContributions(env, actor, url);
      if (path === '/v1/contributions' && request.method === 'POST') return await createContribution(request, env, actor);
      if (path === '/v1/jobs' && request.method === 'POST') return await createJob(request, env, actor);
      const match = path.match(/^\/v1\/(sources|contributions|jobs)\/([a-f0-9-]{36})$/i);
      if (!match || !UUID.test(match[2])) throw new InputError('Operação não encontrada.', 404);
      const [, resource, id] = match;
      if (resource === 'sources' && request.method === 'POST') return await uploadSource(request, env, actor, id);
      if (resource === 'sources' && request.method === 'GET') return await readSource(env, actor, id);
      if (resource === 'contributions' && request.method === 'GET') return await readContribution(env, actor, id);
      if (resource === 'jobs' && request.method === 'GET') return await publicJob(env, actor, id);
      throw new InputError('Operação não encontrada.', 404);
    } catch (error) {
      if (error instanceof InputError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({ event: 'documental_core_error', name: error instanceof Error ? error.name : 'Error' }));
      return json({ error: 'O núcleo documental está temporariamente indisponível. Seus originais não foram substituídos.' }, 503);
    }
  },
  async queue(batch: MessageBatch<QueueJob>, env: CoreEnv): Promise<void> {
    for (const message of batch.messages) {
      try { await runJob(env, message); } catch { message.retry({ delaySeconds: 120 }); }
    }
  },
};
