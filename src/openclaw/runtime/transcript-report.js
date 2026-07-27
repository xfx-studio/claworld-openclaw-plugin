import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  CLAWORLD_TRANSCRIPT_STYLE_NAME,
  measureTranscriptItem,
  paginateTranscriptItems,
  renderTranscriptPageSvg,
} from './transcript-report-comic-grid.js';
import { displayCols, omitEmoji } from './transcript-report-stylekit.js';
import {
  appendClaworldJournalEvent,
  withClaworldSessionDirectoryWriteLock,
} from './working-memory.js';

const DEFAULT_WIDTH = 720;
const DEFAULT_MAX_PAGE_HEIGHT = 8000;
export const MAX_PAGE_HEIGHT = 32000;
const TIME_SPLIT_SECONDS = 5 * 60;
const SESSION_INDEX_RELATIVE_PATH = path.join('.claworld', 'sessions', 'index.json');

const PUBLIC_HEADER_RENDER_FIELDS = new Set([
  'chatMode',
  'worldName',
  'initiatedBy',
  'topic',
  'title',
  'peerProfile',
  'worldContext',
  'localIdentity',
  'peerIdentity',
  'localLabel',
  'peerLabel',
]);
const MANUAL_RENDER_FIELDS = new Set(['messages', 'reportType', ...PUBLIC_HEADER_RENDER_FIELDS]);
const STORED_RENDER_FIELDS = new Set(['chatRequestId', 'accountId', ...PUBLIC_HEADER_RENDER_FIELDS]);
const TOP_LEVEL_RENDER_FIELDS = new Set([
  'mode',
  'stored', // Runtime-only compatibility for calls made before the flat contract.
  'manual',
  'style',
  'maxPageHeight',
  ...STORED_RENDER_FIELDS,
]);
const MANUAL_MESSAGE_FIELDS = new Set(['from', 'text', 'createdAt']);
const CONVERSATION_CONTEXT_SCHEMA_V1 = 'claworld.conversation_context.v1';

const OPERATIONAL_NOTICE_PATTERNS = [
  /^🧭\s*New session:\s+\S+/iu,
  /^🧹\s*Auto-compaction complete(?:\s*\(count \d+\))?\.$/iu,
  /^↪️?\s*Model Fallback:/iu,
  /^↪️?\s*Model Fallback cleared:/iu,
  /^⚠️?\s*Agent failed before reply:/iu,
  /^Sent the (?:reply|opener|Claworld reply)\.?$/iu,
  /^◐\s*Session automatically reset\b/iu,
];
const RUNTIME_ERROR_PATTERNS = [
  /^⚠️?\s*Agent failed before reply:/iu,
  /^LLM request failed:/iu,
  /^LLM request timed out\.$/iu,
  /^LLM request unauthorized\.$/iu,
  /^The AI service is temporarily overloaded\.$/iu,
  /^The AI service returned an error\.$/iu,
  /^⚠️?\s*API rate limit reached\.$/iu,
  /^⚠️?\s*.+\s+returned a billing error\b/iu,
];
const OPERATIONAL_SUFFIX_PATTERNS = [
  /^Usage:\s+.+\s+in\s+\/\s+.+\s+out(?:\s+·\s+est\s+.+)?$/iu,
];

function text(value, fallback = null) {
  if (value == null) return fallback;
  const normalized = String(value).trim();
  return normalized || fallback;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compactObject(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => (
    entry != null && entry !== '' && (!Array.isArray(entry) || entry.length > 0)
  )));
}

function isoNow() {
  return new Date().toISOString();
}

async function readJsonObject(filePath, fallback = {}) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return isObject(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function atomicWriteText(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function atomicWriteJson(filePath, payload) {
  await atomicWriteText(filePath, JSON.stringify(payload, null, 2));
}

function sessionIndexPath(workspaceRoot) {
  return path.join(workspaceRoot, SESSION_INDEX_RELATIVE_PATH);
}

function emptySessionIndex() {
  const now = isoNow();
  return {
    schema: 'claworld.sessions.v1',
    version: 1,
    createdAt: now,
    updatedAt: now,
    main: {},
    management: {},
    conversationSessions: {},
    conversationEpisodes: {},
  };
}

async function readSessionIndex(workspaceRoot) {
  const index = await readJsonObject(sessionIndexPath(workspaceRoot), emptySessionIndex());
  if (!isObject(index.main)) index.main = {};
  if (!isObject(index.management)) index.management = {};
  if (!isObject(index.conversationSessions)) index.conversationSessions = {};
  if (!isObject(index.conversationEpisodes)) index.conversationEpisodes = {};
  return index;
}

function episodeAccountStorageKey(chatRequestId, accountId) {
  const requestId = text(chatRequestId, null);
  const account = text(accountId, null);
  return requestId && account ? `account:${encodeURIComponent(account)}:${requestId}` : requestId;
}

function episodeEntriesForRequest(index, chatRequestId) {
  const requestId = text(chatRequestId, null);
  if (!requestId) return [];
  return Object.entries(isObject(index.conversationEpisodes) ? index.conversationEpisodes : {})
    .filter(([key, entry]) => isObject(entry) && text(entry.chatRequestId, key) === requestId)
    .map(([key, entry]) => ({ key, entry }));
}

function episodeMatchesRelayView(entry, { relayAgentId, targetAgentId } = {}) {
  const expectedRelayAgentId = text(relayAgentId, text(targetAgentId, null));
  if (!expectedRelayAgentId) return false;
  return [entry.relayAgentId, entry.targetAgentId]
    .map((candidate) => text(candidate, null))
    .filter(Boolean)
    .includes(expectedRelayAgentId);
}

function resolveEpisodeRecord(index, chatRequestId, view = {}, { create = false } = {}) {
  const requestId = text(chatRequestId, null);
  const accountId = text(view.accountId, null);
  const entries = episodeEntriesForRequest(index, requestId);
  if (accountId) {
    const desiredKey = episodeAccountStorageKey(requestId, accountId);
    const exact = entries.find(({ key }) => key === desiredKey)
      || entries.find(({ entry }) => text(entry.accountId, null) === accountId);
    if (exact) return { ...exact, desiredKey, ambiguous: false };
    const legacyMatches = entries.filter(({ entry }) => (
      !text(entry.accountId, null) && episodeMatchesRelayView(entry, view)
    ));
    if (legacyMatches.length === 1) {
      return { ...legacyMatches[0], desiredKey, migrate: true, ambiguous: false };
    }
    if (!create) return { key: null, entry: null, desiredKey, ambiguous: legacyMatches.length > 1 };
    return { key: desiredKey, entry: {}, desiredKey, ambiguous: false };
  }
  if (entries.length === 1) return { ...entries[0], desiredKey: entries[0].key, ambiguous: false };
  if (entries.length > 1) return { key: null, entry: null, desiredKey: null, ambiguous: true };
  return create
    ? { key: requestId, entry: {}, desiredKey: requestId, ambiguous: false }
    : { key: null, entry: null, desiredKey: requestId, ambiguous: false };
}

function jsonSnapshot(value) {
  if (!isObject(value)) return null;
  try {
    const parsed = JSON.parse(JSON.stringify(value));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]),
  );
}

function sameJsonSnapshot(left, right) {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}

function conversationContextReference(value) {
  const snapshot = jsonSnapshot(value);
  if (
    snapshot?.schema !== CONVERSATION_CONTEXT_SCHEMA_V1
    || !validStructuredAscii(snapshot?.snapshotId, 128)
    || isObject(snapshot?.conversation)
  ) return null;
  return snapshot;
}

function conversationContextConflict(previous, incoming) {
  const previousSnapshotId = text(previous?.snapshotId, null);
  const incomingSnapshotId = text(incoming?.snapshotId, null);
  if (previousSnapshotId && incomingSnapshotId && previousSnapshotId !== incomingSnapshotId) {
    return 'conversation_context_snapshot_id_mismatch';
  }
  return sameJsonSnapshot(previous, incoming)
    ? ''
    : 'conversation_context_snapshot_content_mismatch';
}

function resolveEpisodeScope(previous, input) {
  const previousContext = jsonSnapshot(previous.conversationContext);
  const previousConversationKey = text(previous.conversationKey, '');
  const previousConversationScope = conversationKeyScope(previousConversationKey);
  const conversationKeyWorldId = previousConversationScope.worldId;
  const previousMode = text(
    previousContext?.conversation?.mode,
    previousConversationScope.mode || null,
  );
  const previousWorldId = text(
    previous.worldId,
    previousMode === 'world'
      ? text(previousContext?.conversation?.worldId, text(conversationKeyWorldId, null))
      : null,
  );
  const incomingWorldId = text(input.worldId, null);
  const incomingConversationScope = conversationKeyScope(input.conversationKey);
  const incomingMode = incomingConversationScope.mode || (incomingWorldId ? 'world' : '');
  const lockedMode = previousMode || (previousWorldId ? 'world' : '');
  const previousTargetAgentId = text(previous.targetAgentId, null);
  const incomingTargetAgentId = text(input.targetAgentId, null);
  const previousPeerAgentId = text(previous.peerAgentId, null);
  const incomingPeerAgentId = text(input.fromAgentId, null);
  const worldScopeLocked = Boolean(previousWorldId) || ['direct', 'world'].includes(previousMode);
  const mismatched = (
    (lockedMode && incomingMode && lockedMode !== incomingMode)
    || (worldScopeLocked && incomingWorldId && incomingWorldId !== previousWorldId)
    || (previousTargetAgentId && incomingTargetAgentId && incomingTargetAgentId !== previousTargetAgentId)
    || (previousPeerAgentId && incomingPeerAgentId && incomingPeerAgentId !== previousPeerAgentId)
  );
  return {
    worldId: worldScopeLocked ? previousWorldId : incomingWorldId,
    targetAgentId: previousTargetAgentId || incomingTargetAgentId,
    peerAgentId: previousPeerAgentId || incomingPeerAgentId,
    error: mismatched ? 'episode_scope_mismatch' : '',
  };
}

function conversationKeyScope(value) {
  const conversationKey = text(value, '');
  if (!conversationKey) return { mode: '', worldId: null };
  const worldId = /(?:^|:)world:([^:]+)$/iu.exec(conversationKey)?.[1] || null;
  if (worldId) return { mode: 'world', worldId };
  if (/:direct$/iu.test(conversationKey)) {
    return { mode: 'direct', worldId: null };
  }
  return { mode: '', worldId: null };
}

function normalizedRequestDirection(value) {
  const direction = text(value, '')?.toLowerCase() || '';
  return ['inbound', 'outbound'].includes(direction) ? direction : '';
}

function normalizedInitiatedBy(value) {
  const initiatedBy = text(value, '')?.toLowerCase() || '';
  return ['local', 'peer'].includes(initiatedBy) ? initiatedBy : '';
}

function conversationContextSnapshot(value) {
  const snapshot = jsonSnapshot(value);
  return snapshot?.schema === CONVERSATION_CONTEXT_SCHEMA_V1 ? snapshot : null;
}

const CONVERSATION_CONTEXT_SLOT_STATES = new Set([
  'available',
  'not_set',
  'not_visible',
  'not_applicable',
  'not_found',
  'source_error',
]);

function validConversationContextTimestamp(value) {
  if (typeof value !== 'string') return false;
  const timestamp = text(value, null);
  return Boolean(
    timestamp
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/u.test(timestamp)
    && !Number.isNaN(Date.parse(timestamp)),
  );
}

function validStructuredAscii(value, maxLength) {
  if (typeof value !== 'string') return false;
  const normalized = text(value, null);
  return Boolean(
    normalized
    && [...normalized].length <= maxLength
    && /^[\x20-\x7E]+$/u.test(normalized),
  );
}

function validStructuredPublicIdentity(value) {
  if (!isObject(value)) return false;
  if (typeof value.displayName !== 'string' || typeof value.agentCode !== 'string') return false;
  const displayName = text(value.displayName, null);
  const agentCode = text(value.agentCode, null);
  return Boolean(
    displayName
    && [...displayName].length <= 80
    && agentCode
    && /^[\x20-\x7E]{1,32}$/u.test(agentCode),
  );
}

function validConversationContextSlot(value) {
  if (!isObject(value)) return false;
  if (typeof value.state !== 'string') return false;
  const state = value.state;
  if (!CONVERSATION_CONTEXT_SLOT_STATES.has(state)) return false;
  if (state !== 'available') return value.value === null;
  return Boolean(
    isObject(value.value)
    && typeof value.value.format === 'string'
    && value.value.format === 'plain_text'
    && typeof value.value.text === 'string'
    && text(value.value.text, null),
  );
}

function scopedConversationContextSnapshot(value, {
  chatRequestId,
  worldId,
  targetAgentId,
  peerAgentId,
} = {}) {
  if (value == null) return { snapshot: null, error: '' };
  if (!isObject(value)) return { snapshot: null, error: 'snapshot_contract_invalid' };
  const snapshot = jsonSnapshot(value);
  if (!snapshot) return { snapshot: null, error: 'snapshot_contract_invalid' };
  if (snapshot.schema !== CONVERSATION_CONTEXT_SCHEMA_V1) {
    return { snapshot: null, error: 'unsupported_conversation_context_schema' };
  }
  const conversation = isObject(snapshot.conversation) ? snapshot.conversation : {};
  const expectedRequestId = text(chatRequestId, null);
  const snapshotRequestId = typeof conversation.chatRequestId === 'string'
    ? text(conversation.chatRequestId, null)
    : null;
  const expectedWorldId = text(worldId, null);
  const snapshotWorldId = typeof conversation.worldId === 'string'
    ? text(conversation.worldId, null)
    : null;
  const worldObjectId = typeof snapshot.world?.worldId === 'string'
    ? text(snapshot.world.worldId, null)
    : null;
  const expectedLocalAgentId = text(targetAgentId, null);
  const expectedPeerAgentId = text(peerAgentId, null);
  const snapshotLocalAgentId = typeof snapshot.local?.agentId === 'string'
    ? text(snapshot.local.agentId, null)
    : null;
  const snapshotPeerAgentId = typeof snapshot.peer?.agentId === 'string'
    ? text(snapshot.peer.agentId, null)
    : null;
  const mode = typeof conversation.mode === 'string' ? conversation.mode : null;
  const initiatedBy = typeof conversation.initiatedBy === 'string'
    ? conversation.initiatedBy
    : null;
  const peerProfiles = isObject(snapshot.peer?.profiles) ? snapshot.peer.profiles : {};
  if (
    !isObject(snapshot.conversation)
    || !isObject(snapshot.local)
    || !isObject(snapshot.peer)
    || !isObject(snapshot.peer?.profiles)
    || !validStructuredAscii(snapshot.snapshotId, 128)
    || !validConversationContextTimestamp(snapshot.capturedAt)
    || !validStructuredAscii(conversation.chatRequestId, 128)
    || !['direct', 'world'].includes(mode)
    || !['local', 'peer'].includes(initiatedBy)
    || !validStructuredAscii(snapshot.local.agentId, 128)
    || !validStructuredAscii(snapshot.peer.agentId, 128)
    || !validStructuredPublicIdentity(snapshot.local.publicIdentity)
    || !validStructuredPublicIdentity(snapshot.peer.publicIdentity)
    || !validConversationContextSlot(peerProfiles.agent)
    || !validConversationContextSlot(peerProfiles.human)
    || !validConversationContextSlot(peerProfiles.worldAgent)
    || !validConversationContextSlot(snapshot.worldIdentity)
    || peerProfiles.agent.state === 'not_applicable'
    || peerProfiles.human.state === 'not_applicable'
    || (
      mode === 'direct'
      && (
        !Object.prototype.hasOwnProperty.call(conversation, 'worldId')
        || conversation.worldId !== null
        || snapshot.world !== null
        || peerProfiles.worldAgent.state !== 'not_applicable'
        || snapshot.worldIdentity.state !== 'not_applicable'
      )
    )
    || (
      mode === 'world'
      && (
        !validStructuredAscii(conversation.worldId, 128)
        || !isObject(snapshot.world)
        || !validStructuredAscii(snapshot.world.worldId, 128)
        || typeof snapshot.world.displayName !== 'string'
        || !text(snapshot.world.displayName, null)
        || peerProfiles.worldAgent.state === 'not_applicable'
        || snapshot.worldIdentity.state === 'not_applicable'
      )
    )
  ) {
    return { snapshot: null, error: 'snapshot_contract_invalid' };
  }
  if (
    !expectedRequestId
    || !snapshotRequestId
    || expectedRequestId !== snapshotRequestId
    || (expectedLocalAgentId && snapshotLocalAgentId !== expectedLocalAgentId)
    || (expectedPeerAgentId && snapshotPeerAgentId !== expectedPeerAgentId)
    || (mode === 'world' && snapshotWorldId !== expectedWorldId)
    || (mode === 'world' && worldObjectId !== snapshotWorldId)
    || (mode === 'direct' && (snapshotWorldId || expectedWorldId || worldObjectId))
  ) {
    return { snapshot: null, error: 'snapshot_scope_mismatch' };
  }
  if (
    !expectedLocalAgentId
    || !expectedPeerAgentId
    || (mode === 'world' && !expectedWorldId)
  ) {
    return { snapshot: null, error: 'snapshot_contract_invalid' };
  }
  return { snapshot, error: '' };
}

function requestDirectionFromConversationContext(value) {
  const snapshot = conversationContextSnapshot(value);
  return {
    peer: 'inbound',
    local: 'outbound',
  }[normalizedInitiatedBy(snapshot?.conversation?.initiatedBy)] || '';
}

function conversationDirectionCandidates(payload) {
  if (!isObject(payload)) return [];
  const candidates = [payload];
  for (const key of ['chats', 'items', 'pendingRequests', 'recentRequests']) {
    if (Array.isArray(payload[key])) {
      candidates.push(...payload[key].filter(isObject));
    }
  }
  for (const key of ['chat', 'chatRequest', 'request']) {
    if (isObject(payload[key])) candidates.push(payload[key]);
  }
  return candidates;
}

export function extractClaworldConversationDirections(payload) {
  const directions = {};
  for (const candidate of conversationDirectionCandidates(payload)) {
    const chatRequestId = text(candidate.chatRequestId, text(candidate.requestId, null));
    const direction = normalizedRequestDirection(candidate.direction);
    if (chatRequestId && direction) directions[chatRequestId] = direction;
  }
  return directions;
}

export async function recordClaworldTranscriptDirection(workspaceRoot, chatRequestId, direction, view = {}) {
  const requestId = text(chatRequestId, null);
  const normalizedDirection = normalizedRequestDirection(direction);
  if (!workspaceRoot || !requestId || !normalizedDirection) {
    return { ok: false, updated: false, reason: 'invalid_request_direction' };
  }
  return withClaworldSessionDirectoryWriteLock(workspaceRoot, async () => {
    const index = await readSessionIndex(workspaceRoot);
    const record = resolveEpisodeRecord(index, requestId, view, { create: true });
    if (record.ambiguous || !record.key) {
      return { ok: false, updated: false, reason: 'ambiguous_episode_view', chatRequestId: requestId };
    }
    const previous = isObject(record.entry) ? record.entry : {};
    const previousDirection = normalizedRequestDirection(previous.requestDirection);
    if (previousDirection && previousDirection !== normalizedDirection) {
      const now = isoNow();
      const episodeKey = record.migrate ? record.desiredKey : record.key;
      index.conversationEpisodes[episodeKey] = compactObject({
        ...previous,
        chatRequestId: text(previous.chatRequestId, requestId),
        accountId: text(previous.accountId, view.accountId),
        relayAgentId: text(previous.relayAgentId, text(view.relayAgentId, view.targetAgentId)),
        requestDirectionError: 'backend_direction_conflict',
        updatedAt: now,
      });
      if (record.migrate && record.key !== episodeKey) delete index.conversationEpisodes[record.key];
      index.updatedAt = now;
      await atomicWriteJson(sessionIndexPath(workspaceRoot), index);
      return {
        ok: false,
        updated: true,
        reason: 'request_direction_conflict',
        chatRequestId: requestId,
        direction: previousDirection,
      };
    }
    if (
      previousDirection === normalizedDirection
      && text(previous.requestDirectionSource, null) === 'backend'
      && !record.migrate
      && (!text(view.accountId, null) || text(previous.accountId, null) === text(view.accountId, null))
    ) {
      return { ok: true, updated: false, chatRequestId: requestId, direction: normalizedDirection };
    }
    const now = isoNow();
    const episodeKey = record.migrate ? record.desiredKey : record.key;
    index.conversationEpisodes[episodeKey] = compactObject({
      ...previous,
      chatRequestId: text(previous.chatRequestId, requestId),
      accountId: text(previous.accountId, view.accountId),
      relayAgentId: text(previous.relayAgentId, text(view.relayAgentId, view.targetAgentId)),
      requestDirection: normalizedDirection,
      requestDirectionSource: 'backend',
      requestDirectionError: null,
      updatedAt: now,
    });
    if (record.migrate && record.key !== episodeKey) delete index.conversationEpisodes[record.key];
    index.updatedAt = now;
    await atomicWriteJson(sessionIndexPath(workspaceRoot), index);
    return { ok: true, updated: true, chatRequestId: requestId, direction: normalizedDirection };
  });
}

export async function cacheClaworldConversationDirections(workspaceRoot, payload, view = {}) {
  const directions = extractClaworldConversationDirections(payload);
  const entries = Object.entries(directions);
  if (!workspaceRoot || !entries.length) return directions;
  try {
    await withClaworldSessionDirectoryWriteLock(workspaceRoot, async () => {
      const index = await readSessionIndex(workspaceRoot);
      const now = isoNow();
      let updated = false;
      for (const [chatRequestId, direction] of entries) {
        const record = resolveEpisodeRecord(index, chatRequestId, view, { create: true });
        if (record.ambiguous || !record.key) continue;
        const previous = isObject(record.entry) ? record.entry : {};
        const previousDirection = normalizedRequestDirection(previous.requestDirection);
        if (previousDirection && previousDirection !== direction) {
          const episodeKey = record.migrate ? record.desiredKey : record.key;
          index.conversationEpisodes[episodeKey] = compactObject({
            ...previous,
            chatRequestId: text(previous.chatRequestId, chatRequestId),
            accountId: text(previous.accountId, view.accountId),
            relayAgentId: text(previous.relayAgentId, text(view.relayAgentId, view.targetAgentId)),
            requestDirectionError: 'backend_direction_conflict',
            updatedAt: now,
          });
          if (record.migrate && record.key !== episodeKey) delete index.conversationEpisodes[record.key];
          updated = true;
          continue;
        }
        if (
          previousDirection === direction
          && text(previous.requestDirectionSource, null) === 'backend'
          && !record.migrate
          && (!text(view.accountId, null) || text(previous.accountId, null) === text(view.accountId, null))
        ) continue;
        const episodeKey = record.migrate ? record.desiredKey : record.key;
        index.conversationEpisodes[episodeKey] = compactObject({
          ...previous,
          chatRequestId: text(previous.chatRequestId, chatRequestId),
          accountId: text(previous.accountId, view.accountId),
          relayAgentId: text(previous.relayAgentId, text(view.relayAgentId, view.targetAgentId)),
          requestDirection: direction,
          requestDirectionSource: 'backend',
          requestDirectionError: null,
          updatedAt: now,
        });
        if (record.migrate && record.key !== episodeKey) delete index.conversationEpisodes[record.key];
        updated = true;
      }
      if (updated) {
        index.updatedAt = now;
        await atomicWriteJson(sessionIndexPath(workspaceRoot), index);
      }
    });
  } catch {
    // Backend results remain usable when the local transcript cache is unavailable.
  }
  return directions;
}

function appendUniqueDelivery(deliveries, delivery) {
  const deliveryId = text(delivery?.deliveryId, null);
  if (!deliveryId || (!text(delivery?.commandText, null) && !text(delivery?.contextText, null))) return deliveries;
  const next = Array.isArray(deliveries) ? [...deliveries] : [];
  const existingIndex = next.findIndex((item) => text(item?.deliveryId, null) === deliveryId);
  if (existingIndex >= 0) {
    next[existingIndex] = compactObject({ ...next[existingIndex], ...delivery });
  } else {
    next.push(compactObject(delivery));
  }
  return next;
}

export async function recordClaworldTranscriptEpisode(workspaceRoot, input = {}) {
  const chatRequestId = text(input.chatRequestId, null);
  const deliveryId = text(input.deliveryId, null);
  const commandText = text(input.commandText, null);
  const contextText = text(input.contextText, null);
  if (!workspaceRoot || !chatRequestId || !deliveryId || (!commandText && !contextText)) {
    return { ok: false, updated: false, reason: 'missing_transcript_identity' };
  }
  const inputRelayAgentId = text(input.relayAgentId, null);
  const inputTargetAgentId = text(input.targetAgentId, null);
  if (inputRelayAgentId && inputTargetAgentId && inputRelayAgentId !== inputTargetAgentId) {
    return { ok: false, updated: false, reason: 'episode_view_mismatch', chatRequestId };
  }
  const incomingConversationScope = conversationKeyScope(input.conversationKey);
  const incomingWorldId = text(input.worldId, null);
  if (
    (incomingConversationScope.mode === 'direct' && incomingWorldId)
    || (
      incomingConversationScope.mode === 'world'
      && (!incomingWorldId || incomingConversationScope.worldId !== incomingWorldId)
    )
  ) {
    return { ok: false, updated: false, reason: 'episode_scope_mismatch', chatRequestId };
  }
  const explicitRequestDirection = normalizedRequestDirection(input.requestDirection);

  return withClaworldSessionDirectoryWriteLock(workspaceRoot, async () => {
    const index = await readSessionIndex(workspaceRoot);
    const record = resolveEpisodeRecord(index, chatRequestId, {
      accountId: input.accountId,
      relayAgentId: input.relayAgentId,
      targetAgentId: input.targetAgentId,
    }, { create: true });
    if (record.ambiguous || !record.key) {
      return { ok: false, updated: false, reason: 'ambiguous_episode_view', chatRequestId };
    }
    const previous = isObject(record.entry) ? record.entry : {};
    const episodeScope = resolveEpisodeScope(previous, input);
    const stableFieldConflict = (
      episodeScope.error
      || (
        text(previous.conversationKey, null)
        && text(input.conversationKey, null)
        && text(previous.conversationKey, null) !== text(input.conversationKey, null)
      )
      || (
        text(previous.relayAgentId, null)
        && text(input.relayAgentId, null)
        && text(previous.relayAgentId, null) !== text(input.relayAgentId, null)
      )
    );
    if (stableFieldConflict) {
      return {
        ok: false,
        updated: false,
        reason: episodeScope.error || 'episode_view_mismatch',
        chatRequestId,
      };
    }
    let deliveries = appendUniqueDelivery(previous.deliveries, {
      deliveryId,
      direction: 'inbound',
      fromAgentId: text(input.fromAgentId, null),
      fromAgentCode: text(input.fromAgentCode, null),
      fromDisplayIdentity: text(input.fromDisplayIdentity, null),
      deliveryType: text(input.deliveryType, null),
      worldId: text(input.worldId, null),
      commandText,
      contextText,
      untrustedContext: text(input.untrustedContext, null),
      createdAt: text(input.createdAt, null),
      turnCreatedAt: text(input.turnCreatedAt, null),
    });
    const replyText = text(input.replyText, null);
    if (replyText) {
      deliveries = appendUniqueDelivery(deliveries, {
        deliveryId: `${deliveryId}:reply`,
        direction: 'outbound',
        deliveryType: 'reply',
        fromAgentId: text(input.localAgentId, null),
        commandText: replyText,
        createdAt: text(input.replyCreatedAt, isoNow()),
        turnCreatedAt: text(input.replyCreatedAt, isoNow()),
      });
    }

    const now = isoNow();
    const deliveryIds = deliveries.map((entry) => text(entry?.deliveryId, null)).filter(Boolean);
    const episodeWorldId = episodeScope.worldId;
    const episodeTargetAgentId = episodeScope.targetAgentId;
    const episodePeerAgentId = episodeScope.peerAgentId;
    const previousContextResolution = scopedConversationContextSnapshot(previous.conversationContext, {
      chatRequestId,
      worldId: episodeWorldId,
      targetAgentId: episodeTargetAgentId,
      peerAgentId: episodePeerAgentId,
    });
    const previousStructuredContext = previousContextResolution.snapshot;
    const incomingReference = conversationContextReference(input.conversationContext);
    const contextResolution = incomingReference
      ? { snapshot: null, error: '' }
      : scopedConversationContextSnapshot(input.conversationContext, {
          chatRequestId,
          worldId: episodeWorldId,
          targetAgentId: episodeTargetAgentId,
          peerAgentId: episodePeerAgentId,
        });
    const structuredContext = contextResolution.snapshot;
    let conversationContextUpdateError = '';
    let episodeStructuredContext = previousStructuredContext || structuredContext;
    if (previousStructuredContext && structuredContext) {
      conversationContextUpdateError = conversationContextConflict(previousStructuredContext, structuredContext);
      episodeStructuredContext = previousStructuredContext;
    } else if (previousStructuredContext && incomingReference) {
      const expectedSnapshotId = text(previousStructuredContext.snapshotId, null);
      if (!expectedSnapshotId || text(incomingReference.snapshotId, null) !== expectedSnapshotId) {
        conversationContextUpdateError = 'conversation_context_snapshot_id_mismatch';
      }
      episodeStructuredContext = previousStructuredContext;
    } else if (!previousStructuredContext && incomingReference) {
      conversationContextUpdateError = 'conversation_context_snapshot_reference_unresolved';
      episodeStructuredContext = null;
    } else if (previousStructuredContext && contextResolution.error) {
      conversationContextUpdateError = contextResolution.error;
      episodeStructuredContext = previousStructuredContext;
    }
    const conversationContextError = episodeStructuredContext
      ? ''
      : contextResolution.error
        || previousContextResolution.error
        || conversationContextUpdateError
        || text(previous.conversationContextError, '');
    const structuredRequestDirection = requestDirectionFromConversationContext(episodeStructuredContext);
    const previousRequestDirection = previousContextResolution.error
      && text(previous.requestDirectionSource, null) !== 'backend'
      ? ''
      : normalizedRequestDirection(previous.requestDirection);
    const previousRequestDirectionSource = text(previous.requestDirectionSource, null);
    const requestDirection = explicitRequestDirection
      || (previousRequestDirectionSource === 'backend' ? previousRequestDirection : '')
      || structuredRequestDirection
      || previousRequestDirection;
    const requestDirectionSource = explicitRequestDirection
      ? 'explicit'
      : previousRequestDirectionSource === 'backend' && previousRequestDirection
        ? 'backend'
        : structuredRequestDirection
          ? 'structuredV1'
          : previousRequestDirectionSource;
    const episodeKey = record.migrate ? record.desiredKey : record.key;
    index.conversationEpisodes[episodeKey] = compactObject({
      ...previous,
      chatRequestId,
      chatId: text(input.chatId, previous.chatId),
      lastActiveSessionKey: text(input.localSessionKey, previous.lastActiveSessionKey),
      relaySessionKey: text(input.relaySessionKey, previous.relaySessionKey),
      conversationKey: text(previous.conversationKey, input.conversationKey),
      accountId: text(previous.accountId, input.accountId),
      relayAgentId: text(previous.relayAgentId, input.relayAgentId),
      worldId: episodeWorldId,
      targetAgentId: episodeTargetAgentId,
      peerAgentId: episodePeerAgentId,
      fromAgentCode: text(input.fromAgentCode, previous.fromAgentCode),
      fromDisplayIdentity: text(input.fromDisplayIdentity, previous.fromDisplayIdentity),
      requestDirection,
      requestDirectionSource,
      conversationContext: episodeStructuredContext,
      conversationContextError,
      conversationContextUpdateError: conversationContextUpdateError
        || text(previous.conversationContextUpdateError, ''),
      episodeScopeError: episodeScope.error || text(previous.episodeScopeError, ''),
      firstSeenAt: text(previous.firstSeenAt, text(input.createdAt, now)),
      lastSeenAt: replyText
        ? text(input.replyCreatedAt, now)
        : text(input.turnCreatedAt, text(input.createdAt, now)),
      deliveryIds,
      deliveryCount: deliveryIds.length,
      deliveries,
      updatedAt: now,
    });
    if (record.migrate && record.key !== episodeKey) delete index.conversationEpisodes[record.key];
    index.updatedAt = now;
    await atomicWriteJson(sessionIndexPath(workspaceRoot), index);
    return compactObject({
      ok: true,
      updated: true,
      chatRequestId,
      deliveryCount: deliveryIds.length,
      conversationContextError,
      conversationContextUpdateError,
      episodeScopeError: episodeScope.error,
    });
  });
}

function stripOperationalSuffix(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  while (lines.length) {
    const lastLine = String(lines.at(-1) ?? '').trim();
    if (!lastLine) {
      lines.pop();
      continue;
    }
    if (!OPERATIONAL_SUFFIX_PATTERNS.some((pattern) => pattern.test(lastLine))) break;
    lines.pop();
  }
  return lines.join('\n').trim();
}

function classifyReplyContent(content) {
  const rawText = String(content ?? '');
  const normalized = stripOperationalSuffix(rawText);
  if (!normalized) return { text: '', silenceReason: rawText.trim() ? 'operational_notice_only' : 'empty_reply' };
  if (normalized === 'NO_REPLY') return { text: '', silenceReason: 'no_reply' };
  if (RUNTIME_ERROR_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { text: '', silenceReason: 'runtime_failed_before_reply' };
  }
  if (OPERATIONAL_NOTICE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { text: '', silenceReason: 'operational_notice_only' };
  }
  return { text: normalized, silenceReason: null };
}

function renderableTranscriptDelivery(delivery) {
  if (!isObject(delivery) || text(delivery.deliveryType, null) === 'kickoff') return false;
  const commandText = text(delivery.commandText, null);
  return Boolean(commandText && !classifyReplyContent(commandText).silenceReason);
}

function episodeSummary(chatRequestId, entry) {
  const deliveries = Array.isArray(entry.deliveries) ? entry.deliveries : [];
  const renderable = deliveries.filter(renderableTranscriptDelivery);
  const peerMessages = renderable.filter((delivery) => text(delivery.direction, null) !== 'outbound').length;
  return compactObject({
    chatRequestId: text(entry.chatRequestId, chatRequestId),
    chatId: entry.chatId,
    conversationKey: entry.conversationKey,
    relaySessionKey: entry.relaySessionKey,
    lastActiveSessionKey: entry.lastActiveSessionKey,
    accountId: entry.accountId,
    relayAgentId: entry.relayAgentId,
    worldId: entry.worldId,
    targetAgentId: entry.targetAgentId,
    peerAgentId: entry.peerAgentId,
    fromAgentCode: entry.fromAgentCode,
    fromDisplayIdentity: entry.fromDisplayIdentity,
    requestDirection: normalizedRequestDirection(entry.requestDirection),
    requestDirectionSource: entry.requestDirectionSource,
    requestDirectionError: entry.requestDirectionError,
    conversationContextError: entry.conversationContextError,
    conversationContextUpdateError: entry.conversationContextUpdateError,
    episodeScopeError: entry.episodeScopeError,
    firstSeenAt: entry.firstSeenAt,
    lastSeenAt: entry.lastSeenAt,
    deliveryCount: entry.deliveryCount,
    renderableMessages: renderable.length,
    peerMessages,
    localMessages: renderable.length - peerMessages,
  });
}

function episodeVisibleMessages(entry) {
  const deliveries = Array.isArray(entry?.deliveries) ? entry.deliveries : [];
  return deliveries.flatMap((delivery) => {
    if (!renderableTranscriptDelivery(delivery)) return [];
    const classification = classifyReplyContent(text(delivery.commandText, ''));
    if (classification.silenceReason) return [];
    const visible = extractControlTags(redactText(stripInternalMarkup(classification.text)));
    if (!visible.text) return [];
    return [compactObject({
      from: text(delivery.direction, null) === 'outbound' ? 'local' : 'peer',
      text: visible.text,
      createdAt: text(delivery.turnCreatedAt, text(delivery.createdAt, null)),
      tags: visible.tags,
    })];
  });
}

function episodeDetail(chatRequestId, entry) {
  return {
    ...episodeSummary(chatRequestId, entry),
    messages: episodeVisibleMessages(entry),
  };
}

function localEpisodeSummaries(index, view = {}) {
  const accountId = text(view.accountId, null);
  return Object.entries(isObject(index.conversationEpisodes) ? index.conversationEpisodes : {})
    .filter(([, entry]) => isObject(entry))
    .filter(([, entry]) => {
      if (!accountId) return true;
      const storedAccountId = text(entry.accountId, null);
      if (storedAccountId) return storedAccountId === accountId;
      return episodeMatchesRelayView(entry, view);
    })
    .map(([chatRequestId, entry]) => episodeSummary(chatRequestId, entry))
    .sort((left, right) => String(right.lastSeenAt || right.firstSeenAt || '')
      .localeCompare(String(left.lastSeenAt || left.firstSeenAt || '')));
}

function matchesEpisodeFilters(episode, filters = {}) {
  const checks = {
    chatRequestId: 'chatRequestId',
    conversationKey: 'conversationKey',
    localSessionKey: 'relaySessionKey',
    counterpartyAgentId: 'peerAgentId',
    worldId: 'worldId',
  };
  return Object.entries(checks).every(([filterKey, episodeKey]) => {
    const expected = text(filters[filterKey], null);
    return !expected || text(episode[episodeKey], null) === expected;
  });
}

function filterLocalEpisodes(episodes, filters = {}) {
  return episodes.filter((episode) => matchesEpisodeFilters(episode, filters)).slice(0, 25);
}

function conversationItemFilters(item = {}) {
  const related = isObject(item.relatedObjects) ? item.relatedObjects : {};
  return compactObject({
    chatRequestId: text(item.chatRequestId, text(related.chatRequestId, null)),
    conversationKey: text(item.conversationKey, text(related.conversationKey, null)),
    localSessionKey: text(item.localSessionKey, text(related.localSessionKey, null)),
    counterpartyAgentId: text(item.counterpartyAgentId, text(related.counterpartyAgentId, null)),
    worldId: text(item.worldId, text(related.worldId, null)),
  });
}

export async function augmentConversationPayloadWithLocalTranscriptIndex({
  workspaceRoot,
  payload,
  filters = {},
  accountId = null,
  relayAgentId = null,
} = {}) {
  if (!workspaceRoot || !isObject(payload)) return payload;
  const view = { accountId, relayAgentId };
  await cacheClaworldConversationDirections(workspaceRoot, payload, view);
  const index = await readSessionIndex(workspaceRoot);
  const episodes = localEpisodeSummaries(index, view);
  const matching = filterLocalEpisodes(episodes, filters);
  const result = { ...payload };
  if (matching.length) {
    result.localTranscriptEpisodes = matching;
    result.localTranscriptSummary = {
      episodeCount: matching.length,
      chatRequestIds: matching.map((item) => item.chatRequestId).filter(Boolean),
    };
  }
  const exactChatRequestId = text(filters.chatRequestId, null);
  const exactEntry = exactChatRequestId
    ? resolveEpisodeRecord(index, exactChatRequestId, view).entry
    : null;
  if (exactEntry) {
    result.localTranscriptEpisode = episodeDetail(exactChatRequestId, exactEntry);
  }
  if (Array.isArray(result.items)) {
    result.items = result.items.map((item) => {
      if (!isObject(item)) return item;
      const itemFilters = conversationItemFilters(item);
      if (!Object.keys(itemFilters).length) return item;
      const itemMatches = filterLocalEpisodes(episodes, itemFilters);
      if (!itemMatches.length) return item;
      return {
        ...item,
        localTranscriptEpisodes: itemMatches,
        localTranscriptSummary: {
          episodeCount: itemMatches.length,
          chatRequestIds: itemMatches.map((match) => match.chatRequestId).filter(Boolean),
        },
      };
    });
  }
  return result;
}

function rejectUnknown(name, value, allowed) {
  const extra = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (extra.length) throw new Error(`unsupported ${name} parameter(s): ${extra.join(', ')}`);
}

function normalizeRenderRequest(args = {}) {
  if (!isObject(args)) throw new Error('render arguments must be an object');
  rejectUnknown('transcript render', args, TOP_LEVEL_RENDER_FIELDS);
  const mode = text(args.mode, null);
  if (!['stored', 'manual'].includes(mode)) {
    throw new Error('mode is required and must be one of stored or manual');
  }
  const style = text(args.style, CLAWORLD_TRANSCRIPT_STYLE_NAME);
  if (style !== CLAWORLD_TRANSCRIPT_STYLE_NAME) {
    throw new Error(`unsupported transcript report style: ${style}; expected ${CLAWORLD_TRANSCRIPT_STYLE_NAME}`);
  }
  const renderArgs = { mode, style, maxPageHeight: args.maxPageHeight };
  if (mode === 'stored') {
    if (args.manual != null) throw new Error('manual must not be provided when mode=stored');
    const legacyStored = args.stored == null ? {} : args.stored;
    if (!isObject(legacyStored)) throw new Error('stored must be an object when provided');
    rejectUnknown('stored', legacyStored, STORED_RENDER_FIELDS);
    const flattened = { ...legacyStored, ...args };
    const chatRequestId = text(flattened.chatRequestId, null);
    if (!chatRequestId) throw new Error('chatRequestId is required when mode=stored');
    const accountId = text(flattened.accountId, null);
    validateHeaderRenderFields('stored', flattened);
    for (const key of PUBLIC_HEADER_RENDER_FIELDS) {
      renderArgs[key] = flattened[key];
    }
    return { mode, chatRequestId, accountId, renderArgs };
  }
  if (args.stored != null) throw new Error('stored must not be provided when mode=manual');
  const storedOnly = [...STORED_RENDER_FIELDS].filter((key) => args[key] != null).sort();
  if (storedOnly.length) {
    throw new Error(`${storedOnly.join(', ')} must not be provided at top level when mode=manual`);
  }
  if (!isObject(args.manual)) throw new Error('manual must be an object when mode=manual');
  rejectUnknown('manual', args.manual, MANUAL_RENDER_FIELDS);
  validateHeaderRenderFields('manual', args.manual);
  if (!Array.isArray(args.manual.messages) || !args.manual.messages.length) {
    throw new Error('manual.messages must be a non-empty array when mode=manual');
  }
  args.manual.messages.forEach((message, index) => {
    const position = index + 1;
    if (!isObject(message)) throw new Error(`manual.messages[${position}] must be an object`);
    rejectUnknown(`manual.messages[${position}]`, message, MANUAL_MESSAGE_FIELDS);
    if (!['peer', 'local'].includes(text(message.from, null))) {
      throw new Error(`manual.messages[${position}].from must be peer or local`);
    }
    if (!text(message.text, null)) throw new Error(`manual.messages[${position}].text is required`);
  });
  for (const key of [...PUBLIC_HEADER_RENDER_FIELDS, 'reportType']) {
    renderArgs[key] = args.manual[key];
  }
  return { mode, messages: args.manual.messages, renderArgs };
}

function validateHeaderRenderFields(name, value) {
  const chatMode = text(value.chatMode, null);
  if (chatMode && !['direct', 'world'].includes(chatMode)) {
    throw new Error(`${name}.chatMode must be direct or world`);
  }
  const reportType = text(value.reportType, null);
  if (reportType && !['full', 'excerpt'].includes(reportType)) {
    throw new Error(`${name}.reportType must be full or excerpt`);
  }
  const initiatedBy = text(value.initiatedBy, null);
  if (initiatedBy && !['local', 'peer'].includes(initiatedBy)) {
    throw new Error(`${name}.initiatedBy must be local or peer`);
  }
  if (chatMode === 'direct') {
    if (text(value.worldName, null)) {
      throw new Error(`${name}.worldName must not be provided when chatMode=direct`);
    }
    if (text(value.worldContext, null)) {
      throw new Error(`${name}.worldContext must not be provided when chatMode=direct`);
    }
  }
}

async function loadSourceMessages(request, workspaceRoot, episodeView = {}) {
  if (request.mode === 'manual') {
    return { messages: request.messages, summary: { kind: 'manual', messageCount: request.messages.length } };
  }
  const index = await readSessionIndex(workspaceRoot);
  const record = resolveEpisodeRecord(index, request.chatRequestId, {
    ...episodeView,
    accountId: request.accountId || episodeView.accountId,
  });
  if (record.ambiguous) {
    throw new Error(`chatRequestId matches multiple local Claworld account views; provide accountId: ${request.chatRequestId}`);
  }
  const episode = isObject(record.entry) ? record.entry : null;
  if (!episode) {
    throw new Error(`chatRequestId was not found in local Claworld transcript index: ${request.chatRequestId}`);
  }
  const deliveries = Array.isArray(episode.deliveries) ? episode.deliveries : [];
  if (!deliveries.length) {
    throw new Error(`chatRequestId was found but no deliveries were indexed: ${request.chatRequestId}`);
  }
  const contextResolution = scopedConversationContextSnapshot(episode.conversationContext, {
    chatRequestId: request.chatRequestId,
    worldId: episode.worldId,
    targetAgentId: episode.targetAgentId,
    peerAgentId: episode.peerAgentId,
  });
  const conversationContextError = contextResolution.error
    || (contextResolution.snapshot ? '' : text(episode.conversationContextError, ''));
  const requestDirectionSource = text(episode.requestDirectionSource, null);
  const requestDirection = conversationContextError && requestDirectionSource !== 'backend'
    ? ''
    : normalizedRequestDirection(episode.requestDirection);
  return {
    messages: deliveries,
    conversationContext: contextResolution.snapshot,
    conversationContextError,
    summary: compactObject({
      kind: 'chatRequestId',
      chatRequestId: request.chatRequestId,
      chatId: episode.chatId,
      conversationKey: episode.conversationKey,
      relaySessionKey: episode.relaySessionKey,
      lastActiveSessionKey: episode.lastActiveSessionKey,
      accountId: episode.accountId,
      relayAgentId: episode.relayAgentId,
      worldId: episode.worldId,
      targetAgentId: episode.targetAgentId,
      peerAgentId: episode.peerAgentId,
      fromDisplayIdentity: episode.fromDisplayIdentity,
      requestDirection,
      requestDirectionSource,
      conversationContextError,
      conversationContextUpdateError: episode.conversationContextUpdateError,
      episodeScopeError: episode.episodeScopeError,
      firstSeenAt: episode.firstSeenAt,
      lastSeenAt: episode.lastSeenAt,
      indexSource: 'conversationEpisodes',
    }),
  };
}

function markdownLines(value) {
  const source = String(value ?? '');
  const lines = [];
  for (const match of source.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/gu)) {
    const raw = match[0];
    if (!raw) break;
    const ending = /(?:\r\n|\n|\r)$/u.exec(raw)?.[0] || '';
    lines.push({
      raw,
      body: ending ? raw.slice(0, -ending.length) : raw,
      ending,
      start: match.index,
      end: match.index + raw.length,
    });
  }
  return lines;
}

function markdownFence(value) {
  const match = /^\s*(`{3,}|~{3,})([^\r\n]*)$/u.exec(String(value ?? ''));
  if (!match) return null;
  return { marker: match[1][0], length: match[1].length, suffix: match[2].trim() };
}

function markdownHeadings(value) {
  const headings = [];
  let activeFence = '';
  let activeFenceLength = 0;
  for (const line of markdownLines(value)) {
    const fence = markdownFence(line.body);
    if (fence) {
      if (!activeFence) {
        activeFence = fence.marker;
        activeFenceLength = fence.length;
      } else if (
        fence.marker === activeFence
        && fence.length >= activeFenceLength
        && !fence.suffix
      ) {
        activeFence = '';
        activeFenceLength = 0;
      }
      continue;
    }
    if (activeFence) continue;
    const headingMatch = /^\s*(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line.body);
    if (!headingMatch) continue;
    headings.push({
      level: headingMatch[1].length,
      title: headingMatch[2].trim(),
      start: line.start,
      end: line.end,
    });
  }
  return headings;
}

function markdownOutsideFences(value) {
  const visible = [];
  let activeFence = '';
  let activeFenceLength = 0;
  for (const line of markdownLines(value)) {
    const fence = markdownFence(line.body);
    if (fence) {
      if (!activeFence) {
        activeFence = fence.marker;
        activeFenceLength = fence.length;
      } else if (
        fence.marker === activeFence
        && fence.length >= activeFenceLength
        && !fence.suffix
      ) {
        activeFence = '';
        activeFenceLength = 0;
      }
      visible.push(line.ending);
      continue;
    }
    visible.push(activeFence ? line.ending : line.raw);
  }
  return visible.join('');
}

function markdownSection(value, title, level) {
  const source = String(value ?? '');
  const headings = markdownHeadings(source);
  const targetIndex = headings.findIndex((heading) => (
    heading.level === level && heading.title.toLocaleLowerCase() === String(title).toLocaleLowerCase()
  ));
  if (targetIndex < 0) return '';
  const start = headings[targetIndex].end;
  const next = headings.slice(targetIndex + 1).find((heading) => heading.level <= level);
  return source.slice(start, next?.start ?? source.length).trim();
}

function markdownNamedCodeBlock(value, title, level) {
  const section = markdownSection(value, title, level);
  if (!section) return '';
  const lines = markdownLines(section);
  const openingIndex = lines.findIndex((line) => line.body.trim());
  const opening = openingIndex >= 0 ? markdownFence(lines[openingIndex].body) : null;
  if (opening) {
    const body = [];
    for (let index = openingIndex + 1; index < lines.length; index += 1) {
      const closing = markdownFence(lines[index].body);
      if (
        closing
        && closing.marker === opening.marker
        && closing.length >= opening.length
        && !closing.suffix
      ) {
        const trailing = lines.slice(index + 1).map((line) => line.raw).join('').trim();
        if (!trailing) return body.join('').trim();
        break;
      }
      body.push(lines[index].raw);
    }
  }
  return markdownOutsideFences(section)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .join('\n');
}

function squashWhitespace(value) {
  const lines = String(value ?? '').split(/\r?\n/).map((line) => line.replace(/[ \t]+/gu, ' ').trim());
  const compact = [];
  let blank = false;
  for (const line of lines) {
    if (!line) {
      if (!blank && compact.length) compact.push('');
      blank = true;
    } else {
      compact.push(line);
      blank = false;
    }
  }
  return compact.join('\n').trim();
}

function parseHeaderContextCandidate(value, source) {
  const content = String(value ?? '').trim();
  if (!content) return {};
  const parsed = {};
  const scalarText = markdownOutsideFences(content);
  const modeMatch = /^\s*-\s*Mode:\s*`?([A-Za-z_-]+)`?\s*$/imu.exec(scalarText)
    || /\bconversation[_\s-]*mode\b\s*[:=]\s*`?([A-Za-z_-]+)`?/iu.exec(scalarText);
  const mode = text(modeMatch?.[1]?.toLowerCase(), null);
  if (['world', 'direct'].includes(mode)) parsed.conversationMode = mode;
  const worldMatch = /^\s*-\s*World:\s*([^\n(`]+?)\s*(?:\(`([^`]+)`\))?\s*$/imu.exec(scalarText);
  if (worldMatch) {
    parsed.worldName = text(worldMatch[1], null);
    parsed.worldId = text(worldMatch[2], null);
  }
  const worldSection = markdownSection(content, 'World Facts', 2);
  const worldContext = markdownNamedCodeBlock(worldSection, 'World Context', 3);
  if (worldContext) {
    parsed.worldContext = squashWhitespace(worldContext);
    parsed.worldContextSource = source;
  }
  const localSection = markdownSection(content, 'You', 2);
  const peerSection = markdownSection(content, 'Peer', 2);
  const identity = (section) => text(/^\s*-\s*Identity:\s*`?([^`\n]+)`?\s*$/imu.exec(markdownOutsideFences(section))?.[1], null);
  if (localSection) parsed.localIdentity = identity(localSection);
  if (peerSection) {
    parsed.peerIdentity = identity(peerSection);
    const globalProfile = markdownNamedCodeBlock(peerSection, 'Global Profile', 3);
    const humanProfile = markdownNamedCodeBlock(peerSection, 'Human Profile', 3);
    const worldProfile = markdownNamedCodeBlock(peerSection, 'World Membership Profile', 3);
    if (globalProfile) {
      parsed.globalProfile = squashWhitespace(globalProfile);
      parsed.globalProfileSource = source;
    }
    if (humanProfile) {
      parsed.humanProfile = squashWhitespace(humanProfile);
      parsed.humanProfileSource = source;
    }
    if (worldProfile) {
      parsed.worldProfile = squashWhitespace(worldProfile);
      parsed.worldProfileSource = source;
    }
  }
  if (!localSection && !peerSection && source === 'untrustedContext') {
    const plainProfile = plainProfileCandidate(content);
    if (plainProfile) {
      parsed.globalProfile = plainProfile;
      parsed.globalProfileSource = source;
    }
  }
  return compactObject(parsed);
}

function plainProfileCandidate(value) {
  const candidate = squashWhitespace(markdownOutsideFences(value));
  if (!candidate || candidate.includes('# ')) return '';
  return displayCols(candidate) <= 420 ? candidate : '';
}

function headerProfileSourcePriority(source) {
  return { structuredV1: 5, rawKickoffText: 4, contextText: 3, untrustedContext: 2, transcript: 1 }[source] || 0;
}

function mergeHeaderContextCandidate(merged, sources, candidate, source) {
  if (!candidate) return;
  const parsed = parseHeaderContextCandidate(candidate, source);
  for (const [key, value] of Object.entries(parsed)) {
    if (
      source === 'untrustedContext'
      && !['globalProfile', 'globalProfileSource', 'humanProfile', 'humanProfileSource'].includes(key)
    ) continue;
    if (!text(value, null)) continue;
    const sourceKey = {
      globalProfile: 'globalProfileSource',
      humanProfile: 'humanProfileSource',
      worldProfile: 'worldProfileSource',
      worldContext: 'worldContextSource',
      globalProfileSource: 'globalProfileSource',
      humanProfileSource: 'humanProfileSource',
      worldProfileSource: 'worldProfileSource',
      worldContextSource: 'worldContextSource',
    }[key];
    const incomingSource = key.endsWith('Source') ? value : parsed[sourceKey] || source;
    const field = key.endsWith('Source') ? sourceKey : key;
    if (headerProfileSourcePriority(incomingSource) >= headerProfileSourcePriority(sources[field])) {
      merged[key] = value;
      sources[field] = incomingSource;
    }
  }
}

function structuredProfileText(slot) {
  if (!isObject(slot) || text(slot.state, null) !== 'available' || !isObject(slot.value)) return '';
  if (text(slot.value.format, null) !== 'plain_text') return '';
  return text(slot.value.text, '') || '';
}

function structuredPublicIdentity(slot) {
  if (!isObject(slot)) return '';
  const displayName = text(slot.displayName, '') || '';
  const agentCode = text(slot.agentCode, '') || '';
  if (!displayName) return '';
  if (!agentCode) return displayName;
  return `${displayName}#${agentCode}`;
}

function extractStructuredHeaderContext(value, sourceSummary = {}) {
  const contextResolution = scopedConversationContextSnapshot(value, {
    chatRequestId: sourceSummary.chatRequestId,
    worldId: sourceSummary.worldId,
    targetAgentId: sourceSummary.targetAgentId,
    peerAgentId: sourceSummary.peerAgentId,
  });
  if (!contextResolution.snapshot) {
    return contextResolution.error
      ? { structuredContext: true, structuredContextError: contextResolution.error }
      : null;
  }
  const snapshot = contextResolution.snapshot;
  const conversation = isObject(snapshot.conversation) ? snapshot.conversation : {};
  const snapshotWorldId = text(conversation.worldId, null);
  const conversationMode = ['direct', 'world'].includes(text(conversation.mode, null))
    ? text(conversation.mode, null)
    : '';
  const initiatedBy = normalizedInitiatedBy(conversation.initiatedBy);
  const peerProfiles = isObject(snapshot.peer?.profiles) ? snapshot.peer.profiles : {};
  const globalProfile = structuredProfileText(peerProfiles.agent);
  const humanProfile = structuredProfileText(peerProfiles.human);
  const worldProfile = structuredProfileText(peerProfiles.worldAgent);
  const worldContext = structuredProfileText(snapshot.worldIdentity);
  const peerProfile = conversationMode === 'world' ? worldProfile : conversationMode === 'direct' ? globalProfile : '';
  return compactObject({
    structuredContext: true,
    conversationMode,
    initiatedBy,
    worldName: conversationMode === 'world' ? text(snapshot.world?.displayName, '') || '' : '',
    worldId: conversationMode === 'world' ? snapshotWorldId : '',
    localIdentity: structuredPublicIdentity(snapshot.local?.publicIdentity),
    peerIdentity: structuredPublicIdentity(snapshot.peer?.publicIdentity),
    peerGlobalProfile: globalProfile,
    peerGlobalProfileState: text(peerProfiles.agent?.state, 'missing'),
    peerGlobalProfileSource: globalProfile ? 'structuredV1' : '',
    peerHumanProfile: humanProfile,
    peerHumanProfileState: text(peerProfiles.human?.state, 'missing'),
    peerHumanProfileSource: humanProfile ? 'structuredV1' : '',
    peerWorldProfile: worldProfile,
    peerWorldProfileState: text(peerProfiles.worldAgent?.state, 'missing'),
    peerWorldProfileSource: worldProfile ? 'structuredV1' : '',
    worldContext: conversationMode === 'world' ? worldContext : '',
    worldContextState: text(snapshot.worldIdentity?.state, 'missing'),
    worldContextSource: conversationMode === 'world' && worldContext ? 'structuredV1' : '',
    peerProfile,
    profileSource: peerProfile ? 'structuredV1' : '',
  });
}

function extractTranscriptHeaderContext(rawMessages, source = {}) {
  const sourceSummary = isObject(source.summary) ? source.summary : {};
  const structuredSnapshot = conversationContextSnapshot(source.conversationContext)
    || rawMessages.map((raw) => conversationContextSnapshot(raw?.conversationContext)).find(Boolean);
  if (structuredSnapshot) return extractStructuredHeaderContext(structuredSnapshot, sourceSummary);
  const structuredContextError = text(
    source.conversationContextError,
    text(sourceSummary.conversationContextError, null),
  );
  if (structuredContextError) {
    return { structuredContext: true, structuredContextError };
  }

  const merged = {};
  const sources = {};
  let trustedPeerIdentity = publicHeaderValue(sourceSummary.fromDisplayIdentity);
  for (const raw of rawMessages) {
    if (!isObject(raw)) continue;
    mergeHeaderContextCandidate(merged, sources, text(raw.contextText, null), 'contextText');
    mergeHeaderContextCandidate(merged, sources, text(raw.untrustedContext, null), 'untrustedContext');
    if (text(raw.deliveryType, null) === 'kickoff') {
      mergeHeaderContextCandidate(merged, sources, text(raw.commandText, null), 'rawKickoffText');
    }
    const worldId = text(raw.worldId, null);
    if (worldId) {
      if (merged.worldId && merged.worldId !== worldId) {
        delete merged.worldName;
        delete merged.worldContext;
        delete merged.worldProfile;
        merged.legacyContextScopeError = 'legacy_world_scope_mismatch';
      }
      merged.worldId = worldId;
      merged.conversationMode = 'world';
    }
    trustedPeerIdentity ||= publicHeaderValue(raw.fromDisplayIdentity);
  }
  if (text(sourceSummary.worldId, null)) {
    const envelopeWorldId = text(sourceSummary.worldId, null);
    if (merged.worldId && merged.worldId !== envelopeWorldId) {
      delete merged.worldName;
      delete merged.worldContext;
      delete merged.worldProfile;
      merged.legacyContextScopeError = 'legacy_world_scope_mismatch';
    }
    merged.worldId = envelopeWorldId;
    merged.conversationMode = 'world';
  }
  if (conversationKeyScope(sourceSummary.conversationKey).mode === 'direct') {
    if (merged.conversationMode === 'world' || merged.worldId || merged.worldName) {
      merged.legacyContextScopeError = 'legacy_world_scope_mismatch';
    }
    merged.conversationMode = 'direct';
    delete merged.worldId;
    delete merged.worldName;
    delete merged.worldContext;
    delete merged.worldProfile;
  }
  if (trustedPeerIdentity) merged.peerIdentity = trustedPeerIdentity;
  let peerProfile = '';
  let profileSource = '';
  if (merged.conversationMode === 'world') {
    if (merged.worldProfile) {
      peerProfile = merged.worldProfile;
      profileSource = merged.worldProfileSource || 'transcript';
    }
  } else if (merged.conversationMode === 'direct' && merged.globalProfile) {
    peerProfile = merged.globalProfile;
    profileSource = merged.globalProfileSource || 'transcript';
  } else if (merged.worldProfile) {
    peerProfile = merged.worldProfile;
    profileSource = merged.worldProfileSource || 'transcript';
  } else if (merged.globalProfile) {
    peerProfile = merged.globalProfile;
    profileSource = merged.globalProfileSource || 'transcript';
  }
  return compactObject({
    ...merged,
    peerGlobalProfile: merged.globalProfile,
    peerGlobalProfileSource: merged.globalProfileSource,
    peerHumanProfile: merged.humanProfile,
    peerHumanProfileSource: merged.humanProfileSource,
    peerWorldProfile: merged.worldProfile,
    peerWorldProfileSource: merged.worldProfileSource,
    peerProfile,
    profileSource,
  });
}

function formatTimestamp(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value * 1000);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (part) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  const raw = String(value).trim();
  const isoLike = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/u.exec(raw);
  if (isoLike) {
    return `${isoLike[1]}-${isoLike[2]}-${isoLike[3]} ${isoLike[4]}:${isoLike[5]}`;
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseTimeish(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (/^\d+(?:\.\d+)?$/u.test(String(value).trim())) return Number(value);
  const timestamp = Date.parse(String(value).trim());
  return Number.isNaN(timestamp) ? null : timestamp / 1000;
}

function extractControlTags(value) {
  const matches = [];
  const claimed = [];
  const patterns = [
    [/\[\[?\s*request[_\s-]*(?:conversation[_\s-]*)?end\s*\]?\]?/giu, 'request end'],
    [/\[\s*requeset\s+end\s*\]/giu, 'request end'],
    [/\[\[?\s*end\s*\]?\]?/giu, 'request end'],
    [/\[\[?\s*like\s*\]?\]?/giu, 'like'],
    [/\[\[?\s*dislike\s*\]?\]?/giu, 'dislike'],
  ];
  const record = (start, end, label) => {
    if (claimed.some(([claimedStart, claimedEnd]) => start < claimedEnd && end > claimedStart)) return;
    claimed.push([start, end]);
    matches.push([start, end, label]);
  };
  const source = String(value ?? '');
  for (const [pattern, label] of patterns) {
    for (const match of source.matchAll(pattern)) record(match.index, match.index + match[0].length, label);
  }
  for (const match of source.matchAll(/\[\[\s*([A-Za-z0-9][A-Za-z0-9 _-]{0,24})\s*\]\]/gu)) {
    const label = squashWhitespace(match[1].replaceAll('_', ' ').replaceAll('-', ' ')).toLowerCase().slice(0, 24).trim();
    if (label) record(match.index, match.index + match[0].length, label);
  }
  const sorted = matches.sort((left, right) => left[0] - right[0]);
  const tags = [...new Set(sorted.map(([, , label]) => label))];
  let cursor = 0;
  const pieces = [];
  for (const [start, end] of sorted) {
    pieces.push(source.slice(cursor, start));
    cursor = Math.max(cursor, end);
  }
  pieces.push(source.slice(cursor));
  return { text: squashWhitespace(pieces.join('')), tags };
}

function redactText(value) {
  return String(value ?? '')
    .replace(/\b(api[_-]?key|app[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|authorization|bearer)\b\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/\b(?:sk|rk|pk|ghp|glpat)-[A-Za-z0-9_-]{12,}\b/gu, '[redacted-token]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu, '[redacted-email]')
    .replace(/(?<!\d)(?:\+?\d[\d\s().-]{8,}\d)(?!\d)/gu, '[redacted-phone]');
}

function stripInternalMarkup(value) {
  let cleaned = String(value ?? '').replace(/```(?:json|text|markdown)?/giu, '').replaceAll('```', '');
  for (const marker of [
    'Routing metadata:',
    'Claworld live conversation rules:',
    'Backend-authored Claworld context:',
    'Backend-authored Claworld command:',
    'Relay untrusted context:',
  ]) {
    if (cleaned.includes(marker)) cleaned = cleaned.split(marker, 1)[0];
  }
  return squashWhitespace(cleaned);
}

function normalizeMessages(rawMessages, localAgentId, args, headerContext = {}) {
  const stored = text(args.mode, null) === 'stored';
  const validStructuredStored = stored
    && headerContext.structuredContext === true
    && !text(headerContext.structuredContextError, null);
  const trustedLocalIdentity = publicHeaderValue(headerContext.localIdentity);
  const trustedPeerIdentity = publicHeaderValue(headerContext.peerIdentity)
    || publicHeaderValue(headerContext.peerId);
  const explicitLocalIdentity = publicHeaderValue(args.localIdentity)
    || publicHeaderValue(args.localLabel);
  const explicitPeerIdentity = publicHeaderValue(args.peerIdentity)
    || publicHeaderValue(args.peerLabel);
  const localIdentity = validStructuredStored
    ? trustedLocalIdentity
    : stored
      ? trustedLocalIdentity || explicitLocalIdentity
    : explicitLocalIdentity || trustedLocalIdentity;
  const peerIdentity = validStructuredStored
    ? trustedPeerIdentity
    : stored
      ? trustedPeerIdentity || explicitPeerIdentity
    : explicitPeerIdentity || trustedPeerIdentity;
  const localId = text(localIdentity, text(localAgentId, 'local-agent'));
  const peerId = text(peerIdentity, 'peer-agent');
  const localLabel = publicHeaderValue(localIdentity) || 'Me';
  const peerLabel = publicHeaderValue(peerIdentity) || 'Peer';
  const normalized = [];
  rawMessages.forEach((raw, index) => {
    if (!isObject(raw)) return;
    let side;
    let messageText;
    let createdAt;
    let messageId;
    let participantId;
    let participantLabel;
    if (['peer', 'local'].includes(raw.from)) {
      side = raw.from === 'peer' ? 'left' : 'right';
      messageText = text(raw.text, null);
      createdAt = formatTimestamp(raw.createdAt);
      messageId = text(raw.id, `msg-${index + 1}`);
      participantId = side === 'left' ? peerId : localId;
      participantLabel = side === 'left' ? peerLabel : localLabel;
    } else {
      if (text(raw.deliveryType, null) === 'kickoff') return;
      const classification = classifyReplyContent(text(raw.commandText, ''));
      if (classification.silenceReason) return;
      messageText = classification.text;
      createdAt = formatTimestamp(raw.turnCreatedAt || raw.createdAt);
      messageId = text(raw.deliveryId, `msg-${index + 1}`);
      side = text(raw.direction, null) === 'outbound'
        || (!text(raw.direction, null) && text(raw.fromAgentId, null) === text(localAgentId, null))
        ? 'right'
        : 'left';
      participantId = side === 'left' ? peerId : localId;
      participantLabel = side === 'left' ? peerLabel : localLabel;
    }
    if (!messageText) return;
    const extracted = extractControlTags(messageText);
    const cleanedText = omitEmoji(stripInternalMarkup(redactText(extracted.text)));
    if (!cleanedText && !extracted.tags.length) return;
    normalized.push({
      id: messageId,
      side,
      participantId,
      participantLabel,
      text: cleanedText,
      createdAt,
      tags: extracted.tags,
      sourceIndex: index,
    });
  });
  return normalized;
}

function selectionSummary(request, messageCount) {
  return compactObject({
    mode: request.mode,
    chatRequestId: request.mode === 'stored' ? request.chatRequestId : null,
    messageCount,
    omittedBefore: 0,
    omittedAfter: 0,
  });
}

function formatTimeMarker(value) {
  const timestamp = parseTimeish(value);
  if (timestamp != null) {
    const date = new Date(timestamp * 1000);
    if (!Number.isNaN(date.getTime())) {
      const pad = (part) => String(part).padStart(2, '0');
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
  }
  const match = /(?:(\d{4})[-/])?(\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})/u.exec(String(value ?? '').trim());
  return match ? `${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')} ${String(Number(match[4])).padStart(2, '0')}:${match[5]}` : '';
}

function decorateSelection(messages, selection) {
  const items = [];
  let previousTimestamp = null;
  messages.forEach((message, index) => {
    const timestamp = parseTimeish(message.createdAt);
    if (message.createdAt && (index === 0 || (
      previousTimestamp != null && timestamp != null && timestamp - previousTimestamp > TIME_SPLIT_SECONDS
    ))) {
      const label = formatTimeMarker(message.createdAt);
      if (label) items.push({ kind: 'time', label, timestamp: message.createdAt });
    }
    items.push({ kind: 'message', message });
    previousTimestamp = timestamp ?? previousTimestamp;
  });
  if (selection.omittedAfter > 0) {
    items.push({ kind: 'ellipsis', omitted: selection.omittedAfter, label: `${selection.omittedAfter} later messages omitted` });
  }
  return items;
}

function participants(messages) {
  const seen = new Map();
  for (const message of messages) {
    if (!seen.has(message.participantId)) seen.set(message.participantId, message);
  }
  return [...seen.entries()].map(([participantId, message]) => ({
    id: participantId,
    name: message.participantLabel,
    side: message.side,
    avatar: String(message.participantLabel || 'A').replace(/[^A-Za-z0-9]/gu, '').slice(0, 2).toUpperCase() || 'A',
  }));
}

function bubbleMessagePayload(item) {
  if (item.kind === 'time') return { kind: 'time', label: item.label, timestamp: item.timestamp || '' };
  if (item.kind === 'ellipsis') return { kind: 'ellipsis', omitted: item.omitted, label: item.label };
  const { message } = item;
  return {
    id: message.id,
    kind: 'text',
    from: message.participantId,
    side: message.side,
    speaker: message.participantLabel,
    text: message.text,
    createdAt: message.createdAt,
    tags: [...message.tags],
  };
}

function publicHeaderValue(value) {
  const normalized = text(value, '') || '';
  if (
    /(?:^|[^a-z0-9])(?:(?:agt|req|wld|dlv|conversation|management|session|account)[_:-]|(?:agent|world)_)[a-z0-9]/iu
      .test(normalized)
  ) {
    return '';
  }
  return normalized;
}

function trustedStructuredHeaderValue(value) {
  return text(value, '') || '';
}

function displayName(identity) {
  return publicHeaderValue(String(identity || '').split('#', 1)[0]);
}

function semanticHeaderTitle(peerName, worldName) {
  if (peerName && worldName) return `${peerName} — ${worldName}`;
  return peerName || worldName || 'Claworld conversation';
}

function headerText(args, messages, headerContext) {
  const stored = text(args.mode, null) === 'stored';
  const structuredStored = stored
    && headerContext.structuredContext === true
    && !text(headerContext.structuredContextError, null);
  const explicitTitle = publicHeaderValue(args.topic) || publicHeaderValue(args.title);
  const explicitPeerIdentity = publicHeaderValue(args.peerIdentity) || publicHeaderValue(args.peerLabel);
  const trustedValue = structuredStored ? trustedStructuredHeaderValue : publicHeaderValue;
  const trustedPeerIdentity = trustedValue(headerContext.peerIdentity)
    || trustedValue(headerContext.peerId);
  let peerIdentity = structuredStored
    ? trustedPeerIdentity
    : stored
      ? trustedPeerIdentity || explicitPeerIdentity
    : explicitPeerIdentity || trustedPeerIdentity;
  if (!peerIdentity && !structuredStored) {
    peerIdentity = publicHeaderValue(
      messages.find((message) => message.side === 'left')?.participantLabel,
    );
  }
  const peerName = structuredStored
    ? trustedStructuredHeaderValue(String(peerIdentity || '').split('#', 1)[0])
    : displayName(peerIdentity);
  const explicitWorldName = publicHeaderValue(args.worldName);
  const trustedWorldName = trustedValue(headerContext.worldName);
  const worldName = structuredStored
    ? trustedWorldName
    : stored
      ? trustedWorldName || explicitWorldName
    : explicitWorldName || trustedWorldName;
  const title = explicitTitle || semanticHeaderTitle(peerName, worldName);
  const explicitProfile = publicHeaderValue(args.peerProfile);
  const trustedProfile = trustedValue(headerContext.peerProfile);
  if (explicitProfile && !structuredStored && !(stored && trustedProfile)) {
    return { title, subtitle: explicitProfile };
  }
  const profile = trustedProfile;
  const subtitleParts = [peerIdentity, profile].filter(Boolean);
  if (!subtitleParts.length && worldName) subtitleParts.push(worldName);
  return { title, subtitle: subtitleParts.join(' · ') || 'Conversation transcript' };
}

function messageParticipantIdentity(messages, side) {
  return publicHeaderValue(messages.find((message) => message.side === side)?.participantLabel);
}

function transcriptDateLabel(messages, sourceSummary = {}) {
  const candidates = messages.map((message) => message.createdAt).filter(Boolean);
  if (!candidates.length) candidates.push(sourceSummary.firstSeenAt, sourceSummary.lastSeenAt);
  const dates = [];
  for (const candidate of candidates) {
    const match = /\b(\d{4})-(\d{2})-(\d{2})\b/u.exec(String(candidate || ''));
    if (match && !dates.includes(match[0])) dates.push(match[0]);
  }
  if (!dates.length) return '';
  const first = dates[0];
  const last = dates.at(-1);
  if (first === last) return first.slice(5);
  if (first.slice(0, 4) === last.slice(0, 4)) return `${first.slice(5)}–${last.slice(5)}`;
  return `${first}–${last}`;
}

function transcriptHeader(args, messages, headerContext, title, sourceSummary = {}) {
  const stored = text(args.mode, null) === 'stored';
  const structuredStored = stored
    && headerContext.structuredContext === true
    && !text(headerContext.structuredContextError, null);
  const explicitChatMode = text(args.chatMode, '') || '';
  const trustedChatMode = text(headerContext.conversationMode, '') || '';
  const trustedValue = structuredStored ? trustedStructuredHeaderValue : publicHeaderValue;
  const explicitWorldName = publicHeaderValue(args.worldName);
  const trustedWorldName = trustedValue(headerContext.worldName);
  let chatMode = structuredStored
    ? trustedChatMode
    : stored
      ? trustedChatMode || explicitChatMode
      : explicitChatMode || trustedChatMode;
  let worldName = structuredStored
    ? trustedWorldName
    : stored
      ? trustedWorldName || explicitWorldName
      : explicitWorldName || trustedWorldName;
  const explicitWorldContext = publicHeaderValue(args.worldContext);
  const trustedWorldContext = trustedValue(headerContext.worldContext);
  if (!chatMode && (worldName || (!structuredStored && explicitWorldContext) || trustedWorldContext)) chatMode = 'world';
  if (chatMode === 'direct') worldName = '';

  const explicitLocalIdentity = publicHeaderValue(args.localIdentity) || publicHeaderValue(args.localLabel);
  const explicitPeerIdentity = publicHeaderValue(args.peerIdentity) || publicHeaderValue(args.peerLabel);
  const trustedLocalIdentity = trustedValue(headerContext.localIdentity);
  const trustedPeerIdentity = trustedValue(headerContext.peerIdentity) || trustedValue(headerContext.peerId);
  const localIdentity = (
    structuredStored
      ? trustedLocalIdentity
      : stored
        ? trustedLocalIdentity || explicitLocalIdentity
        : explicitLocalIdentity || trustedLocalIdentity
  ) || (structuredStored ? '' : messageParticipantIdentity(messages, 'right')) || 'Me';
  const peerIdentity = (
    structuredStored
      ? trustedPeerIdentity
      : stored
        ? trustedPeerIdentity || explicitPeerIdentity
        : explicitPeerIdentity || trustedPeerIdentity
  ) || (structuredStored ? '' : messageParticipantIdentity(messages, 'left')) || 'Peer';

  const explicitProfile = publicHeaderValue(args.peerProfile);
  const trustedProfile = trustedValue(headerContext.peerProfile);
  const contextText = structuredStored
    ? trustedProfile
    : stored
      ? trustedProfile || explicitProfile
      : explicitProfile || trustedProfile;
  const contextSource = contextText
    ? (stored && trustedProfile
        ? text(headerContext.profileSource, 'rawKickoffText')
        : explicitProfile
          ? 'explicit'
          : text(headerContext.profileSource, 'fallback'))
    : '';
  const worldContext = structuredStored
    ? trustedWorldContext
    : stored
      ? trustedWorldContext || explicitWorldContext
    : explicitWorldContext || trustedWorldContext;
  const worldContextSource = worldContext
    ? (stored && trustedWorldContext
        ? text(headerContext.worldContextSource, 'rawKickoffText')
        : explicitWorldContext
          ? 'explicit'
          : text(headerContext.worldContextSource, 'fallback'))
    : '';

  let contextLabel = '';
  let contextKind = 'profile';
  if (contextText) {
    if (chatMode === 'world') {
      contextKind = 'peerWorldMembershipProfile';
      contextLabel = 'Peer · World';
    } else if (chatMode === 'direct') {
      contextKind = 'peerGlobalProfile';
      contextLabel = 'Peer · Profile';
    } else {
      contextLabel = 'Peer Profile';
    }
  }
  const contextBlocks = [];
  if (stored) {
    const storedBlocks = [
      {
        kind: 'peerGlobalProfile',
        label: 'Agent Profile',
        text: trustedValue(headerContext.peerGlobalProfile),
        source: text(headerContext.peerGlobalProfileSource, structuredStored ? 'structuredV1' : 'rawKickoffText'),
      },
      {
        kind: 'peerHumanProfile',
        label: 'Human Profile',
        text: trustedValue(headerContext.peerHumanProfile),
        source: text(headerContext.peerHumanProfileSource, structuredStored ? 'structuredV1' : 'rawKickoffText'),
      },
    ];
    if (chatMode === 'world') {
      storedBlocks.push(
        {
          kind: 'worldContext',
          label: 'World Context',
          text: worldContext,
          source: worldContextSource,
        },
        {
          kind: 'peerWorldMembershipProfile',
          label: 'World Membership Profile',
          text: trustedValue(headerContext.peerWorldProfile),
          source: text(headerContext.peerWorldProfileSource, structuredStored ? 'structuredV1' : 'rawKickoffText'),
        },
      );
    }
    contextBlocks.push(...storedBlocks.filter((block) => block.text));
  } else {
    if (contextText) {
      contextBlocks.push({ kind: contextKind, label: contextLabel, text: contextText, source: contextSource });
    }
    if (chatMode === 'world' && worldContext) {
      contextBlocks.push({
        kind: 'worldContext',
        label: 'World Context',
        text: worldContext,
        source: worldContextSource,
      });
    }
  }

  const requestDirection = normalizedRequestDirection(sourceSummary.requestDirection);
  const trustedInitiatedBy = {
    inbound: 'peer',
    outbound: 'local',
  }[requestDirection] || normalizedInitiatedBy(headerContext.initiatedBy);
  const explicitInitiatedBy = normalizedInitiatedBy(args.initiatedBy);
  const initiatedBy = structuredStored
    ? trustedInitiatedBy
    : stored
      ? trustedInitiatedBy || explicitInitiatedBy
      : explicitInitiatedBy;
  return {
    chatMode,
    reportType: stored ? 'full' : text(args.reportType, '') || '',
    initiatedBy,
    topic: publicHeaderValue(args.topic) || title,
    worldName,
    localIdentity,
    peerIdentity,
    contextLabel,
    contextText,
    contextSource,
    contextBlocks: contextBlocks.slice(0, 4),
    dateLabel: transcriptDateLabel(messages, sourceSummary),
    messageCount: messages.length,
  };
}

async function hydrateStoredTranscriptDirection({
  workspaceRoot,
  request,
  source,
  headerContext,
  resolveDirection,
}) {
  if (request.mode !== 'stored') return '';
  const localDirection = normalizedRequestDirection(source.summary.requestDirection);
  if (localDirection || normalizedInitiatedBy(headerContext.initiatedBy)) return localDirection;
  if (typeof resolveDirection !== 'function') return '';
  try {
    const payload = await resolveDirection({
      chatRequestId: request.chatRequestId,
      accountId: text(source.summary.accountId, null),
      relayAgentId: text(source.summary.relayAgentId, null),
      source: source.summary,
    });
    const directions = typeof payload === 'string'
      ? { [request.chatRequestId]: normalizedRequestDirection(payload) }
      : extractClaworldConversationDirections(payload);
    const direction = normalizedRequestDirection(directions[request.chatRequestId]);
    if (!direction) return '';
    source.summary.requestDirection = direction;
    try {
      await recordClaworldTranscriptDirection(workspaceRoot, request.chatRequestId, direction, {
        accountId: text(source.summary.accountId, null),
        relayAgentId: text(source.summary.relayAgentId, text(source.summary.targetAgentId, null)),
      });
    } catch {
      // The trusted backend value still applies to this render if persistence fails.
    }
    return direction;
  } catch {
    return '';
  }
}

function outputDirectories(workspaceRoot) {
  const base = path.join(workspaceRoot, '.claworld', 'reports', 'transcripts');
  return { images: path.join(base, 'images'), documents: path.join(base, 'documents') };
}

function artifactId(source, selection, styleName) {
  const now = new Date();
  const pad = (part) => String(part).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const styleSlug = styleName.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'style';
  const digest = createHash('sha256')
    .update(JSON.stringify({ source, selection, style: styleName, now: timestamp, nonce: randomUUID() }))
    .digest('hex')
    .slice(0, 10);
  return `claworld-transcript-${styleSlug}-${timestamp}-${digest}`;
}

async function sha256(filePath) {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

function intValue(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback));
}

async function writePng(svg, pngPath, page) {
  const sharpModule = await import('sharp');
  const sharp = sharpModule.default || sharpModule;
  await sharp(Buffer.from(svg), { density: 192 })
    .resize(page.width, page.height, { fit: 'fill' })
    .png()
    .toFile(pngPath);
  return { renderer: 'sharp-svg' };
}

function artifactPage(item) {
  return compactObject({
    page: item.page,
    format: item.format,
    path: item.path,
    width: item.width,
    height: item.height,
    sha256: item.sha256,
  });
}

export async function renderTranscriptReport({
  workspaceRoot,
  localAgentId = null,
  args = {},
  resolveDirection = null,
  episodeView = {},
} = {}) {
  if (!workspaceRoot) throw new Error('OpenClaw workspace root is required for transcript rendering');
  workspaceRoot = path.resolve(workspaceRoot);
  const request = normalizeRenderRequest(args);
  const source = await loadSourceMessages(request, workspaceRoot, episodeView);
  const headerContext = extractTranscriptHeaderContext(source.messages, source);
  await hydrateStoredTranscriptDirection({
    workspaceRoot,
    request,
    source,
    headerContext,
    resolveDirection,
  });
  const normalized = normalizeMessages(source.messages, localAgentId, request.renderArgs, headerContext);
  if (!normalized.length) throw new Error('no visible transcript messages were found for rendering');

  const selection = selectionSummary(request, normalized.length);
  const width = DEFAULT_WIDTH;
  const maxPageHeight = intValue(request.renderArgs.maxPageHeight, DEFAULT_MAX_PAGE_HEIGHT, 900, MAX_PAGE_HEIGHT);
  const legacyHeader = headerText(request.renderArgs, normalized, headerContext);
  const header = transcriptHeader(
    request.renderArgs,
    normalized,
    headerContext,
    legacyHeader.title,
    source.summary,
  );
  const decorated = decorateSelection(normalized, selection);
  const measured = decorated.map((item) => measureTranscriptItem(item, width));
  const pages = paginateTranscriptItems(measured, width, maxPageHeight, header);
  const currentArtifactId = artifactId(source.summary, selection, CLAWORLD_TRANSCRIPT_STYLE_NAME);
  const directories = outputDirectories(workspaceRoot);
  await Promise.all([fs.mkdir(directories.images, { recursive: true }), fs.mkdir(directories.documents, { recursive: true })]);

  const files = [];
  for (const page of pages) {
    const suffix = `p${String(page.page).padStart(2, '0')}`;
    const svgPath = path.join(directories.documents, `${currentArtifactId}-${suffix}.svg`);
    const pngPath = path.join(directories.images, `${currentArtifactId}-${suffix}.png`);
    const svg = renderTranscriptPageSvg(page);
    await atomicWriteText(svgPath, svg);
    const pngResult = await writePng(svg, pngPath, page);
    files.push({ page: page.page, format: 'svg', path: svgPath, width: page.width, height: page.height, sha256: await sha256(svgPath), role: 'source' });
    files.push({ page: page.page, format: 'png', path: pngPath, width: page.width, height: page.height, sha256: await sha256(pngPath), role: 'primary', renderer: pngResult.renderer });
  }

  const bubbleSpec = {
    version: '1',
    kind: 'claworld.transcript_report',
    scene: {
      title: legacyHeader.title,
      subtitle: legacyHeader.subtitle,
      peerId: legacyHeader.title,
      peerProfile: legacyHeader.subtitle,
      peerProfileSource: header.contextSource || 'fallback',
      header,
      generatedAt: isoNow(),
      source: source.summary,
      selection,
    },
    canvas: { width, style: CLAWORLD_TRANSCRIPT_STYLE_NAME, maxPageHeight },
    participants: participants(normalized),
    messages: decorated.map(bubbleMessagePayload),
  };
  const specPath = path.join(directories.documents, `${currentArtifactId}.bubblespec.json`);
  await atomicWriteJson(specPath, bubbleSpec);

  const pngPages = files.filter((item) => item.format === 'png').map(artifactPage);
  const svgPages = files.filter((item) => item.format === 'svg').map(artifactPage);
  const stats = {
    sourceMessages: source.messages.length,
    normalizedMessages: normalized.length,
    renderedMessages: normalized.length,
    pages: pages.length,
    omittedBefore: selection.omittedBefore || 0,
    omittedAfter: selection.omittedAfter || 0,
  };
  const result = compactObject({
    status: 'ok',
    mode: request.mode,
    chatRequestId: request.mode === 'stored' ? request.chatRequestId : null,
    artifactId: currentArtifactId,
    messageCount: normalized.length,
    pageCount: pages.length,
    style: CLAWORLD_TRANSCRIPT_STYLE_NAME,
    artifacts: {
      bubbleSpec: { format: 'bubblespec', path: specPath, sha256: await sha256(specPath) },
      pngPages,
      svgPages,
    },
    diagnostics: { source: source.summary, stats },
  });
  await appendClaworldJournalEvent(workspaceRoot, {
    kind: 'transcript_report',
    scope: request.mode === 'stored' ? 'conversation' : 'main',
    summary: `Rendered ${normalized.length} visible Claworld transcript messages across ${pages.length} page(s).`,
    refs: { chatRequestId: request.mode === 'stored' ? request.chatRequestId : null },
    artifacts: { artifactId: currentArtifactId, bubbleSpec: specPath, pngPages: pngPages.map((item) => item.path), svgPages: svgPages.map((item) => item.path) },
    maintenance: { selection, stats },
  });
  return result;
}
