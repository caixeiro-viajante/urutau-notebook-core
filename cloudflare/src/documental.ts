export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Actor = { id: string; name: string };
export type SourceInput = { id: string; name: string; mimeType: string; sha256?: string };
export type ContributionInput = {
  idempotencyKey: string; notebookId: string; title: string; scope: 'personal' | 'trail' | 'global'; revision?: string;
  sheet: { id: string; text: string; objects?: Json }; sources: SourceInput[];
};
export type SourceFact = SourceInput & { status: 'stored' | 'declared'; sha256?: string; size?: number };
export type FrozenContribution = ContributionInput & { sourceFacts: SourceFact[] };
export class InputError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
export const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const HASH = /^[a-f0-9]{64}$/i;
export const safeId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(value);
export const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown, label: string, limit: number, empty = false) => {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) throw new InputError(`${label} inválido.`);
  return value;
};
export const uploadMime = (mime: string) => /^(application\/pdf|image\/(jpeg|png|webp|gif)|audio\/(mpeg|mp3|wav|x-wav|webm|ogg|mp4|aac|flac))$/.test(mime);

export function authenticate(request: Request): Actor {
  // Only a private service binding may reach this Worker. The gateway derives these headers from its signed session.
  const id = request.headers.get('x-urutau-actor');
  if (!id || !/^[a-f0-9]{64}$/.test(id)) throw new InputError('Entre na sua conta para usar o caderno documental.', 401);
  let name = request.headers.get('x-urutau-name') || 'Participante';
  try { name = decodeURIComponent(name); } catch { throw new InputError('Identificação do participante inválida.', 401); }
  return { id, name: name.slice(0, 200) };
}

export function normalizeContribution(value: unknown): ContributionInput {
  const raw = record(value), sheet = record(raw.sheet);
  if (typeof raw.idempotencyKey !== 'string' || !UUID.test(raw.idempotencyKey)) throw new InputError('A operação precisa de uma chave de repetição válida.');
  if (!safeId(raw.notebookId) || !safeId(sheet.id)) throw new InputError('Caderno ou folha inválidos.');
  if (!['personal', 'trail', 'global'].includes(String(raw.scope))) throw new InputError('Escolha o alcance da contribuição.');
  const text = string(sheet.text, 'Texto da folha', 500000, true);
  const objects = sheet.objects === undefined ? undefined : checkedJson(sheet.objects);
  if (objects !== undefined && (objects === null || typeof objects !== 'object')) throw new InputError('Os objetos da folha precisam ser estruturados.');
  if (!Array.isArray(raw.sources) || raw.sources.length > 32) throw new InputError('Use até 32 referências de arquivo por contribuição.');
  const ids = new Set<string>();
  const sources = raw.sources.map(value => {
    const item = record(value);
    if (typeof item.id !== 'string' || !UUID.test(item.id) || ids.has(item.id)) throw new InputError('Identificação de anexo inválida ou repetida.');
    ids.add(item.id);
    const name = string(item.name, 'Nome do anexo', 500), mimeType = string(item.mimeType, 'Tipo do anexo', 128).toLowerCase();
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mimeType)) throw new InputError('Tipo de arquivo inválido.');
    if (item.sha256 !== undefined && (typeof item.sha256 !== 'string' || !HASH.test(item.sha256))) throw new InputError('Hash do anexo inválido.');
    return { id: item.id, name, mimeType, ...(typeof item.sha256 === 'string' ? { sha256: item.sha256.toLowerCase() } : {}) };
  });
  const revision = raw.revision === undefined ? undefined : string(raw.revision, 'Revisão de origem', 200);
  return { idempotencyKey: raw.idempotencyKey, notebookId: raw.notebookId, title: string(raw.title, 'Título', 200), scope: raw.scope as ContributionInput['scope'], ...(revision ? { revision } : {}), sheet: { id: sheet.id, text, ...(objects !== undefined ? { objects } : {}) }, sources };
}

export function checkedJson(value: unknown, depth = 0, count = { nodes: 0 }): Json {
  if (depth > 12 || ++count.nodes > 12000) throw new InputError('A estrutura da folha é grande demais.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string' && value.length <= 500000 || typeof value === 'number' && Number.isFinite(value)) return value as Json;
  if (Array.isArray(value)) return value.map(item => checkedJson(item, depth + 1, count));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key.length > 200) throw new InputError('Um campo da estrutura é grande demais.');
    return [key, checkedJson(item, depth + 1, count)];
  }));
  throw new InputError('A estrutura da folha contém dados inválidos.');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new InputError('Valor não serializável.');
  return encoded;
}
export async function sha256(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function contributionId(actor: string, key: string) {
  const h = await sha256(`${actor}:contribution:${key}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function buildManifest(input: FrozenContribution, actor: Actor, id: string, revision: string, at: string) {
  const urn = `urn:urutau:owner:${actor.id}`, sheetId = `${urn}:sheet:${input.sheet.id}`, notebookId = `${urn}:notebook:${input.notebookId}`;
  const effectiveScope = input.scope === 'global' ? 'private_proposal' : input.scope === 'trail' ? 'owner_trail' : 'personal';
  const status = input.scope === 'global' ? 'proposed' : 'ready';
  const graph: Json[] = [
    { '@id': notebookId, '@type': 'schema:Collection', 'schema:name': input.title },
    { '@id': sheetId, '@type': 'schema:CreativeWork', 'schema:text': input.sheet.text, 'cem:structuredObjects': input.sheet.objects ?? [], 'prov:wasAttributedTo': { '@id': urn }, 'cem:revision': revision },
    ...input.sourceFacts.map(source => ({ '@id': `${urn}:source:${source.id}`, '@type': 'schema:MediaObject', 'schema:name': source.name, 'schema:encodingFormat': source.mimeType, 'cem:availability': source.status, ...(source.sha256 ? { [source.status === 'stored' ? 'cem:sha256' : 'cem:claimedSha256']: source.sha256 } : {}), ...(source.size !== undefined ? { 'schema:contentSize': source.size } : {}) })),
  ];
  const objects = Array.isArray(input.sheet.objects) ? input.sheet.objects : input.sheet.objects ? [input.sheet.objects] : [];
  objects.forEach((object, index) => graph.push({ '@id': `${sheetId}:object:${index}`, '@type': 'cem:DocumentObject', 'cem:originalObject': object, 'prov:wasDerivedFrom': { '@id': sheetId } }));
  const operations: Json[] = graph.map((node, index) => ({ id: `${id}:node:${index}`, action: 'add_node', target: { kind: 'node', id: (node as Record<string, Json>)['@id'] }, body: node }));
  operations.push({ id: `${id}:contains`, action: 'add_relation', target: { kind: 'edge', id: `${id}:contains` }, body: { source: notebookId, target: sheetId, kind: 'contains' } });
  input.sourceFacts.forEach((source, index) => operations.push({ id: `${id}:source:${index}`, action: 'add_relation', target: { kind: 'edge', id: `${id}:source:${index}` }, body: { source: sheetId, target: `${urn}:source:${source.id}`, kind: 'has_source' } }));
  objects.forEach((_, index) => operations.push({ id: `${id}:object:${index}`, action: 'add_relation', target: { kind: 'edge', id: `${id}:object:${index}` }, body: { source: sheetId, target: `${sheetId}:object:${index}`, kind: 'contains_object' } }));
  const nodes = graph.map((value, index) => {
    const node = value as Record<string, Json>;
    const original = node['cem:originalObject'];
    const data = record(original);
    return { id: node['@id'] as string, kind: index === 0 ? 'notebook' : index === 1 ? 'sheet' : original !== undefined ? 'object' : 'source', label: typeof node['schema:name'] === 'string' ? node['schema:name'] : typeof data.label === 'string' ? data.label : index === 1 ? input.title : 'Objeto da folha', ...(index === 1 ? { text: input.sheet.text, targetId: input.sheet.id } : {}), ...(original !== undefined ? { originalObject: original } : {}), provenance: { contributionId: id, revision } };
  });
  const edges = operations.filter(value => record(value).action === 'add_relation').map(value => { const operation = record(value), body = record(operation.body); return { id: operation.id as string, source: body.source as string, target: body.target as string, kind: body.kind as string }; });
  const occurrenceIds = objects.map(value => record(value).occurrenceId).filter((value): value is string => typeof value === 'string');
  const lousaDelta = {
    schemaVersion: 'cura/semantic-delta@1', id: `${id}:lousa`, workbenchId: `${urn}:workbench`, title: input.title, createdAt: at,
    canonicalRefs: nodes.map(node => ({ kind: 'node', id: node.id })), occurrenceIds, scope: 'private', author: actor.id, status: 'proposed',
    operations: [
      ...nodes.map(node => ({ id: `${id}:node:${node.id}`, action: 'add_node', target: { kind: 'node', id: node.id }, body: { ...node, definition: node.text || node.label }, createdAt: at, scope: 'private', author: actor.id, status: 'proposed' })),
      ...edges.map(edge => ({ id: edge.id, action: 'add_relation', target: { kind: 'edge', id: edge.id }, body: { ...edge, label: edge.kind, members: [edge.source, edge.target] }, createdAt: at, scope: 'private', author: actor.id, status: 'proposed' })),
    ],
  };
  return {
    schemaVersion: 'urutau-notebook-core/0.1', id, contributionId: id, revision, createdAt: at, title: input.title,
    requestedScope: input.scope, effectiveScope, status, visibility: 'private', actor: { id: actor.id, name: actor.name },
    original: { sheet: input.sheet, sources: input.sourceFacts, ...(input.revision ? { revision: input.revision } : {}) },
    manifest: { '@context': { schema: 'https://schema.org/', prov: 'http://www.w3.org/ns/prov#', cem: 'https://curaemmovimento.com.br/ns#' }, '@id': `${urn}:contribution:${id}`, '@type': 'prov:Entity', 'prov:wasAttributedTo': { '@id': urn }, 'prov:generatedAtTime': at, '@graph': graph, lousaDelta },
    graph: { schema: 'cura.library-graph', scope: 'private', nodes, edges },
    delta: { schemaVersion: 'urutau/semantic-delta@1', id: `${id}:delta`, ownerId: actor.id, requestedScope: input.scope, effectiveScope, status: input.scope === 'global' ? 'proposed' : 'recorded', visibility: 'private', sourceRevision: revision, operations },
    sourceStatuses: input.sourceFacts.map(source => ({ id: source.id, status: source.status, ...(source.sha256 ? { sha256: source.sha256 } : {}) })),
  };
}
