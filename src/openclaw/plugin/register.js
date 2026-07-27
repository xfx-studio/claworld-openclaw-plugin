import {
  createClaworldChannelPlugin,
  recordClaworldRuntimeAssistantOutput,
} from './claworld-channel-plugin.js';
import {
  projectToolChatRequestMutationResponse,
  projectToolCreateWorldResponse,
  projectToolFeedbackSubmissionResponse,
  projectToolJoinWorldResponse,
  projectToolWorldDetail,
  projectToolWorldList,
  projectToolWorldMemberSearchResponse,
  projectToolWorldSearchResponse,
} from '../runtime/tool-contracts.js';
import { CLAWORLD_TOOL_CONTRACT_VERSION } from '../runtime/tool-inventory.js';
import { CLAWORLD_PLUGIN_CURRENT_VERSION } from '../plugin-version.js';
import {
  CLAWORLD_BOOTSTRAP_TARGETS,
  appendClaworldJournalEvent,
  buildClaworldBootstrapPromptContext,
  buildClaworldContextPointer,
  buildClaworldToolMaintenanceEvent,
  ensureClaworldWorkingMemory,
  resolveClaworldBootstrapTarget,
  updateClaworldSessionDirectory,
} from '../runtime/working-memory.js';
import { resolveOpenClawWorkspaceRoot } from '../runtime/workspace-resolver.js';
import {
  MAX_PAGE_HEIGHT,
  augmentConversationPayloadWithLocalTranscriptIndex,
  cacheClaworldConversationDirections,
  renderTranscriptReport,
} from '../runtime/transcript-report.js';
import { deliverClaworldManagementReport } from '../runtime/management-report.js';
import { setClaworldRuntime } from './runtime.js';
import { PUBLIC_TOOL_ACTION_CATALOG } from '../../product-shell/contracts/search-item.js';
import {
  ACCOUNT_ACTIONS,
  arrayParam,
  booleanParam,
  buildToolMetadata,
  buildToolResult,
  CHAT_INBOX_ACTIONS,
  inferAccountAction,
  inferChatInboxAction,
  inferManageWorldAction,
  INTERNAL_REQUESTER_SESSION_KEY_PARAM,
  integerParam,
  loadCurrentConfig,
  MANAGE_WORLD_ACTIONS,
  normalizeManageWorldAction,
  normalizeObject,
  normalizeText,
  objectParam,
  projectToolAccountMutationResponse,
  projectToolAccountViewResponse,
  projectToolChatInboxActionResponse,
  projectToolManageWorldActionResponse,
  requireManageWorldField,
  resolveToolContext,
  resolveToolAgentId,
  resolveToolDisplayName,
  stringParam,
  withToolErrorBoundary,
} from './register-tooling.js';

function isManagementToolContext(toolContext = {}) {
  const sessionKey = normalizeText(toolContext?.sessionKey, '');
  return /^management:[^:]+/iu.test(sessionKey)
    || /^agent:[^:]+:management:[^:]+/iu.test(sessionKey)
    || /^agent:[^:]+:claworld:(?:orchestration|operator|management)(?::|$)/iu.test(sessionKey);
}

function resolveShareCardToolResult(result) {
  if (!Array.isArray(result?.content)) return null;
  for (let index = 0; index < result.content.length; index += 1) {
    const entry = result.content[index];
    if (entry?.type !== 'text' || typeof entry.text !== 'string') continue;
    try {
      const payload = JSON.parse(entry.text);
      const shareCard = normalizeObject(payload?.shareCard, null);
      if (normalizeText(shareCard?.status, null) !== 'ready') continue;
      const mediaUrl = normalizeText(
        shareCard?.imageUrl,
        normalizeText(shareCard?.downloadUrl, null),
      );
      if (!mediaUrl) continue;
      return { index, entry, payload, shareCard, mediaUrl };
    } catch {
      continue;
    }
  }
  return null;
}

async function deliverShareCardToCurrentChannel(api, result, toolContext = {}) {
  const resolved = resolveShareCardToolResult(result);
  if (!resolved) return result;

  const route = toolContext?.deliveryContext || {};
  const channel = normalizeText(route.channel, normalizeText(toolContext?.messageChannel, null));
  const to = normalizeText(route.to, null);
  if (!channel || !to) {
    throw new Error('share-card delivery requires an active channel route');
  }

  const loadAdapter = api?.runtime?.channel?.outbound?.loadAdapter;
  if (typeof loadAdapter !== 'function') {
    throw new Error('share-card delivery requires the OpenClaw channel outbound runtime');
  }
  const adapter = await loadAdapter(channel);
  if (typeof adapter?.sendMedia !== 'function') {
    throw new Error(`share-card delivery is unavailable for channel ${channel}`);
  }

  const deliveryResult = await adapter.sendMedia({
    cfg: toolContext?.getRuntimeConfig?.() || toolContext?.runtimeConfig || api.config,
    to,
    text: '',
    mediaUrl: resolved.mediaUrl,
    ...(normalizeText(route.accountId, null) ? { accountId: normalizeText(route.accountId, null) } : {}),
    ...(route.threadId != null ? { threadId: route.threadId } : {}),
  });
  if (deliveryResult?.success === false) {
    throw new Error(`share-card delivery failed on channel ${channel}`);
  }
  const deliveryKind = normalizeText(deliveryResult?.receipt?.kind, null)?.toLowerCase();
  if (deliveryKind && !['image', 'media'].includes(deliveryKind)) {
    throw new Error(`share-card delivery did not produce native media on channel ${channel}`);
  }

  const content = [...result.content];
  content[resolved.index] = {
    ...resolved.entry,
    text: JSON.stringify({
      ...resolved.payload,
      shareCard: {
        ...resolved.shareCard,
        description: '分享卡图片已通过当前聊天渠道发送给用户。请只用一句普通文本确认分享卡已生成；不要下载、再次发送或输出 MEDIA:。',
      },
    }, null, 2),
  };
  return { ...result, content };
}

async function resolveTranscriptWorkspace(api, params = {}, toolContext = {}) {
  const cfg = await loadCurrentConfig(api);
  const agentId = normalizeText(
    toolContext?.agentId,
    normalizeText(toolContext?.context?.agentId, normalizeText(params.agentId, null)),
  );
  return {
    cfg,
    agentId,
    workspaceRoot: resolveOpenClawWorkspaceRoot({
      sources: [toolContext, toolContext?.context, params],
      config: cfg,
      agentId,
    }),
  };
}

function resolveConfiguredConversationView(plugin, cfg, {
  accountId = null,
  relayAgentId = null,
  targetAgentId = null,
} = {}) {
  const normalizedAccountId = normalizeText(accountId, null);
  const expectedRelayAgentId = normalizeText(relayAgentId, normalizeText(targetAgentId, null));
  if (normalizedAccountId) {
    let runtimeConfig = {};
    try {
      runtimeConfig = plugin.config?.resolveRuntimeConfig?.(cfg, normalizedAccountId) || {};
    } catch {
      runtimeConfig = {};
    }
    return {
      accountId: normalizedAccountId,
      relayAgentId: normalizeText(expectedRelayAgentId, normalizeText(runtimeConfig?.relay?.agentId, null)),
    };
  }
  if (!expectedRelayAgentId) return null;
  const accountIds = plugin.config?.listAccountIds?.(cfg) || [];
  const matches = accountIds.map((candidateAccountId) => {
    const runtimeConfig = plugin.config?.resolveRuntimeConfig?.(cfg, candidateAccountId) || {};
    return {
      accountId: candidateAccountId,
      relayAgentId: normalizeText(runtimeConfig?.relay?.agentId, null),
    };
  }).filter((candidate) => candidate.relayAgentId === expectedRelayAgentId);
  return matches.length === 1 ? matches[0] : null;
}

function resolveTranscriptClaworldAccountId(params = {}, toolContext = {}) {
  const explicitAccountId = normalizeText(params.accountId, null);
  if (explicitAccountId) return explicitAccountId;
  const deliveryContext = normalizeObject(toolContext.deliveryContext, {}) || {};
  const channel = normalizeText(
    toolContext.messageChannel,
    normalizeText(deliveryContext.channel, null),
  );
  return channel === 'claworld' ? normalizeText(deliveryContext.accountId, null) : null;
}

async function cacheToolConversationDirections(api, plugin, params, toolContext, payload) {
  try {
    const { cfg, workspaceRoot } = await resolveTranscriptWorkspace(api, params, toolContext);
    if (workspaceRoot) {
      const view = resolveConfiguredConversationView(plugin, cfg, { accountId: params.accountId });
      await cacheClaworldConversationDirections(workspaceRoot, payload, view || {});
    }
  } catch {
    // Backend actions remain successful when the local transcript cache is unavailable.
  }
  return payload;
}

function buildClaworldStatusRoute(plugin) {
  return {
    method: 'GET',
    path: '/plugins/claworld/status',
    auth: 'gateway',
    match: 'exact',
    async handler(_req, res) {
      const payload = plugin.status?.getSnapshot?.() || {
        ok: true,
        pluginId: plugin.id || 'claworld',
      };
      if (typeof res?.status === 'function' && typeof res?.json === 'function') {
        res.status(200).json(payload);
        return true;
      }
      if (typeof res?.setHeader === 'function') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
      }
      if (typeof res?.end === 'function') {
        res.end(JSON.stringify(payload));
        return true;
      }
      return payload;
    },
  };
}

async function resolveHookWorkspaceRoot(api, event = {}, ctx = {}) {
  const directWorkspaceRoot = resolveOpenClawWorkspaceRoot({ sources: [event, ctx] });
  if (directWorkspaceRoot) return directWorkspaceRoot;
  const cfg = await loadCurrentConfig(api);
  return resolveOpenClawWorkspaceRoot({
    sources: [event, ctx],
    config: cfg,
    agentId: ctx?.agentId ?? event?.agentId,
  });
}

function getHookLogger(api) {
  return api?.logger || api?.runtime?.logger || console;
}

function parseHookToolPayload(result) {
  if (!result || typeof result !== 'object') return null;
  const text = Array.isArray(result.content)
    ? result.content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string')?.text
    : null;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isSuccessfulHookToolCall(event = {}) {
  if (event?.error || event?.isError === true) return false;
  const result = event?.result ?? event?.output ?? event?.response ?? null;
  if (result?.isError === true) return false;
  const payload = parseHookToolPayload(result);
  if (normalizeText(payload?.status, null) === 'error') return false;
  return true;
}

function hookToolResult(event = {}) {
  return event?.result ?? event?.output ?? event?.response ?? null;
}

const CHAT_INBOX_FILTER_DIRECTIONS = Object.freeze([
  'inbound',
  'outbound',
]);
const CHAT_INBOX_FILTER_MODES = Object.freeze([
  'direct',
  'world',
]);
const CHAT_INBOX_FILTER_STATUSES = Object.freeze([
  'pending',
  'expired',
  'rejected',
  'opening',
  'ending',
  'active',
  'silent',
  'kickoff_failed',
  'ended',
]);
const FEEDBACK_CATEGORIES = Object.freeze([
  'experience_issue',
  'usage_issue',
  'bug_report',
  'feature_request',
]);
const FEEDBACK_IMPACTS = Object.freeze([
  'low',
  'medium',
  'high',
  'blocker',
]);
const CHAT_INBOX_FILTER_KEYS = Object.freeze([
  'direction',
  'mode',
  'status',
  'worldId',
  'chatRequestId',
  'conversationKey',
  'localSessionKey',
  'counterpartyAgentId',
]);
const CHAT_INBOX_FILTER_KEY_SET = new Set(CHAT_INBOX_FILTER_KEYS);
const MANAGE_CONVERSATION_REQUEST_ONLY_QUERY_FIELDS = Object.freeze([
  'displayName',
  'agentCode',
  'openingMessage',
]);
const MANAGE_CONVERSATION_FILTER_ONLY_TOP_LEVEL_FIELDS = Object.freeze([
  'mode',
  'status',
  'worldId',
  'counterpartyAgentId',
]);
const MANAGE_CONVERSATION_GET_STATE_TARGET_FIELDS = Object.freeze([
  'chatRequestId',
  'conversationKey',
  'localSessionKey',
]);

const TERMINAL_ACCOUNT_ACTIONS = PUBLIC_TOOL_ACTION_CATALOG.claworld_manage_account;
const TERMINAL_WORLD_ACTIONS = PUBLIC_TOOL_ACTION_CATALOG.claworld_manage_worlds;
const TERMINAL_CONVERSATION_ACTIONS = PUBLIC_TOOL_ACTION_CATALOG.claworld_manage_conversations;

const CLAWORLD_WORLD_TOOL_GUIDANCE = 'Before any world operation, read the `claworld-manage-worlds` skill.';

const ACCOUNT_IMPLEMENTATION_ACTIONS = Object.freeze({
  view_account: 'view',
});

const WORLD_IMPLEMENTATION_ACTIONS = Object.freeze({
  list_owned_worlds: 'list',
  list_joined_worlds: 'list_memberships',
  update_world: 'update_context',
  update_world_profile: 'update_profile',
  publish_broadcast: 'broadcast',
  leave_world: 'leave',
});

function normalizeTerminalAction(action, allowedActions, fallback = null) {
  const normalized = normalizeText(action, fallback);
  return allowedActions.includes(normalized) ? normalized : fallback;
}

function hasExplicitAction(params = {}) {
  return Object.prototype.hasOwnProperty.call(params, 'action') && normalizeText(params.action, null) != null;
}

function resolveConversationOpeningMessage(params = {}) {
  const kickoffBrief = params?.kickoffBrief && typeof params.kickoffBrief === 'object' && !Array.isArray(params.kickoffBrief)
    ? params.kickoffBrief
    : null;
  return normalizeText(
    params?.openingMessage,
    normalizeText(
      params?.message,
      normalizeText(
        params?.text,
        normalizeText(
          typeof params?.kickoffBrief === 'string' ? params.kickoffBrief : null,
          normalizeText(
            kickoffBrief?.text,
            normalizeText(kickoffBrief?.openingMessage, normalizeText(kickoffBrief?.message, normalizeText(params?.openingPayload?.text, null))),
          ),
        ),
      ),
    ),
  );
}

function normalizeTerminalAccountAction(params = {}) {
  if (hasExplicitAction(params)) {
    const explicitAction = normalizeText(params.action, null);
    const terminalAction = normalizeTerminalAction(explicitAction, TERMINAL_ACCOUNT_ACTIONS, null);
    if (terminalAction) return terminalAction;
    requireManageWorldField('action', `action must be one of ${TERMINAL_ACCOUNT_ACTIONS.join(', ')}`);
  }
  if (normalizeText(params.displayName, null)) return 'update_display_name';
  if (Object.prototype.hasOwnProperty.call(params, 'humanProfile')) return 'update_human_profile';
  if (
    Object.prototype.hasOwnProperty.call(params, 'agentProfile')
    || Object.prototype.hasOwnProperty.call(params, 'profile')
  ) return 'update_agent_profile';
  if (Object.prototype.hasOwnProperty.call(params, 'visibilityMode')) return 'set_visibility_mode';
  if (Object.prototype.hasOwnProperty.call(params, 'contactPolicy')) return 'set_contact_policy';
  if (Object.prototype.hasOwnProperty.call(params, 'chatRequestPolicy')) {
    requireManageWorldField('chatRequestPolicy', 'chatRequestPolicy is not supported by claworld_manage_account; use contactPolicy');
  }
  if (Object.prototype.hasOwnProperty.call(params, 'proactivitySettings')) return 'set_proactivity';
  if (
    hasProvidedToolParam(params, 'category')
    || hasProvidedToolParam(params, 'title')
    || hasProvidedToolParam(params, 'actualBehavior')
    || hasProvidedToolParam(params, 'expectedBehavior')
    || hasProvidedToolParam(params, 'reproductionSteps')
  ) return 'submit_feedback';
  return 'view_account';
}

function hasProvidedTerminalAccountPolicyField(params = {}, fieldId) {
  if (!Object.prototype.hasOwnProperty.call(params, fieldId)) return false;
  const value = params[fieldId];
  if (value == null) return false;
  if (typeof value === 'string') return normalizeText(value, null) != null;
  return true;
}

function validateTerminalAccountPolicyPayload(action, params = {}) {
  if (action === 'set_visibility_mode') {
    if (!normalizeText(params.visibilityMode, null)) {
      requireManageWorldField('visibilityMode', 'visibilityMode is required for action=set_visibility_mode');
    }
    if (hasProvidedTerminalAccountPolicyField(params, 'contactPolicy')) {
      requireManageWorldField('contactPolicy', 'contactPolicy is not supported for action=set_visibility_mode');
    }
    if (hasProvidedTerminalAccountPolicyField(params, 'chatRequestPolicy')) {
      requireManageWorldField('chatRequestPolicy', 'chatRequestPolicy is not supported by claworld_manage_account; use contactPolicy');
    }
    return;
  }
  if (action === 'set_contact_policy') {
    if (!normalizeText(params.contactPolicy, null)) {
      requireManageWorldField('contactPolicy', 'contactPolicy is required for action=set_contact_policy');
    }
    if (hasProvidedTerminalAccountPolicyField(params, 'visibilityMode')) {
      requireManageWorldField('visibilityMode', 'visibilityMode is not supported for action=set_contact_policy');
    }
    if (hasProvidedTerminalAccountPolicyField(params, 'chatRequestPolicy')) {
      requireManageWorldField('chatRequestPolicy', 'chatRequestPolicy is not supported by claworld_manage_account; use contactPolicy');
    }
    return;
  }
}

function normalizeTerminalWorldAction(params = {}) {
  if (hasExplicitAction(params)) {
    const explicitAction = normalizeText(params.action, null);
    const terminalAction = normalizeTerminalAction(explicitAction, TERMINAL_WORLD_ACTIONS, null);
    if (terminalAction) return terminalAction;
    requireManageWorldField('action', `action must be one of ${TERMINAL_WORLD_ACTIONS.join(', ')}`);
  }
  if (!normalizeText(params.worldId, null)) return 'list_owned_worlds';
  if (normalizeText(params.targetAgentId, null) || normalizeText(params.identity, null)) return 'invite_member';
  if (normalizeText(params.announcementText, null)) return 'publish_broadcast';
  if (normalizeText(params.participantContextText, null)) return 'update_world_profile';
  if (
    normalizeText(params.worldContextText, null)
    || normalizeText(params.displayName, null)
    || normalizeObject(params.broadcast, null)
    || typeof params.enabled === 'boolean'
  ) {
    return 'update_world';
  }
  return 'get_world';
}

function normalizeTerminalConversationAction(action, fallback = 'list_related', { throwOnInvalid = false } = {}) {
  const normalized = normalizeText(action, null);
  if (!normalized) return fallback;
  if (TERMINAL_CONVERSATION_ACTIONS.includes(normalized)) return normalized;
  if (throwOnInvalid) {
    requireManageWorldField('action', `action must be one of ${TERMINAL_CONVERSATION_ACTIONS.join(', ')}`);
  }
  return null;
}

function buildTerminalActionResult({ tool, action, payload = {}, status = null } = {}) {
  const normalizedPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : { value: payload };
  const normalizedStatus = status || normalizeText(normalizedPayload.status, 'ok');
  return buildToolResult({
    ...normalizedPayload,
    tool,
    action,
    status: normalizedStatus,
  });
}

function normalizeChatInboxListFiltersInput(params = {}) {
  const source = normalizeObject(params.filters, {}) || {};
  const normalized = {
    direction: normalizeText(source.direction ?? params.direction, null),
    mode: normalizeText(source.mode, null),
    status: normalizeText(source.status, null),
    worldId: normalizeText(source.worldId, null),
    chatRequestId: normalizeText(source.chatRequestId, null),
    conversationKey: normalizeText(source.conversationKey, null),
    localSessionKey: normalizeText(source.localSessionKey, null),
    counterpartyAgentId: normalizeText(source.counterpartyAgentId, null),
  };
  return Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value != null),
  );
}

function hasProvidedToolParam(params = {}, fieldId) {
  if (!params || typeof params !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(params, fieldId)) return false;
  const value = params[fieldId];
  if (typeof value === 'string') return normalizeText(value, null) != null;
  return value != null;
}

function normalizeFeedbackStringList(values = []) {
  const source = Array.isArray(values) ? values : [values];
  return [...new Set(source.map((value) => normalizeText(value, null)).filter(Boolean))];
}

function validateTerminalFeedbackPayload(params = {}) {
  const category = normalizeText(params.category, null);
  const impact = normalizeText(params.impact, 'medium');
  if (!category) requireManageWorldField('category', 'category is required for action=submit_feedback');
  if (!FEEDBACK_CATEGORIES.includes(category)) {
    requireManageWorldField('category', `category must be one of ${FEEDBACK_CATEGORIES.join(', ')}`);
  }
  if (!FEEDBACK_IMPACTS.includes(impact)) {
    requireManageWorldField('impact', `impact must be one of ${FEEDBACK_IMPACTS.join(', ')}`);
  }
  for (const fieldId of ['title', 'goal', 'actualBehavior', 'expectedBehavior']) {
    if (!normalizeText(params[fieldId], null)) {
      requireManageWorldField(fieldId, `${fieldId} is required for action=submit_feedback`);
    }
  }
  if (
    params.context != null
    && (!params.context || typeof params.context !== 'object' || Array.isArray(params.context))
  ) {
    requireManageWorldField('context', 'context must be an object for action=submit_feedback');
  }
}

function normalizeTerminalFeedbackContext(params = {}) {
  const context = normalizeObject(params.context, {}) || {};
  const metadata = normalizeObject(context.metadata, {}) || {};
  const redactionNotes = normalizeText(params.redactionNotes, null);
  return {
    worldId: normalizeText(context.worldId, normalizeText(params.worldId, null)),
    conversationKey: normalizeText(context.conversationKey, normalizeText(params.conversationKey, null)),
    turnId: normalizeText(context.turnId, normalizeText(params.turnId, null)),
    deliveryId: normalizeText(context.deliveryId, normalizeText(params.deliveryId, null)),
    targetAgentId: normalizeText(context.targetAgentId, normalizeText(params.targetAgentId, null)),
    tags: normalizeFeedbackStringList(context.tags),
    metadata: {
      ...metadata,
      ...(redactionNotes ? { redactionNotes } : {}),
    },
  };
}

function normalizeTerminalFeedbackPayload(params = {}) {
  return {
    category: normalizeText(params.category, null),
    title: normalizeText(params.title, null),
    goal: normalizeText(params.goal, null),
    actualBehavior: normalizeText(params.actualBehavior, null),
    expectedBehavior: normalizeText(params.expectedBehavior, null),
    impact: normalizeText(params.impact, 'medium'),
    details: normalizeText(params.details, null),
    reproductionSteps: normalizeFeedbackStringList(params.reproductionSteps),
    context: normalizeTerminalFeedbackContext(params),
  };
}

function buildChatInboxFiltersParam({ description, worldIdProperty } = {}) {
  return objectParam({
    description,
    additionalProperties: false,
    properties: {
      direction: stringParam({
        description: 'Filter from the current account perspective.',
        enumValues: CHAT_INBOX_FILTER_DIRECTIONS,
        examples: ['outbound'],
      }),
      mode: stringParam({
        description: 'Filter to direct or world-scoped chat items.',
        enumValues: CHAT_INBOX_FILTER_MODES,
        examples: ['world'],
      }),
      status: stringParam({
        description: 'Filter to pending or terminal requests, or to chats by current status.',
        enumValues: CHAT_INBOX_FILTER_STATUSES,
        examples: ['active'],
      }),
      worldId: worldIdProperty,
      chatRequestId: stringParam({
        description: 'Filter to one canonical chat request id.',
        minLength: 1,
        examples: ['req_demo_1'],
      }),
      conversationKey: stringParam({
        description: 'Filter to one canonical conversation key.',
        minLength: 1,
        examples: ['pair:agt_alice::agt_moza:world:dating-demo-world'],
      }),
      localSessionKey: stringParam({
        description: 'Filter to one local Claworld session reference for internal tracking, summaries, or orchestration only. Not a transport address for sending a user message to the peer.',
        minLength: 1,
        examples: ['conversation:pair:agt_alice::agt_moza:world:dating-demo-world'],
      }),
      counterpartyAgentId: stringParam({
        description: 'Filter to one counterparty agentId.',
        minLength: 1,
        examples: ['agt_alice'],
      }),
    },
  });
}

function validateChatInboxFilterInput(filters = {}, action) {
  const source = normalizeObject(filters, {}) || {};
  for (const key of Object.keys(source)) {
    if (CHAT_INBOX_FILTER_KEY_SET.has(key)) continue;
    requireManageWorldField(`filters.${key}`, `filters.${key} is not supported for action=${action}`);
  }
  return source;
}

function normalizeManageConversationInboxQuery(params = {}, action) {
  const normalizedAction = normalizeTerminalConversationAction(action, 'list_related');
  const filters = validateChatInboxFilterInput(params.filters, normalizedAction);

  const requestOnlyField = MANAGE_CONVERSATION_REQUEST_ONLY_QUERY_FIELDS.find((fieldId) => hasProvidedToolParam(params, fieldId));
  if (requestOnlyField) {
    requireManageWorldField(requestOnlyField, `${requestOnlyField} is only supported for action=request`);
  }
  if (hasProvidedToolParam(params, 'limit')) {
    requireManageWorldField('limit', `limit is not supported for action=${normalizedAction}`);
  }

  const filterOnlyField = MANAGE_CONVERSATION_FILTER_ONLY_TOP_LEVEL_FIELDS.find((fieldId) => hasProvidedToolParam(params, fieldId));
  if (filterOnlyField) {
    requireManageWorldField(
      filterOnlyField,
      `${filterOnlyField} must be passed as filters.${filterOnlyField} for action=${normalizedAction}`,
    );
  }

  if (normalizedAction !== 'get_state') {
    const getStateOnlyField = MANAGE_CONVERSATION_GET_STATE_TARGET_FIELDS.find((fieldId) => hasProvidedToolParam(params, fieldId));
    if (getStateOnlyField) {
      requireManageWorldField(
        getStateOnlyField,
        `${getStateOnlyField} must be passed as filters.${getStateOnlyField} for action=${normalizedAction}`,
      );
    }
  }

  const mergedFilters = {
    ...filters,
    ...(!Object.prototype.hasOwnProperty.call(filters, 'direction') && hasProvidedToolParam(params, 'direction')
      ? { direction: params.direction }
      : {}),
    ...(normalizedAction === 'get_state'
      ? Object.fromEntries(
          MANAGE_CONVERSATION_GET_STATE_TARGET_FIELDS
            .filter((fieldId) => (
              !Object.prototype.hasOwnProperty.call(filters, fieldId)
              && hasProvidedToolParam(params, fieldId)
            ))
            .map((fieldId) => [fieldId, params[fieldId]]),
        )
      : {}),
  };
  return normalizeChatInboxListFiltersInput({ filters: mergedFilters });
}

function parseToolResultPayload(result = null) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function rewriteToolResultName(result, toolName, action = null) {
  const payload = parseToolResultPayload(result);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return result;
  return buildToolResult({
    ...payload,
    tool: toolName,
    ...(action ? { action } : {}),
  });
}

function requireTerminalTool(internalTools, toolName) {
  const tool = internalTools.get(toolName);
  if (!tool || typeof tool.execute !== 'function') {
    throw new Error(`terminal public tool adapter requires ${toolName}`);
  }
  return tool;
}

function createTerminalToolAdapters(api, plugin, internalTools) {
  const accountIdProperty = stringParam({
    description: 'Claworld account id to execute the tool against.',
    minLength: 1,
    examples: ['claworld'],
  });
  const shareCardVariantProperty = stringParam({
    description: 'Optional share-card version. Choose from the user\'s usual communication language or sharing context: zh for Chinese, en for languages outside Chinese.',
    enumValues: ['en', 'zh'],
    examples: ['en', 'zh'],
  });
  const worldIdProperty = stringParam({
    description: 'Canonical world id.',
    minLength: 1,
    examples: ['dating-demo-world'],
  });
  const searchTool = 'claworld_search';
  const manageWorldsTool = 'claworld_manage_worlds';
  const manageConversationsTool = 'claworld_manage_conversations';
  const renderTranscriptTool = 'claworld_render_transcript_report';
  const reportToHumanTool = 'claworld_report_to_human';
  const accountTool = 'claworld_manage_account';
  const publicProfileTool = 'claworld_get_public_profile';

  return [
    {
      name: accountTool,
      label: 'Claworld Manage Account',
      description: 'Terminal account surface for readiness, public identity, global profile, share-card generation, visibility, inbound contact policy, notification/proactivity policy, email-based identity verification, and authenticated feedback submission.',
      metadata: buildToolMetadata({
        category: 'account',
        usageNotes: [
          'Use this human-facing account surface for identity verification, profile, policy, and subscription decisions.',
          'Use action=view_account for readiness; update_display_name, update_agent_profile, or set_contact_policy for common account mutations.',
          'Use start_email_verification with email + optional displayName to start email-based identity verification, then complete_email_verification with email + code to finish.',
          'Use subscribe_person or unsubscribe_person when a search/profile result exposes a person subscription target.',
          'Use submit_feedback for Claworld bugs, confusing behavior, missing capability, or feature requests. The tool handles auth internally.',
        ],
      }),
      parameters: objectParam({
        description: 'Terminal account management payload.',
        required: ['accountId'],
        properties: {
          accountId: accountIdProperty,
          action: stringParam({
            description: 'Account action.',
            enumValues: TERMINAL_ACCOUNT_ACTIONS,
            examples: ['view_account', 'start_email_verification', 'update_display_name', 'set_contact_policy', 'submit_feedback'],
          }),
          displayName: stringParam({
            description: 'Public-facing display name for update_display_name or start_email_verification.',
            minLength: 1,
            examples: ['Moza', '小发发'],
          }),
          profile: stringParam({
            description: 'Optional global profile text used when updating the agent profile.',
            examples: ['喜欢慢节奏介绍，也愿意先让 agent 做初步认识。🙂'],
          }),
          humanProfile: stringParam({
            description: 'Human profile for action=update_human_profile.',
            examples: ['周末在上海，喜欢网球和安静咖啡馆。'],
          }),
          agentProfile: stringParam({
            description: 'Agent profile for action=update_agent_profile.',
            examples: ['偏主动但会先确认边界，擅长总结和约局。'],
          }),
          visibilityMode: stringParam({
            description: 'Account visibility mode: public is searchable, unlisted is explicit-identity reachable, private is not publicly reachable.',
            enumValues: ['public', 'unlisted', 'private'],
            examples: ['public', 'unlisted', 'private'],
          }),
          contactPolicy: stringParam({
            description: 'Inbound contact policy: open auto-accepts eligible requests, approval_required routes pending requests to Management review using the human\'s instructions and context, and closed blocks new inbound requests.',
            enumValues: ['open', 'approval_required', 'closed'],
            examples: ['open', 'approval_required', 'closed'],
          }),
          proactivitySettings: objectParam({
            description: 'Account-level proactive-management settings.',
            additionalProperties: true,
          }),
          targetAgentId: stringParam({
            description: 'Target agent id for subscribe_person or unsubscribe_person.',
            minLength: 1,
            examples: ['agt_alice'],
          }),
          targetId: stringParam({
            description: 'Generic target id for subscription actions.',
            minLength: 1,
          }),
          subscriptionId: stringParam({
            description: 'Existing subscription id for unsubscribe_person.',
            minLength: 1,
            examples: ['sub_123'],
          }),
          generateShareCard: booleanParam({
            description: 'When true, include a temporary public identity card when supported.',
          }),
          shareCardVariant: shareCardVariantProperty,
          expiresInSeconds: integerParam({
            description: 'Optional temporary share-card TTL in seconds.',
            minimum: 1,
            examples: [7200],
          }),
          email: stringParam({
            description: 'Email address for start_email_verification or complete_email_verification.',
            minLength: 1,
            examples: ['agent@example.com'],
          }),
          code: stringParam({
            description: 'Verification code from email for complete_email_verification.',
            minLength: 1,
            examples: ['123456'],
          }),
          category: stringParam({
            description: 'Feedback category.',
            enumValues: FEEDBACK_CATEGORIES,
            examples: ['bug_report', 'feature_request'],
          }),
          title: stringParam({
            description: 'Short developer-readable feedback title.',
            minLength: 1,
            examples: ['Feedback submission should use account tool auth'],
          }),
          goal: stringParam({
            description: 'What the human was trying to do.',
            minLength: 1,
          }),
          actualBehavior: stringParam({
            description: 'What actually happened.',
            minLength: 1,
          }),
          expectedBehavior: stringParam({
            description: 'What should have happened.',
            minLength: 1,
          }),
          impact: stringParam({
            description: 'Feedback impact.',
            enumValues: FEEDBACK_IMPACTS,
            examples: ['medium'],
          }),
          details: stringParam({
            description: 'Developer-facing feedback details.',
            minLength: 1,
          }),
          reproductionSteps: arrayParam({
            description: 'Repeatable feedback reproduction steps.',
            items: stringParam({ minLength: 1 }),
          }),
          context: objectParam({
            description: 'Lookup metadata, such as worldId, conversationKey, deliveryId, targetAgentId, tags, and metadata.',
            additionalProperties: true,
          }),
          redactionNotes: stringParam({
            description: 'Optional note about what was redacted before submit_feedback.',
            minLength: 1,
          }),
        },
      }),
      async execute(toolCallId, params = {}) {
        const action = normalizeTerminalAccountAction(params);
        validateTerminalAccountPolicyPayload(action, params);
        const subscriptionTargetId = normalizeText(params.targetAgentId, normalizeText(params.targetId, null));
        if (action === 'subscribe_person') {
          if (!subscriptionTargetId) requireManageWorldField('targetAgentId', 'targetAgentId is required for action=subscribe_person');
          const context = await resolveToolContext(api, plugin, params, {
            requiredPublicIdentityCapability: 'subscribe person',
          });
          const payload = await plugin.runtime.productShell.subscriptions.createSubscription({
            ...context,
            targetType: 'person',
            targetId: subscriptionTargetId,
          });
          return buildTerminalActionResult({ tool: accountTool, action, payload });
        }
        if (action === 'unsubscribe_person') {
          const context = await resolveToolContext(api, plugin, params, {
            requiredPublicIdentityCapability: 'unsubscribe person',
          });
          const payload = await plugin.runtime.productShell.subscriptions.deleteSubscription({
            ...context,
            subscriptionId: params.subscriptionId || null,
            targetType: subscriptionTargetId ? 'person' : null,
            targetId: subscriptionTargetId,
          });
          return buildTerminalActionResult({ tool: accountTool, action, payload });
        }

        if (action === 'start_email_verification') {
          const email = normalizeText(params.email, null);
          if (!email) requireManageWorldField('email', 'email is required for action=start_email_verification');
          const context = await resolveToolContext(api, plugin, params, { bindRuntime: false });
          const payload = await plugin.runtime.productShell.identity.startEmailVerification({
            ...context,
            runtime: api?.runtime || null,
            email,
            displayName: params.displayName || null,
          });
          return buildTerminalActionResult({ tool: accountTool, action, payload });
        }

        if (action === 'complete_email_verification') {
          const email = normalizeText(params.email, null);
          const code = normalizeText(params.code, null);
          if (!email) requireManageWorldField('email', 'email is required for action=complete_email_verification');
          if (!code) requireManageWorldField('code', 'code is required for action=complete_email_verification');
          const context = await resolveToolContext(api, plugin, params, { bindRuntime: false });
          const payload = await plugin.runtime.productShell.identity.completeEmailVerification({
            ...context,
            runtime: api?.runtime || null,
            email,
            code,
          });
          return buildTerminalActionResult({ tool: accountTool, action, payload });
        }

        if (action === 'submit_feedback') {
          validateTerminalFeedbackPayload(params);
          const feedback = normalizeTerminalFeedbackPayload(params);
          const toolContext = await resolveToolContext(api, plugin, params, {
            requiredPublicIdentityCapability: 'submit feedback',
          });
          if (typeof plugin.runtime.productShell.feedback?.submitFeedback !== 'function') {
            requireManageWorldField('action', 'action=submit_feedback requires the feedback runtime adapter');
          }
          const payload = await plugin.runtime.productShell.feedback.submitFeedback({
            ...toolContext,
            ...feedback,
            toolCallId,
            source: 'openclaw_account_tool',
            runtimeToolName: accountTool,
            accountToolAction: action,
            pluginVersion: CLAWORLD_PLUGIN_CURRENT_VERSION,
            toolContractVersion: CLAWORLD_TOOL_CONTRACT_VERSION,
          });
          return buildTerminalActionResult({
            tool: accountTool,
            action,
            payload: projectToolFeedbackSubmissionResponse(payload),
            status: 'recorded',
          });
        }

        const implementationAction = ACCOUNT_IMPLEMENTATION_ACTIONS[action] || null;
        if (implementationAction) {
          const implementationParams = {
            ...params,
            action: implementationAction,
            ...(action === 'update_agent_profile' && params.agentProfile !== undefined
              ? { profile: params.agentProfile }
              : {}),
          };
          const result = await requireTerminalTool(internalTools, 'claworld_account').execute(toolCallId, implementationParams);
          return rewriteToolResultName(
            result,
            accountTool,
            action,
          );
        }

        if (typeof plugin.runtime.productShell.profile.executeAccountAction !== 'function') {
          requireManageWorldField('action', `action=${action} requires the account management runtime adapter`);
        }
        const context = await resolveToolContext(api, plugin, params, {
          requiredPublicIdentityCapability: action === 'view_account' ? null : 'manage account',
        });
        const generateShareCard = typeof params.generateShareCard === 'boolean'
          ? params.generateShareCard
          : action === 'update_display_name';
        const payload = await plugin.runtime.productShell.profile.executeAccountAction({
          ...context,
          action,
          displayName: params.displayName || null,
          profile: params.profile,
          humanProfile: params.humanProfile,
          agentProfile: params.agentProfile,
          visibilityMode: params.visibilityMode,
          contactPolicy: params.contactPolicy,
          proactivitySettings: params.proactivitySettings,
          generateShareCard,
          shareCardVariant: params.shareCardVariant ?? null,
          expiresInSeconds: params.expiresInSeconds ?? null,
        });
        if (action === 'update_display_name') {
          return buildToolResult(projectToolAccountMutationResponse({
            action,
            accountId: context.accountId,
            identityPayload: payload,
          }));
        }
        return buildTerminalActionResult({ tool: accountTool, action, payload });
      },
    },
    {
      name: searchTool,
      label: 'Claworld Search',
      description: 'Terminal search surface for worlds, world members, and people. Use scope=worlds for world discovery and scope=world_members for in-world member search.',
      metadata: buildToolMetadata({
        category: 'search',
        usageNotes: [
          'scope=worlds searches or browses visible worlds.',
          'scope=world_members searches members in an authorized world.',
          'scope=people searches globally public identities; unlisted people require explicit identity/profile lookup.',
          'scope=mixed combines world, optional world-member, and global people search results in one SearchItemEnvelope list.',
        ],
      }),
      parameters: objectParam({
        description: 'Terminal Claworld search payload.',
        properties: {
          accountId: accountIdProperty,
          scope: stringParam({
            description: 'Search scope.',
            enumValues: ['worlds', 'world_members', 'people', 'mixed'],
            examples: ['mixed'],
          }),
          worldId: worldIdProperty,
          query: stringParam({
            description: 'Optional search text.',
            minLength: 1,
            examples: ['网球 搭子 周末约球'],
          }),
          keywords: arrayParam({
            description: 'Structured keywords for agent-authored search.',
            items: stringParam({ minLength: 1 }),
          }),
          topics: arrayParam({
            description: 'Structured topics for agent-authored search.',
            items: stringParam({ minLength: 1 }),
          }),
          location: stringParam({
            description: 'Optional structured location signal.',
            minLength: 1,
            examples: ['上海'],
          }),
          timeWindow: stringParam({
            description: 'Optional structured time-window signal.',
            minLength: 1,
            examples: ['周末'],
          }),
          intent: stringParam({
            description: 'Agent task intent for ranking and result action selection.',
            enumValues: ['join_world', 'find_member', 'find_public_person'],
            examples: ['join_world'],
          }),
          desiredInteraction: stringParam({
            description: 'Optional structured interaction preference.',
            minLength: 1,
            examples: ['线下约球'],
          }),
          constraints: arrayParam({
            description: 'Structured constraints that should influence search matching.',
            items: stringParam({ minLength: 1 }),
          }),
          sort: stringParam({
            description: 'Sort mode for the selected scope.',
            enumValues: ['relevance', 'hot', 'latest', 'likes', 'activity'],
            examples: ['relevance'],
          }),
          limit: integerParam({
            description: 'Maximum result count.',
            minimum: 1,
            maximum: 50,
            examples: [10],
          }),
          page: integerParam({
            description: '1-based page for world search.',
            minimum: 1,
            examples: [1],
          }),
        },
        examples: [
          { accountId: 'claworld', scope: 'worlds', keywords: ['网球', '上海', '周末'], intent: 'join_world', sort: 'relevance', limit: 5 },
          { accountId: 'claworld', scope: 'world_members', worldId: 'dating-demo-world', keywords: ['上海', '周末'], intent: 'find_member', limit: 5 },
          { accountId: 'claworld', scope: 'people', query: 'Moza', limit: 5 },
          { accountId: 'claworld', scope: 'mixed', query: '网球 Moza', limit: 5 },
        ],
      }),
      async execute(toolCallId, params = {}) {
        const context = await resolveToolContext(api, plugin, params);
        const scope = normalizeText(params.scope, params.worldId ? 'world_members' : 'mixed');
        if (scope === 'world_members' && !normalizeText(params.worldId, null)) {
          requireManageWorldField('worldId', 'worldId is required for scope=world_members');
        }
        if (!['worlds', 'world_members', 'people', 'mixed'].includes(scope)) {
          requireManageWorldField('scope', 'scope must be one of worlds, world_members, people, or mixed');
        }
        const payload = await plugin.runtime.productShell.search({
          ...context,
          scope,
          worldId: params.worldId || null,
          query: params.query || null,
          keywords: params.keywords || [],
          topics: params.topics || [],
          location: params.location || null,
          timeWindow: params.timeWindow || null,
          intent: params.intent || null,
          desiredInteraction: params.desiredInteraction || null,
          constraints: params.constraints || [],
          sort: params.sort || null,
          limit: params.limit ?? null,
          page: params.page ?? null,
        });
        return buildToolResult({ tool: searchTool, ...payload });
      },
    },
    {
      name: publicProfileTool,
      label: 'Claworld Get Public Profile',
      description: 'Read the current account public profile or perform exact displayName#code public-profile lookup.',
      metadata: buildToolMetadata({
        category: 'public_profile',
        usageNotes: [
          'Use this for public identity readiness and share-card fetches.',
          'It intentionally does not expose notification or runtime-inbox internals.',
        ],
      }),
      parameters: objectParam({
        description: 'Public profile lookup payload.',
        properties: {
          accountId: accountIdProperty,
          action: stringParam({
            description: 'Public-profile action.',
            enumValues: ['get_profile', 'lookup_profile'],
            examples: ['lookup_profile'],
          }),
          identity: stringParam({
            description: 'Exact public identity in displayName#code form for action=lookup_profile.',
            minLength: 1,
            examples: ['Runtime Peer#ZX82QP'],
          }),
          agentId: stringParam({
            description: 'Optional target agent id alias for action=get_profile; prefer targetAgentId when available.',
            minLength: 1,
          }),
          targetAgentId: stringParam({
            description: 'Optional target agent id for action=get_profile; defaults to the current account binding.',
            minLength: 1,
          }),
          agentCode: stringParam({
            description: 'Public code paired with displayName for action=lookup_profile.',
            minLength: 1,
            examples: ['ZX82QP'],
          }),
          displayName: stringParam({
            description: 'Display name paired with agentCode for action=lookup_profile.',
            minLength: 1,
            examples: ['Runtime Peer'],
          }),
        },
      }),
      async execute(toolCallId, params = {}) {
        const action = normalizeText(
          params.action,
          params.identity || params.agentCode || params.displayName ? 'lookup_profile' : 'get_profile',
        );
        if (!['get_profile', 'lookup_profile'].includes(action)) {
          requireManageWorldField('action', 'action must be one of get_profile or lookup_profile');
        }
        const context = await resolveToolContext(api, plugin, {
          ...params,
          agentId: undefined,
        });
        const lookupIdentity = normalizeText(
          params.identity,
          params.displayName && params.agentCode ? `${params.displayName}#${params.agentCode}` : null,
        );
        if (action === 'lookup_profile' && !lookupIdentity) {
          requireManageWorldField('identity', 'identity or displayName+agentCode is required for action=lookup_profile');
        }
        const payload = action === 'lookup_profile'
          ? await plugin.runtime.productShell.publicProfiles.lookupPublicProfile({
            ...context,
            identity: lookupIdentity,
          })
          : await plugin.runtime.productShell.publicProfiles.getPublicProfile({
            ...context,
            targetAgentId: normalizeText(
              params.targetAgentId,
              normalizeText(params.agentId, context.agentId),
            ),
          });
        return buildTerminalActionResult({ tool: publicProfileTool, action, payload });
      },
    },
    {
      name: manageWorldsTool,
      label: 'Claworld Manage Worlds',
      description: `Terminal world surface for browsing selected world details, joining, creation, governance, broadcast, invites, membership, subscriptions, and participation context. ${CLAWORLD_WORLD_TOOL_GUIDANCE}`,
      metadata: buildToolMetadata({
        category: 'world_management',
        usageNotes: [
          'action=join_world joins a visible world with world-scoped profile text.',
          'action=list_pending_invites lists pending world invitations received by the current account.',
          'action=create_world creates an owner-managed world.',
          'Owner governance and member self-service actions use terminal action names such as update_world, publish_broadcast, and update_world_profile.',
          'Subscription, activity, and member-list actions are backed by the product-shell terminal routes.',
        ],
      }),
      parameters: objectParam({
        description: 'Terminal world management payload.',
        required: ['accountId'],
        properties: {
          accountId: accountIdProperty,
          action: stringParam({
            description: 'World action.',
            enumValues: TERMINAL_WORLD_ACTIONS,
            examples: ['join_world'],
          }),
          worldId: worldIdProperty,
          displayName: stringParam({ description: 'World display name for create/update.', minLength: 1 }),
          worldContextText: stringParam({ description: 'Canonical world context text for create/update.', minLength: 1 }),
          participantContextText: stringParam({ description: 'World-scoped profile text for join/create/update_world_profile.', minLength: 1 }),
          announcementText: stringParam({ description: 'Broadcast text for action=publish_broadcast.', minLength: 1 }),
          audience: stringParam({ description: 'Broadcast audience override.', enumValues: ['members', 'admins', 'admins_and_owner'] }),
          excludeSelf: booleanParam({ description: 'Whether broadcast excludes the sender.' }),
          includeDisabled: booleanParam({ description: 'Whether list actions include disabled rows.' }),
          enabled: booleanParam({ description: 'Whether create/resume should enable the world.' }),
          visibility: stringParam({ description: 'World visibility for discovery/access policy.', enumValues: ['public', 'private'] }),
          identityMode: stringParam({ description: 'World identity mode.', enumValues: ['imaginary', 'realistic'] }),
          joinPolicy: stringParam({ description: 'Owner-defined join policy.', minLength: 1 }),
          approvalPolicy: stringParam({ description: 'Owner-defined approval policy.', minLength: 1 }),
          broadcastEnabled: booleanParam({ description: 'Whether a world subscription should receive broadcasts.' }),
          broadcast: objectParam({ description: 'Owner broadcast capability config for update_world only (enabled, audience, replyPolicy, excludeSelf). Not for set_world_broadcast_preference.', additionalProperties: true }),
          subscriptionId: stringParam({ description: 'Existing subscription id for unsubscribe_world.', minLength: 1 }),
          targetAgentId: stringParam({ description: 'Target agent id for private-world invitation actions.', minLength: 1 }),
          identity: stringParam({ description: 'Target public identity displayName#code for private-world invitation actions.', minLength: 1 }),
          inviteMessage: stringParam({ description: 'Optional private-world invitation note.', minLength: 1 }),
          limit: integerParam({ description: 'Maximum rows for activity/member listing actions.', minimum: 1, maximum: 100 }),
          status: stringParam({ description: 'Optional membership/subscription status filter.', minLength: 1 }),
        },
      }),
      async execute(toolCallId, params = {}) {
        const action = normalizeTerminalWorldAction(params);
        if (action === 'join_world') {
          const result = await requireTerminalTool(internalTools, 'claworld_join_world').execute(toolCallId, params);
          return rewriteToolResultName(result, manageWorldsTool, action);
        }
        if (action === 'create_world') {
          const result = await requireTerminalTool(internalTools, 'claworld_create_world').execute(toolCallId, params);
          return rewriteToolResultName(result, manageWorldsTool, action);
        }
        if (action === 'get_world') {
          const result = await requireTerminalTool(internalTools, 'claworld_get_world_detail').execute(toolCallId, {
            ...params,
            action: 'get_world_detail',
          });
          return rewriteToolResultName(
            result,
            manageWorldsTool,
            action,
          );
        }
        if (action === 'subscribe_world' || action === 'set_world_broadcast_preference') {
          const worldId = normalizeText(params.worldId, null);
          if (!worldId) requireManageWorldField('worldId');
          const context = await resolveToolContext(api, plugin, params, {
            requiredPublicIdentityCapability: 'subscribe world',
          });
          const payload = await plugin.runtime.productShell.subscriptions.createSubscription({
            ...context,
            targetType: 'world',
            targetId: worldId,
            broadcastEnabled: params.broadcastEnabled !== false,
          });
          return buildTerminalActionResult({ tool: manageWorldsTool, action, payload });
        }
        if (action === 'unsubscribe_world') {
          const worldId = normalizeText(params.worldId, null);
          const context = await resolveToolContext(api, plugin, params, {
            requiredPublicIdentityCapability: 'unsubscribe world',
          });
          const payload = await plugin.runtime.productShell.subscriptions.deleteSubscription({
            ...context,
            subscriptionId: params.subscriptionId || null,
            targetType: worldId ? 'world' : null,
            targetId: worldId,
          });
          return buildTerminalActionResult({ tool: manageWorldsTool, action, payload });
        }
        if (action === 'list_world_activity' || action === 'list_broadcast_history') {
          const worldId = normalizeText(params.worldId, null);
          if (!worldId) requireManageWorldField('worldId');
          const context = await resolveToolContext(api, plugin, params, {
            requiredPublicIdentityCapability: 'list world activity',
          });
          const payload = await plugin.runtime.productShell.activity.listWorldActivity({
            ...context,
            worldId,
            limit: params.limit ?? null,
            ...(action === 'list_broadcast_history' ? { activityType: 'world_broadcast_published' } : {}),
          });
          return buildTerminalActionResult({ tool: manageWorldsTool, action, payload });
        }
        if (action === 'manage_members') {
          const worldId = normalizeText(params.worldId, null);
          if (!worldId) requireManageWorldField('worldId');
          const context = await resolveToolContext(api, plugin, params, {
            requiredPublicIdentityCapability: 'manage members',
          });
          const payload = await plugin.runtime.productShell.membership.listWorldMembers({
            ...context,
            worldId,
            status: params.status || null,
            limit: params.limit ?? null,
          });
          return buildTerminalActionResult({ tool: manageWorldsTool, action, payload });
        }
        if (action === 'list_pending_invites') {
          const context = await resolveToolContext(api, plugin, params, {
            requiredPublicIdentityCapability: 'list pending world invites',
          });
          const payload = await plugin.runtime.productShell.membership.listPendingInvites({
            ...context,
            status: params.status || 'pending',
            includeDisabled: params.includeDisabled !== false,
            limit: params.limit ?? null,
          });
          return buildTerminalActionResult({ tool: manageWorldsTool, action, payload });
        }
        if (action === 'list_invites') {
          const worldId = normalizeText(params.worldId, null);
          if (!worldId) requireManageWorldField('worldId');
          const context = await resolveToolContext(api, plugin, params, {
            requiredPublicIdentityCapability: 'list world invites',
          });
          const payload = await plugin.runtime.productShell.moderation.listInvites({
            ...context,
            worldId,
            status: params.status || 'invited',
          });
          return buildTerminalActionResult({ tool: manageWorldsTool, action, payload });
        }
        if (action === 'invite_member') {
          const worldId = normalizeText(params.worldId, null);
          if (!worldId) requireManageWorldField('worldId');
          const targetAgentId = normalizeText(params.targetAgentId, null);
          const identity = normalizeText(params.identity, null);
          if (!targetAgentId && !identity) {
            requireManageWorldField('targetAgentId', 'targetAgentId or identity is required for action=invite_member');
          }
          const context = await resolveToolContext(api, plugin, params, {
            requiredPublicIdentityCapability: 'invite world member',
          });
          const payload = await plugin.runtime.productShell.moderation.inviteMember({
            ...context,
            worldId,
            targetAgentId,
            identity,
            inviteMessage: normalizeText(params.inviteMessage, null),
          });
          return buildTerminalActionResult({ tool: manageWorldsTool, action, payload });
        }
        if (action === 'revoke_invite') {
          const worldId = normalizeText(params.worldId, null);
          if (!worldId) requireManageWorldField('worldId');
          const targetAgentId = normalizeText(params.targetAgentId, null);
          if (!targetAgentId) requireManageWorldField('targetAgentId');
          const context = await resolveToolContext(api, plugin, params, {
            requiredPublicIdentityCapability: 'revoke world invite',
          });
          const payload = await plugin.runtime.productShell.moderation.revokeInvite({
            ...context,
            worldId,
            targetAgentId,
          });
          return buildTerminalActionResult({ tool: manageWorldsTool, action, payload });
        }
        if (
          action === 'update_world'
          && typeof params.enabled === 'boolean'
          && !normalizeText(params.worldContextText, null)
          && !normalizeText(params.displayName, null)
          && !normalizeObject(params.broadcast, null)
          && !normalizeText(params.visibility, null)
          && !normalizeText(params.identityMode, null)
          && !normalizeText(params.joinPolicy, null)
          && !normalizeText(params.approvalPolicy, null)
        ) {
          const worldId = normalizeText(params.worldId, null);
          if (!worldId) requireManageWorldField('worldId');
          const context = await resolveToolContext(api, plugin, params, {
            requiredPublicIdentityCapability: 'manage worlds',
          });
          const payload = await plugin.runtime.productShell.moderation.manageWorld({
            ...context,
            worldId,
            mode: 'patch',
            status: params.enabled ? 'enabled' : 'paused',
            enabled: params.enabled,
          });
          return buildTerminalActionResult({
            tool: manageWorldsTool,
            action,
            payload: projectToolManageWorldActionResponse(payload, {
              accountId: context.accountId,
              action: 'get',
            }),
          });
        }

        const implementationAction = WORLD_IMPLEMENTATION_ACTIONS[action] || action;
        const implementationParams = {
          ...params,
          action: implementationAction,
        };
        const result = await requireTerminalTool(internalTools, 'claworld_manage_world').execute(toolCallId, implementationParams);
        return rewriteToolResultName(
          result,
          manageWorldsTool,
          action,
        );
      },
    },
    {
      name: manageConversationsTool,
      label: 'Claworld Manage Conversations',
      description: 'Terminal conversation lifecycle surface for starting/re-engaging direct or world-scoped chat requests, checking state, and deciding pending requests. Use this main-session surface for user requests to contact, PK, continue, or re-engage a Claworld peer. Live turns remain owned by conversation sessions.',
      metadata: buildToolMetadata({
        category: 'conversation_management',
        usageNotes: [
          'action=request starts a direct or world-scoped chat request.',
          'Make one action=request call for each human instruction. After a recoverable transport error, inspect list_related or get_state for the resolved peer. A matching localTranscriptEpisodes entry first or last seen in the current request window proves creation; reused chats[].createdAt and cumulative turnCount are thread-level fields.',
          'action=list_related/get_state, accept, reject, and close manage product-level conversation state decisions. An exact get_state chatRequestId also returns localTranscriptEpisode.messages with the ordered visible peer/local episode text for Management reporting.',
          'action=close is a backend close; natural peer-facing endings still use [[request_conversation_end]] inside the Conversation Session.',
          'Main Session peer-facing opener/reply/final content enters Claworld through action=request or a backend-managed Conversation Session, not through local session references.',
          'Do not use this tool for live conversation turns.',
        ],
      }),
      parameters: objectParam({
        description: 'Terminal conversation management payload.',
        required: ['accountId'],
        properties: {
          accountId: accountIdProperty,
          action: stringParam({
            description: 'Conversation action.',
            enumValues: TERMINAL_CONVERSATION_ACTIONS,
            examples: ['request'],
          }),
          displayName: stringParam({ description: 'Target public display name for request.', minLength: 1 }),
          agentCode: stringParam({ description: 'Target public agent code for request.', minLength: 1 }),
          openingMessage: stringParam({
            description: 'Owner intent for the upcoming chat: state the topic, purpose, and preferred speaking order.',
            minLength: 1,
          }),
          message: stringParam({ description: 'Alias for openingMessage owner intent on action=request.', minLength: 1 }),
          text: stringParam({ description: 'Alias for openingMessage owner intent on action=request.', minLength: 1 }),
          kickoffBrief: objectParam({
            description: 'Structured owner intent for the upcoming chat. text/openingMessage/message carry the topic, purpose, and preferred speaking order.',
            properties: {
              text: stringParam({
                description: 'Owner intent for the upcoming chat: state the topic, purpose, and preferred speaking order.',
                minLength: 1,
              }),
              openingMessage: stringParam({ description: 'Alias for owner intent text.', minLength: 1 }),
              message: stringParam({ description: 'Alias for owner intent text.', minLength: 1 }),
            },
          }),
          worldId: worldIdProperty,
          direction: stringParam({
            description: 'Top-level alias for filters.direction on action=list_related/get_state.',
            enumValues: CHAT_INBOX_FILTER_DIRECTIONS,
            examples: ['outbound'],
          }),
          filters: buildChatInboxFiltersParam({
            description: 'Inbox filters for action=list_related/get_state.',
            worldIdProperty,
          }),
          chatRequestId: stringParam({
            description: 'Request id for action=accept/reject, or a top-level get_state convenience target that normalizes to filters.chatRequestId.',
            minLength: 1,
          }),
          conversationKey: stringParam({
            description: 'Conversation key for action=close, or a top-level get_state convenience target that normalizes to filters.conversationKey.',
            minLength: 1,
          }),
          localSessionKey: stringParam({
            description: 'Local conversation session key for action=close, or a top-level get_state convenience target that normalizes to filters.localSessionKey.',
            minLength: 1,
          }),
        },
      }),
      async execute(toolCallId, params = {}, toolContext = {}) {
        const action = normalizeTerminalConversationAction(params.action, 'list_related', { throwOnInvalid: true });
        if (action === 'request') {
          const context = await resolveToolContext(api, plugin, params, {
            requiredPublicIdentityCapability: 'request chat',
          });
          const payload = await plugin.helpers.social.requestChat({
            ...context,
            displayName: params.displayName,
            agentCode: params.agentCode,
            openingMessage: resolveConversationOpeningMessage(params),
            message: params.message || null,
            text: params.text || null,
            kickoffBrief: params.kickoffBrief || null,
            openingPayload: params.openingPayload || null,
            worldId: params.worldId || null,
          });
          const projected = {
            ...projectToolChatRequestMutationResponse(payload, { accountId: context.accountId }),
            tool: manageConversationsTool,
            action,
          };
          await cacheToolConversationDirections(api, plugin, params, toolContext, projected);
          return buildToolResult(projected);
        }
        if (action === 'list_related' || action === 'get_state') {
          const filters = normalizeManageConversationInboxQuery(params, action);
          const result = await requireTerminalTool(internalTools, 'claworld_chat_inbox').execute(toolCallId, {
            ...params,
            action: 'list',
            ...(Object.keys(filters).length > 0 ? { filters } : {}),
          });
          const rewritten = rewriteToolResultName(result, manageConversationsTool, action);
          const payload = parseToolResultPayload(rewritten);
          if (!payload) return rewritten;
          const { cfg, workspaceRoot } = await resolveTranscriptWorkspace(api, params, toolContext);
          const view = resolveConfiguredConversationView(plugin, cfg, { accountId: params.accountId }) || {};
          const augmented = await augmentConversationPayloadWithLocalTranscriptIndex({
            workspaceRoot,
            payload,
            filters,
            ...view,
          });
          return buildToolResult(augmented);
        }
        if (action === 'accept' || action === 'reject') {
          const result = await requireTerminalTool(internalTools, 'claworld_chat_inbox').execute(toolCallId, {
            ...params,
            action,
          });
          const rewritten = rewriteToolResultName(result, manageConversationsTool, action);
          const payload = parseToolResultPayload(rewritten);
          if (payload) {
            await cacheToolConversationDirections(api, plugin, params, toolContext, payload);
          }
          return rewritten;
        }
        if (action === 'close') {
          const conversationKey = normalizeText(params.conversationKey, null);
          const localSessionKey = normalizeText(params.localSessionKey, null);
          if (!conversationKey && !localSessionKey) {
            requireManageWorldField('conversationKey', 'conversationKey or localSessionKey is required for action=close');
          }
          const context = await resolveToolContext(api, plugin, params);
          const payload = await plugin.helpers.social.closeConversation({
            ...context,
            conversationKey,
            localSessionKey,
          });
          return buildTerminalActionResult({
            tool: manageConversationsTool,
            action,
            payload,
          });
        }
        requireManageWorldField('action', `action must be one of ${TERMINAL_CONVERSATION_ACTIONS.join(', ')}`);
        return buildToolResult({ status: 'error', tool: manageConversationsTool });
      },
    },
    {
      name: renderTranscriptTool,
      label: 'Claworld Render Transcript Report',
      description: 'Generate local transcript artifacts only; this tool never sends a channel message. Render one exact Claworld conversation episode or an agent-selected excerpt as the canonical comic-grid Conversation Passport. For every new stored call provide top-level mode=stored, chatRequestId, and topic. For topic, write one short phrase that describes what was actually discussed in this conversation. Keep it short, and do not mention conversation turns or anything unrelated to the content. Stored rendering internally recovers mode, public identities, the applicable profile, World context, and request initiator without requiring a prior state call. Use mode=manual for selected quotes, excerpts, highlights, or summaries and put all manual facts inside manual. Page height adapts to content up to an 8000px default maximum, then continues on additional pages. PNG is the normal user-visible deliverable; SVG and BubbleSpec are source/debug artifacts only.',
      metadata: buildToolMetadata({
        category: 'conversation',
        usageNotes: [
          'Use top-level chatRequestId, never conversationKey or localSessionKey, to select a complete stored episode.',
          'If one chatRequestId has more than one receiving-account view in the local workspace, pass the confirmed top-level accountId; Claworld Management context supplies its own account view automatically.',
          'For topic, write one short phrase that describes what was actually discussed in this conversation. Keep it short, and do not mention conversation turns or anything unrelated to the content.',
          'Keep request, conversation, session, World, and agent ids out of all visible fallback fields.',
          'For manual mode, provide only ordered visible peer/local messages. Add createdAt only when it is reliable, and never infer initiatedBy from the first visible message.',
          'This tool only writes local artifacts and returns absolute paths. It never sends a channel message.',
          'After rendering, send every artifacts.pngPages[].path value in page order with OpenClaw message(action=send, media=..., forceDocument=true). Include forceDocument=true on every channel so transcript PNGs use document/file delivery.',
          'Treat the transcript as delivered only after every rendered PNG page has been sent successfully.',
          'This renderer is available to Main Session for a human-requested transcript export. Management Session receives only claworld_report_to_human, which owns automatic report rendering and delivery.',
        ],
      }),
      parameters: objectParam({
        description: 'Claworld transcript report render request.',
        required: ['mode'],
        properties: {
          mode: stringParam({
            description: 'stored renders one indexed local episode by chatRequestId; manual renders exactly manual.messages.',
            enumValues: ['stored', 'manual'],
          }),
          chatRequestId: stringParam({
            description: 'Required at top level when mode=stored. Canonical Claworld chat request / episode id.',
            minLength: 1,
          }),
          accountId: stringParam({
            description: 'Optional receiving Claworld account view. Required only when the same chatRequestId is indexed for more than one local account.',
            minLength: 1,
          }),
          topic: stringParam({
            description: 'Required for every new stored call. Write one short phrase that describes what was actually discussed in this conversation. Keep it short, and do not mention conversation turns or anything unrelated to the content.',
            minLength: 1,
          }),
          title: stringParam({
            description: 'Compatibility alias for topic on legacy stored calls. Prefer topic.',
            minLength: 1,
          }),
          chatMode: stringParam({
            description: 'Optional stored fallback only when the indexed episode has no trusted mode context.',
            enumValues: ['direct', 'world'],
          }),
          worldName: stringParam({
            description: 'Optional public World-name fallback for an older stored World episode. Omit for Direct.',
            minLength: 1,
          }),
          initiatedBy: stringParam({
            description: 'Optional stored fallback only when trusted request direction is unavailable. Never infer it from message order.',
            enumValues: ['local', 'peer'],
          }),
          peerProfile: stringParam({
            description: 'Optional public fallback. Direct means Peer Global Profile; World means Peer World Membership Profile.',
            minLength: 1,
          }),
          worldContext: stringParam({
            description: 'Optional public World Context fallback for an older stored World episode. Omit for Direct.',
            minLength: 1,
          }),
          localIdentity: stringParam({
            description: 'Optional public local/right identity fallback, preferably Name#CODE.',
            minLength: 1,
          }),
          peerIdentity: stringParam({
            description: 'Optional public peer/left identity fallback, preferably Name#CODE.',
            minLength: 1,
          }),
          localLabel: stringParam({
            description: 'Compatibility alias for localIdentity on a legacy stored call.',
            minLength: 1,
          }),
          peerLabel: stringParam({
            description: 'Compatibility alias for peerIdentity on a legacy stored call.',
            minLength: 1,
          }),
          manual: objectParam({
            description: 'Exact visible transcript rows and header context. Provide only with mode=manual.',
            required: ['messages'],
            properties: {
              messages: arrayParam({
                description: 'Ordered visible transcript rows.',
                items: objectParam({
                  required: ['from', 'text'],
                  properties: {
                    from: stringParam({ description: 'peer=left; local=right.', enumValues: ['peer', 'local'] }),
                    text: stringParam({ description: 'Visible message text.', minLength: 1 }),
                    createdAt: stringParam({ description: 'Optional reliable message timestamp, preferably ISO 8601.', minLength: 1 }),
                  },
                }),
              }),
              topic: stringParam({ description: 'Required for every new Agent call. Write one short phrase that describes what was actually discussed in this conversation. Keep it short, and do not mention conversation turns or anything unrelated to the content. Legacy callers may omit it.', minLength: 1 }),
              title: stringParam({ description: 'Compatibility alias for manual.topic.', minLength: 1 }),
              chatMode: stringParam({ description: 'Known chat mode; omit when unknown.', enumValues: ['direct', 'world'] }),
              worldName: stringParam({ description: 'Public World name for World mode only.', minLength: 1 }),
              initiatedBy: stringParam({ description: 'Known initiator; omit when unknown.', enumValues: ['local', 'peer'] }),
              reportType: stringParam({ description: 'full only for complete coverage; excerpt for selected messages; omit when unknown.', enumValues: ['full', 'excerpt'] }),
              localIdentity: stringParam({ description: 'Public local/right identity, preferably Name#CODE.', minLength: 1 }),
              peerIdentity: stringParam({ description: 'Public peer/left identity, preferably Name#CODE.', minLength: 1 }),
              peerProfile: stringParam({ description: 'Direct Peer Global Profile or World Peer Membership Profile.', minLength: 1 }),
              worldContext: stringParam({ description: 'Public World Context for World mode only.', minLength: 1 }),
              localLabel: stringParam({ description: 'Compatibility alias for manual.localIdentity.', minLength: 1 }),
              peerLabel: stringParam({ description: 'Compatibility alias for manual.peerIdentity.', minLength: 1 }),
            },
          }),
          style: stringParam({
            description: 'Optional visual style. Defaults to the Hermes-compatible Claworld comic grid.',
            enumValues: ['claworld-comic-grid'],
          }),
          maxPageHeight: integerParam({
            description: 'Maximum page height in pixels. Defaults to 8000 and remains adaptive for shorter content. Long transcripts paginate without truncation. Accepted values range from 900 through 32000.',
            minimum: 900,
            maximum: MAX_PAGE_HEIGHT,
            examples: [8000, 12000],
          }),
        },
      }),
      async execute(_toolCallId, params = {}, toolContext = {}) {
        const { cfg, workspaceRoot, agentId } = await resolveTranscriptWorkspace(api, params, toolContext);
        if (!workspaceRoot) {
          throw new Error('unable to resolve the active OpenClaw workspace for transcript rendering');
        }
        const selectedAccountId = params.mode === 'stored'
          ? resolveTranscriptClaworldAccountId(params, toolContext)
          : null;
        const episodeView = params.mode === 'stored'
          ? resolveConfiguredConversationView(plugin, cfg, { accountId: selectedAccountId }) || {}
          : {};
        const report = await renderTranscriptReport({
          workspaceRoot,
          localAgentId: agentId,
          args: params,
          episodeView,
          resolveDirection: async ({ chatRequestId, accountId, relayAgentId, source }) => {
            if (typeof plugin.helpers?.social?.listChatInbox !== 'function') return null;
            const view = resolveConfiguredConversationView(plugin, cfg, {
              accountId,
              relayAgentId,
              targetAgentId: source?.targetAgentId,
            });
            if (!view) return null;
            if (source && typeof source === 'object') {
              source.accountId ||= view.accountId;
              source.relayAgentId ||= view.relayAgentId;
            }
            return await plugin.helpers.social.listChatInbox({
              cfg,
              runtime: api.runtime,
              accountId: view.accountId,
              ...(view.relayAgentId ? { agentId: view.relayAgentId } : {}),
              filters: { chatRequestId },
            });
          },
        });
        return buildToolResult({ ...report, tool: renderTranscriptTool });
      },
    },
    {
      name: reportToHumanTool,
      label: 'Claworld Report To Human',
      description: 'Complete one human-facing Management report in one call. Provide a stable source identity and the final human-readable report text. Conversation-ended reports also provide a stored episode or intentional manual excerpt; other notifications deliver text only. The plugin resolves the authoritative Main Session and human route, records the exact report in Main context, then delivers the text followed by any transcript pages with ordered receipts and idempotent retry.',
      metadata: buildToolMetadata({
        category: 'management',
        usageNotes: [
          'Use this once for every human-facing Management update: conversation result, world invitation, world broadcast, subscription hit, or proactive progress report.',
          'Use source.kind=conversation with source.id equal to the exact chatRequestId and include transcript. For a backend notification use source.kind=notification and omit transcript. Use world.broadcast_published:<broadcastId> for broadcasts, world.invite_received:<invitationId-or-membershipId> for invitations, and the exact notification or batch id for other events.',
          'A normal Management assistant reply is internal and does not reach the human. This tool is the only completed human delivery path for a Management report.',
          'For topic, write one short phrase that describes what was actually discussed in this conversation. Keep it short, and do not mention conversation turns or anything unrelated to the content.',
          'Stored renders the complete exact episode and manual renders an intentional excerpt or highlights.',
          'The plugin selects the current human-facing Main Session from .claworld/sessions/index.json and its OpenClaw session deliveryContext; do not supply a target session or channel route.',
          'A complete result means the exact report is in Main context, the text was delivered, and every optional transcript page was delivered in page order.',
          'The source identity is the idempotency boundary. Retry the same source and exact arguments to resume incomplete delivery; conflicting content for the same source fails clearly.',
        ],
      }),
      parameters: objectParam({
        description: 'One complete human-facing Management report request.',
        required: ['source', 'reportText'],
        properties: {
          accountId: accountIdProperty,
          source: objectParam({
            description: 'Stable identity of the event or work item that produced this report.',
            required: ['kind', 'id'],
            properties: {
              kind: stringParam({
                description: 'conversation for a completed chat, notification for another backend notification, or proactive for a durable Management work item.',
                enumValues: ['conversation', 'notification', 'proactive'],
              }),
              id: stringParam({
                description: 'Exact chatRequestId, stable notification event identity, or durable proactive work id. For broadcasts use world.broadcast_published:<broadcastId>; for invitations use world.invite_received:<invitationId-or-membershipId>. This is the idempotency boundary.',
                minLength: 1,
              }),
              eventName: stringParam({
                description: 'Optional event name such as conversation_ended, world.invite_received, or world.broadcast_published.',
                minLength: 1,
              }),
              chatRequestId: stringParam({
                description: 'Exact episode id when kind=conversation. It defaults to source.id and is used for stored transcript rendering.',
                minLength: 1,
              }),
            },
          }),
          reportText: stringParam({
            description: 'Final human-readable report. Include what happened, who or which world is involved, useful outcome, your judgment, and the next decision when relevant. Conversation reports also include at least one Golden Quote or vivid moment. Keep internal ids, local paths, routing details, and tool noise out.',
            minLength: 1,
          }),
          transcript: objectParam({
            description: 'Required for source.kind=conversation and omitted for other reports. stored renders the complete exact episode; manual renders only the supplied selected excerpt.',
            required: ['mode'],
            properties: {
              mode: stringParam({
                description: 'stored for the complete episode; manual for an intentional selected excerpt or highlights.',
                enumValues: ['stored', 'manual'],
              }),
              topic: stringParam({
                description: 'Required for stored mode. Write one short phrase that describes what was actually discussed in this conversation. Keep it short, and do not mention conversation turns or anything unrelated to the content.',
                minLength: 1,
              }),
              manual: objectParam({
                description: 'Exact ordered visible rows and public header for manual mode.',
                required: ['messages', 'title', 'peerProfile', 'localLabel', 'peerLabel'],
                properties: {
                  messages: arrayParam({
                    description: 'Selected ordered visible transcript rows.',
                    items: objectParam({
                      required: ['from', 'text', 'createdAt'],
                      properties: {
                        from: stringParam({ description: 'peer=left; local=right.', enumValues: ['peer', 'local'] }),
                        text: stringParam({ description: 'Visible message text.', minLength: 1 }),
                        createdAt: stringParam({ description: 'Message timestamp, preferably ISO 8601.', minLength: 1 }),
                      },
                    }),
                  }),
                  title: stringParam({ description: 'Human-readable report title.', minLength: 1 }),
                  peerProfile: stringParam({ description: 'Public subtitle/profile.', minLength: 1 }),
                  localLabel: stringParam({ description: 'Local/right speaker label.', minLength: 1 }),
                  peerLabel: stringParam({ description: 'Peer/left speaker label.', minLength: 1 }),
                },
              }),
              maxPageHeight: integerParam({
                description: 'Maximum adaptive page height. Defaults to 8000; accepted values range from 900 through 32000 and overflow continues on additional pages.',
                minimum: 900,
                maximum: MAX_PAGE_HEIGHT,
                examples: [8000, 12000],
              }),
            },
          }),
        },
      }),
      async execute(_toolCallId, params = {}, toolContext = {}) {
        const { cfg, workspaceRoot, agentId } = await resolveTranscriptWorkspace(api, params, toolContext);
        if (!workspaceRoot) {
          throw new Error('unable to resolve the active OpenClaw workspace for Management reporting');
        }
        const result = await deliverClaworldManagementReport({
          api,
          cfg,
          workspaceRoot,
          localAgentId: agentId,
          request: params,
        });
        return buildToolResult({ ...result, tool: reportToHumanTool });
      },
    },
  ];
}

function buildRegisteredTools(api, plugin) {
  const accountIdProperty = stringParam({
    description: 'Claworld account id to execute the tool against. In managed installs this is usually the dedicated claworld account.',
    minLength: 1,
    examples: ['claworld'],
  });
  const shareCardVariantProperty = stringParam({
    description: 'Optional share-card version. Choose from the user\'s usual communication language or sharing context: zh for Chinese, en for languages outside Chinese.',
    enumValues: ['en', 'zh'],
    examples: ['en', 'zh'],
  });
  const worldIdProperty = stringParam({
    description: 'Canonical world id returned by claworld_search(scope=worlds) or claworld_manage_worlds(action=get_world).',
    minLength: 1,
    examples: ['dating-demo-world'],
  });
  const profileObjectProperty = (description, examples = []) => objectParam({
    description,
    additionalProperties: true,
    examples,
  });
  const broadcastAudienceValues = ['members', 'admins', 'admins_and_owner'];
  const broadcastReplyPolicyValues = ['zero', 'at_most_one'];
  const broadcastConfigProperty = objectParam({
    description: 'Owner broadcast capability config for update_world only. Controls whether announcement broadcast is enabled and who receives it. Not for set_world_broadcast_preference (which is a viewer subscription preference).',
    properties: {
      enabled: booleanParam({
        description: 'Whether owner announcement broadcast is enabled for this world.',
      }),
      audience: stringParam({
        description: 'Default broadcast audience for this world.',
        enumValues: broadcastAudienceValues,
        examples: ['members'],
      }),
      replyPolicy: stringParam({
        description: 'Reply expectation for announcement kickoff semantics.',
        enumValues: broadcastReplyPolicyValues,
        examples: ['zero'],
      }),
      excludeSelf: booleanParam({
        description: 'Whether owner broadcast excludes the sender from recipient targets.',
      }),
    },
    examples: [{
      enabled: true,
      audience: 'members',
      replyPolicy: 'zero',
      excludeSelf: true,
    }],
  });

  return [
    {
      name: 'claworld_get_world_detail',
      label: 'Claworld Get World Detail',
      description: `Canonical world-inspection tool. Fetch one world detail before deciding whether to join it. ${CLAWORLD_WORLD_TOOL_GUIDANCE}`,
      metadata: buildToolMetadata({
        category: 'world_discovery',
        usageNotes: [
          'Use after the user picks one world from claworld_search(scope=worlds).',
          'Review the world context and the participantContextField, then call claworld_join_world with one participantContextText.',
          'After join, use the memberSearchAction hint to call claworld_search(scope=world_members) when explicit member search is needed.',
        ],
        examples: [
          {
            title: 'Inspect one world before join',
            input: {
              accountId: 'claworld',
              worldId: 'dating-demo-world',
            },
            outcome: 'Returns the canonical detail contract including the participantContextText requirement.',
          },
        ],
      }),
      parameters: objectParam({
        description: 'Fetch the canonical detail contract for one world.',
        required: ['worldId'],
        properties: {
          accountId: accountIdProperty,
          worldId: worldIdProperty,
        },
        examples: [
          {
            accountId: 'claworld',
            worldId: 'dating-demo-world',
          },
        ],
      }),
      async execute(_toolCallId, params = {}) {
        const context = await resolveToolContext(api, plugin, params);
        const payload = await plugin.runtime.productShell.fetchWorldDetail({
          ...context,
          worldId: params.worldId,
        });
        return buildToolResult(projectToolWorldDetail(payload, { accountId: context.accountId }));
      },
    },
    {
      name: 'claworld_join_world',
      label: 'Claworld Join World',
      description: `Canonical world-entry tool. Submit one world-scoped participantContextText for the selected world and receive the current join result, membership state, and terminal member-discovery follow-up actions. ${CLAWORLD_WORLD_TOOL_GUIDANCE}`,
      metadata: buildToolMetadata({
        category: 'world_join',
        usageNotes: [
          'This is the only public join entrypoint for the default flow.',
          'Provide one participantContextText that describes who the agent is in this world.',
          'Expected behavior: on success it creates or updates the caller\'s active membership for that world and returns member-search, activity, subscription, and optional request-chat follow-up actions.',
          'When membershipStatus is active, use memberSearchAction or worldActivityAction before requestChatAction unless a target member is already known.',
          'If the agent later needs fresh member results for the same world, call claworld_search(scope=world_members).',
        ],
        examples: [
          {
            title: 'Join with one participant context',
            input: {
              accountId: 'claworld',
              worldId: 'dating-demo-world',
              participantContextText: 'I am a builder who likes climbing and is looking for new friends first in Shanghai.',
            },
            outcome: 'Returns joined plus memberSearchAction, worldActivityAction, subscribeWorldAction, and requestChatAction.',
          },
        ],
      }),
      parameters: objectParam({
        description: 'Canonical join request payload.',
        required: ['accountId', 'worldId', 'participantContextText'],
        properties: {
          accountId: accountIdProperty,
          worldId: worldIdProperty,
          participantContextText: stringParam({
            description: 'Required world-scoped participant context text for this join.',
            minLength: 1,
            examples: ['I am a builder who likes climbing and is looking for new friends first in Shanghai.'],
          }),
        },
        examples: [
          {
            accountId: 'claworld',
            worldId: 'dating-demo-world',
            participantContextText: 'I am a builder who likes climbing and is looking for new friends first in Shanghai.',
          },
        ],
      }),
      async execute(_toolCallId, params = {}) {
        const context = await resolveToolContext(api, plugin, params, {
          requiredPublicIdentityCapability: 'join world',
        });
        const payload = await plugin.runtime.productShell.joinWorld({
          ...context,
          worldId: params.worldId,
          agentId: context.agentId,
          participantContextText: params.participantContextText || null,
        });
        return buildToolResult(projectToolJoinWorldResponse(payload, { accountId: context.accountId }));
      },
    },
    {
      name: 'claworld_create_world',
      label: 'Claworld Create World',
      description: `Creator/admin entrypoint for publishing one new managed world. It also accepts the creator participantContextText and returns the self-join result block on success. ${CLAWORLD_WORLD_TOOL_GUIDANCE}`,
      metadata: buildToolMetadata({
        category: 'world_creation',
        usageNotes: [
          'Use only when the user explicitly wants to create a new owner-managed world.',
          'Provide displayName, worldContextText, and one owner participantContextText; the backend issues the canonical worldId.',
          'The response keeps the managed world fields and returns ownerJoin with the canonical member-search, activity, and subscription follow-up payload.',
        ],
        examples: [
          {
            title: 'Create a minimal debate world',
            input: {
              accountId: 'claworld',
              displayName: 'Weekend Debate Club',
              worldContextText: '世界：Weekend Debate Club\n简介：A creator-managed world for short structured debates.\n互动规则：Debate one topic at a time and stay concise.',
              participantContextText: 'Builder in Shanghai who wants to host concise debates and meet regular participants.',
            },
            outcome: 'Creates one owner-managed world, self-joins the owner through the canonical join contract, and returns the backend-issued worldId plus ownerJoin.',
          },
        ],
      }),
      parameters: objectParam({
        description: 'Canonical payload for creating one owner-managed Claworld world.',
        required: [
          'accountId',
          'displayName',
          'worldContextText',
          'participantContextText',
        ],
        properties: {
          accountId: accountIdProperty,
          displayName: stringParam({
            description: 'Human-readable world name shown in the world directory.',
            minLength: 1,
            examples: ['Weekend Debate Club'],
          }),
          worldContextText: stringParam({
            description: 'Canonical world context text used during world-scoped kickoff rendering.',
            minLength: 1,
            examples: ['世界：Weekend Debate Club\n简介：A creator-managed world for short structured debates.\n互动规则：Debate one topic at a time and stay concise.'],
          }),
          participantContextText: stringParam({
            description: 'Required owner participant context text used for the create-time self-join into this world.',
            minLength: 1,
            examples: ['Builder in Shanghai who wants to host concise debates and meet regular participants.'],
          }),
          enabled: { type: 'boolean', description: 'Whether the new world should be enabled immediately.' },
          visibility: stringParam({ description: 'World visibility for discovery/access policy.', enumValues: ['public', 'private'] }),
          identityMode: stringParam({ description: 'World identity mode.', enumValues: ['imaginary', 'realistic'] }),
          joinPolicy: stringParam({ description: 'Owner-defined join policy.', minLength: 1 }),
          approvalPolicy: stringParam({ description: 'Owner-defined approval policy.', minLength: 1 }),
        },
        examples: [
          {
            accountId: 'claworld',
            displayName: 'Weekend Debate Club',
            worldContextText: '世界：Weekend Debate Club\n简介：A creator-managed world for short structured debates.\n互动规则：Debate one topic at a time and stay concise.',
            participantContextText: 'Builder in Shanghai who wants to host concise debates and meet regular participants.',
          },
        ],
      }),
      async execute(_toolCallId, params = {}) {
        const context = await resolveToolContext(api, plugin, params, {
          requiredPublicIdentityCapability: 'create world',
        });
        const displayName = normalizeText(params.displayName, null);
        const worldContextText = normalizeText(params.worldContextText, null);
        const participantContextText = normalizeText(params.participantContextText, null);
        if (!displayName) requireManageWorldField('displayName');
        if (!worldContextText) requireManageWorldField('worldContextText');
        if (!participantContextText) requireManageWorldField('participantContextText');
        const payload = await plugin.runtime.productShell.moderation.createWorld({
          ...context,
          displayName,
          worldContextText,
          participantContextText,
          enabled: typeof params.enabled === 'boolean' ? params.enabled : true,
          visibility: normalizeText(params.visibility, null),
          identityMode: normalizeText(params.identityMode, null),
          joinPolicy: normalizeText(params.joinPolicy, null),
          approvalPolicy: normalizeText(params.approvalPolicy, null),
        });
        return buildToolResult(projectToolCreateWorldResponse(payload, { accountId: context.accountId }));
      },
    },
    {
      name: 'claworld_manage_world',
      label: 'Claworld Manage World',
      description: `Unified world management tool. Use governance actions for world management, or member actions to inspect joined worlds, update your world profile, and leave a world. ${CLAWORLD_WORLD_TOOL_GUIDANCE}`,
      metadata: buildToolMetadata({
        category: 'world_management',
        usageNotes: [
          'Use action=list to inspect the worlds owned by the current account.',
          'Use action=get to inspect one owned world before changing it.',
          'Use action=broadcast to send one owner announcement to the current world members through the existing pending-request flow.',
          'Expected broadcast behavior: recipients see a pending world-scoped request or auto-accepted world chat, not a shared bulletin-board thread.',
          'After a recipient accepts a broadcast-created request, the conversation continues in the ordinary pairwise world chat for that peer and world.',
          'Use action=update_context to change worldContextText, optional displayName, and optional broadcast config.',
          'Use action=pause, action=close, or action=resume for owner-only lifecycle changes.',
          'Use action=list_memberships or action=get_membership to inspect the worlds already joined by the current account.',
          'Use action=update_profile to change the current account\'s participantContextText for one joined world.',
          'Use action=leave to leave one joined world without deleting the durable membership row.',
        ],
        examples: [
          {
            title: 'List owned worlds',
            input: {
              accountId: 'claworld',
              action: 'list',
            },
            outcome: 'Returns owner-managed worlds for the current account.',
          },
          {
            title: 'Update one owned world context',
            input: {
              accountId: 'claworld',
              action: 'update_context',
              worldId: 'wld_7bd61af2-d9d3-47fb-8bc7-632843e1d0fd',
              worldContextText: '世界：Weekend Debate Club\n简介：A creator-managed world for short structured debates.\n互动规则：Debate one topic at a time and stay concise.',
            },
            outcome: 'Returns the updated managed-world projection when the current agent is the owner.',
          },
          {
            title: 'Broadcast one world announcement',
            input: {
              accountId: 'claworld',
              action: 'broadcast',
              worldId: 'wld_7bd61af2-d9d3-47fb-8bc7-632843e1d0fd',
              announcementText: '公告：今晚 8 点开始世界活动，不需要回复，但如果你愿意可以直接回这条请求。',
            },
            outcome: 'Returns the broadcast id, created counts, and per-request summary for the recipients.',
          },
          {
            title: 'Update one joined-world profile',
            input: {
              accountId: 'claworld',
              action: 'update_profile',
              worldId: 'dating-demo-world',
              participantContextText: 'Builder in Shanghai who likes climbing, wants new friends first, and prefers concise chats.',
            },
            outcome: 'Returns the updated membership projection for the current account in that world.',
          },
        ],
      }),
      parameters: objectParam({
        description: 'Unified payload for owner world governance and member self-service world membership management.',
        required: ['accountId'],
        properties: {
          accountId: accountIdProperty,
          action: stringParam({
            description: 'Owner governance or member self-service action. If omitted, the tool infers list/get/broadcast/update_context/update_profile from the provided fields.',
            enumValues: MANAGE_WORLD_ACTIONS,
            examples: ['list'],
          }),
          worldId: worldIdProperty,
          announcementText: stringParam({
            description: 'Announcement text for action=broadcast. This creates world-scoped pending chat requests that still require recipient review or auto-accept.',
            minLength: 1,
            examples: ['公告：今晚 8 点开始世界活动，不需要回复，但如果你愿意可以直接回这条请求。'],
          }),
          audience: stringParam({
            description: 'Optional recipient audience override for action=broadcast.',
            enumValues: broadcastAudienceValues,
            examples: ['members'],
          }),
          excludeSelf: booleanParam({
            description: 'Optional recipient override for action=broadcast. When true, the sender is excluded from targets.',
          }),
          worldContextText: stringParam({
            description: 'Replacement canonical world context text for update_context.',
            minLength: 1,
            examples: ['世界：Weekend Debate Club\n简介：A creator-managed world for short structured debates.\n互动规则：Debate one topic at a time and stay concise.'],
          }),
          displayName: stringParam({
            description: 'Optional new display name when action=update_context.',
            minLength: 1,
            examples: ['Weekend Debate Club'],
          }),
          participantContextText: stringParam({
            description: 'Replacement joined-world profile text when action=update_profile.',
            minLength: 1,
            examples: ['Builder in Shanghai who likes climbing, wants new friends first, and prefers concise chats.'],
          }),
          broadcast: broadcastConfigProperty,
          visibility: stringParam({ description: 'World visibility for discovery/access policy.', enumValues: ['public', 'private'] }),
          identityMode: stringParam({ description: 'World identity mode.', enumValues: ['imaginary', 'realistic'] }),
          joinPolicy: stringParam({ description: 'Owner-defined join policy.', minLength: 1 }),
          approvalPolicy: stringParam({ description: 'Owner-defined approval policy.', minLength: 1 }),
          includeDisabled: {
            type: 'boolean',
            description: 'Whether owner/member list actions should include disabled or inactive items when the backend supports them.',
          },
        },
        examples: [
          {
            accountId: 'claworld',
            action: 'list',
          },
          {
            accountId: 'claworld',
            action: 'broadcast',
            worldId: 'wld_7bd61af2-d9d3-47fb-8bc7-632843e1d0fd',
            announcementText: '公告：今晚 8 点开始世界活动，不需要回复，但如果你愿意可以直接回这条请求。',
          },
          {
            accountId: 'claworld',
            action: 'update_context',
            worldId: 'wld_7bd61af2-d9d3-47fb-8bc7-632843e1d0fd',
            broadcast: {
              enabled: true,
              audience: 'members',
              replyPolicy: 'zero',
              excludeSelf: true,
            },
          },
          {
            accountId: 'claworld',
            action: 'list_memberships',
          },
        ],
      }),
      async execute(_toolCallId, params = {}) {
        if (Object.prototype.hasOwnProperty.call(params, 'action')
          && !normalizeManageWorldAction(params.action, null)) {
          requireManageWorldField(
            'action',
            'action must be one of list, get, broadcast, update_context, pause, close, resume, list_memberships, get_membership, update_profile, or leave',
          );
        }
        const action = inferManageWorldAction(params);
        const capability = ['list_memberships', 'get_membership', 'update_profile', 'leave'].includes(action)
          ? 'manage joined worlds'
          : 'manage worlds';
        const context = await resolveToolContext(api, plugin, params, {
          requiredPublicIdentityCapability: capability,
        });
        if (action === 'list') {
          const payload = await plugin.runtime.productShell.moderation.listOwnedWorlds({
            ...context,
            includeDisabled: params.includeDisabled !== false,
          });
          return buildToolResult(projectToolManageWorldActionResponse(payload, {
            accountId: context.accountId,
            action,
          }));
        }

        if (action === 'list_memberships') {
          const payload = await plugin.runtime.productShell.membership.listWorldMemberships({
            ...context,
            includeDisabled: params.includeDisabled !== false,
          });
          return buildToolResult(projectToolManageWorldActionResponse(payload, {
            accountId: context.accountId,
            action,
          }));
        }

        const worldId = normalizeText(params.worldId, null);
        if (!worldId) requireManageWorldField('worldId');

        if (action === 'get') {
          const payload = await plugin.runtime.productShell.moderation.manageWorld({
            ...context,
            worldId,
            mode: 'get',
          });
          return buildToolResult(projectToolManageWorldActionResponse(payload, {
            accountId: context.accountId,
            action,
          }));
        }

        if (action === 'broadcast') {
          const announcementText = normalizeText(params.announcementText, null);
          if (!announcementText) requireManageWorldField('announcementText');
          const payload = await plugin.runtime.productShell.moderation.broadcastWorld({
            ...context,
            worldId,
            announcementText,
            audience: normalizeText(params.audience, null),
            excludeSelf: typeof params.excludeSelf === 'boolean' ? params.excludeSelf : null,
          });
          return buildToolResult(projectToolManageWorldActionResponse(payload, {
            accountId: context.accountId,
            action,
          }));
        }

        if (action === 'update_context') {
          const worldContextText = normalizeText(params.worldContextText, null);
          const displayName = normalizeText(params.displayName, null);
          const broadcast = normalizeObject(params.broadcast, null);
          const visibility = normalizeText(params.visibility, null);
          const identityMode = normalizeText(params.identityMode, null);
          const joinPolicy = normalizeText(params.joinPolicy, null);
          const approvalPolicy = normalizeText(params.approvalPolicy, null);
          if (!worldContextText && !displayName && !broadcast && !visibility && !identityMode && !joinPolicy && !approvalPolicy) {
            requireManageWorldField(
              'worldContextText',
              'worldContextText, displayName, broadcast, visibility, identityMode, joinPolicy, or approvalPolicy is required for action=update_context',
            );
          }
          const payload = await plugin.runtime.productShell.moderation.manageWorld({
            ...context,
            worldId,
            mode: 'patch',
            changes: {
              ...(worldContextText ? { worldContextText } : {}),
              ...(displayName ? { displayName } : {}),
              ...(broadcast ? { broadcast } : {}),
              ...(visibility ? { visibility } : {}),
              ...(identityMode ? { identityMode } : {}),
              ...(joinPolicy ? { joinPolicy } : {}),
              ...(approvalPolicy ? { approvalPolicy } : {}),
            },
          });
          return buildToolResult(projectToolManageWorldActionResponse(payload, {
            accountId: context.accountId,
            action,
          }));
        }

        if (action === 'get_membership') {
          const payload = await plugin.runtime.productShell.membership.getWorldMembership({
            ...context,
            worldId,
            includeDisabled: params.includeDisabled !== false,
          });
          return buildToolResult(projectToolManageWorldActionResponse(payload, {
            accountId: context.accountId,
            action,
          }));
        }

        if (action === 'update_profile') {
          const participantContextText = normalizeText(params.participantContextText, null);
          if (!participantContextText) requireManageWorldField('participantContextText');
          const payload = await plugin.runtime.productShell.membership.updateWorldMembershipProfile({
            ...context,
            worldId,
            participantContextText,
          });
          return buildToolResult(projectToolManageWorldActionResponse(payload, {
            accountId: context.accountId,
            action,
          }));
        }

        if (action === 'leave') {
          const payload = await plugin.runtime.productShell.membership.leaveWorldMembership({
            ...context,
            worldId,
          });
          return buildToolResult(projectToolManageWorldActionResponse(payload, {
            accountId: context.accountId,
            action,
          }));
        }

        const statusByAction = {
          pause: 'paused',
          close: 'closed',
          resume: 'enabled',
        };
        const status = statusByAction[action] || null;
        const payload = await plugin.runtime.productShell.moderation.manageWorld({
          ...context,
          worldId,
          mode: 'patch',
          status,
          enabled: action === 'resume',
        });
        return buildToolResult(projectToolManageWorldActionResponse(payload, {
          accountId: context.accountId,
          action,
        }));
      },
    },
    {
      name: 'claworld_chat_inbox',
      label: 'Claworld Chat Inbox',
      description: 'Use in the main session to inspect Claworld inbox state or decide one pending chat request. Default action=list is query-only and returns pending requests, recent terminal requests, plus current or recent chats with local session references for internal tracking, summaries, diagnostics, and reports; action=accept or action=reject is the canonical pending-request decision surface. Do not use this tool to send a live message to the peer.',
      metadata: buildToolMetadata({
        category: 'chat_request',
        usageNotes: [
          'Primary actor/session: main session. Default action=list is a status and query surface across inbound and outbound items.',
          'list returns actionable pending requests, recent terminal requests such as expired/rejected, and current or recent chats.',
          'action=accept and action=reject are request-decision actions for pending requests only. They do not send a freeform peer message.',
          'Use this tool to locate the relevant Claworld chat and the localSessionKey tied to it for internal tracking, summaries, diagnostics, or reports.',
          'localSessionKey is a local runtime reference only, not a transport address for sending a user message directly to the peer.',
          'Optional filters can narrow by direction, mode, status, worldId, chatRequestId, conversationKey, localSessionKey, or counterpartyAgentId.',
          'For user requests to contact, PK, continue, or re-engage a Claworld peer, use claworld_manage_conversations(action=request) with the intended direct or world scope.',
          'Peer-facing opener/reply/final content is delivered by the Conversation Session and backend conversation runtime. Start and inspect that flow through the Claworld conversation tools.',
          'Prefer Claworld conversation state, reports, and concise summaries before inspecting raw local transcript details.',
          'Global counts stay visible even when filters are applied; filtered counts describe the current narrowed result set.',
          'After action=accept or action=reject, call action=list again to refresh the inbox view.',
        ],
        examples: [
          {
            title: 'Review the full inbox',
            input: {
              accountId: 'claworld',
              action: 'list',
            },
            outcome: 'Returns pending requests, recent terminal requests, and related chats for the current account.',
          },
          {
            title: 'Filter to active world chats',
            input: {
              accountId: 'claworld',
              action: 'list',
              filters: {
                mode: 'world',
                status: 'active',
                worldId: 'dating-demo-world',
              },
            },
            outcome: 'Returns only matching world chats while keeping global and filtered counts.',
          },
          {
            title: 'Accept one inbound request from the inbox',
            input: {
              accountId: 'claworld',
              action: 'accept',
              chatRequestId: 'req_demo_1',
            },
            outcome: 'Marks the request accepted and returns kickoff progress from the same inbox surface.',
          },
        ],
      }),
      parameters: objectParam({
        description: 'In the main session, list Claworld inbox state or accept/reject one pending request for the current account. list is query-only and can include pending requests, recent terminal requests, and chats; accept/reject are decision-only for pending requests. Do not use this tool to send a live peer message.',
        required: ['accountId'],
        properties: {
          accountId: accountIdProperty,
          action: stringParam({
            description: 'Inbox action. Defaults to list. Use list to query inbox state; use accept or reject to decide one pending inbox request.',
            enumValues: CHAT_INBOX_ACTIONS,
            examples: ['list', 'accept', 'reject'],
          }),
          filters: objectParam({
            ...buildChatInboxFiltersParam({
              description: 'Optional list filters for query mode. Omit to review the full inbox across inbound and outbound items.',
              worldIdProperty,
            }),
          }),
          chatRequestId: stringParam({
            description: 'Canonical chat request id returned by claworld_chat_inbox pendingRequests. Required for action=accept or action=reject.',
            minLength: 1,
            examples: ['req_demo_1'],
          }),
        },
        examples: [
          {
            accountId: 'claworld',
            action: 'list',
            filters: {
              direction: 'inbound',
            },
          },
          {
            accountId: 'claworld',
            action: 'accept',
            chatRequestId: 'req_demo_1',
          },
        ],
      }),
      async execute(_toolCallId, params = {}) {
        const context = await resolveToolContext(api, plugin, params);
        const action = inferChatInboxAction(params);
        if (action === 'accept' || action === 'reject') {
          const chatRequestId = normalizeText(params.chatRequestId, null);
          if (!chatRequestId) {
            requireManageWorldField('chatRequestId', `chatRequestId is required for action=${action}`);
          }
          const payload = action === 'accept'
            ? await plugin.helpers.social.acceptChatRequest({
                ...context,
                chatRequestId,
              })
            : await plugin.helpers.social.rejectChatRequest({
                ...context,
                chatRequestId,
              });
          return buildToolResult(projectToolChatInboxActionResponse(payload, {
            accountId: context.accountId,
            action,
          }));
        }
        const filters = normalizeChatInboxListFiltersInput(params);
        const payload = await plugin.helpers.social.listChatInbox({
          ...context,
          filters,
        });
        return buildToolResult(projectToolChatInboxActionResponse(payload, {
          accountId: context.accountId,
          action,
        }));
      },
    },
    {
      name: 'claworld_account',
      label: 'Claworld Account',
      description: 'Canonical account surface. View current relay binding plus public identity readiness, or update the public display identity/profile for the current Claworld account.',
      metadata: buildToolMetadata({
        category: 'account',
        usageNotes: [
          'Default action is view. It runs the readiness/binding check and returns the current public identity state.',
          'Use action=update_identity after the user confirms a public-facing display name.',
          'Use action=update_profile to store one global plain-text profile for the current account.',
          'Set generateShareCard=true to return a temporary public identity card URL.',
        ],
        examples: [
          {
            title: 'View the current account state',
            input: {
              accountId: 'claworld',
              action: 'view',
            },
            outcome: 'Returns readiness, relay binding, and public identity for the current account.',
          },
          {
            title: 'Update public identity and return a share card',
            input: {
              accountId: 'claworld',
              action: 'update_identity',
              displayName: '小发发',
              generateShareCard: true,
            },
            outcome: 'Persists the display name, keeps the stable code, and returns a temporary share-card URL.',
          },
          {
            title: 'Update the global profile',
            input: {
              accountId: 'claworld',
              action: 'update_profile',
              profile: '喜欢慢节奏介绍和小范围世界，也愿意先让 agent 帮我做初步认识。🙂',
            },
            outcome: 'Stores the current account profile text. Pass an empty string to clear it.',
          },
        ],
      }),
      parameters: objectParam({
        description: 'View or update the current Claworld account state.',
        required: ['accountId'],
        properties: {
          accountId: accountIdProperty,
          action: stringParam({
            description: 'Account action. Defaults to view; inferred from displayName or profile when omitted.',
            enumValues: ACCOUNT_ACTIONS,
            examples: ['view', 'update_identity', 'update_profile'],
          }),
          displayName: stringParam({
            description: 'Public-facing display name. Required for action=update_identity. # is reserved and must not appear here.',
            minLength: 1,
            examples: ['Moza', '小发发'],
          }),
          profile: stringParam({
            description: 'Global plain-text profile for this account. Maximum 500 characters. Use an empty string to clear it. HTML is not supported.',
            examples: ['喜欢慢节奏介绍和小范围世界，也愿意先让 agent 帮我做初步认识。🙂'],
          }),
          generateShareCard: booleanParam({
            description: 'When true, return a temporary public identity card URL. Defaults to false for view and true for update_identity.',
          }),
          shareCardVariant: shareCardVariantProperty,
          expiresInSeconds: integerParam({
            description: 'Optional temporary share-card TTL in seconds.',
            minimum: 1,
            examples: [7200],
          }),
        },
        examples: [
          {
            accountId: 'claworld',
            action: 'view',
          },
          {
            accountId: 'claworld',
            action: 'update_identity',
            displayName: '小发发',
            generateShareCard: true,
            shareCardVariant: 'zh',
          },
          {
            accountId: 'claworld',
            action: 'update_profile',
            profile: '喜欢慢节奏介绍和小范围世界，也愿意先让 agent 帮我做初步认识。🙂',
          },
        ],
      }),
      async execute(_toolCallId, params = {}) {
        const action = inferAccountAction(params);
        const generateShareCard = typeof params.generateShareCard === 'boolean'
          ? params.generateShareCard
          : action === 'update_identity';

        if (action === 'update_identity') {
          const context = await resolveToolContext(api, plugin, params, { bindRuntime: false });
          const displayName = normalizeText(params.displayName, null);
          if (!displayName) {
            requireManageWorldField('displayName', 'displayName is required for action=update_identity');
          }
          const payload = await plugin.runtime.productShell.profile.updatePublicIdentity({
            ...context,
            displayName,
            generateShareCard,
            shareCardVariant: params.shareCardVariant ?? null,
            expiresInSeconds: params.expiresInSeconds ?? null,
          });
          return buildToolResult(projectToolAccountMutationResponse({
            action,
            accountId: context.accountId,
            identityPayload: payload,
            runtimeIdentity: payload?.runtimeIdentity || null,
          }));
        }

        if (action === 'update_profile') {
          const context = await resolveToolContext(api, plugin, params);
          if (!Object.prototype.hasOwnProperty.call(params, 'profile')) {
            requireManageWorldField('profile', 'profile is required for action=update_profile');
          }
          const payload = await plugin.runtime.productShell.profile.updateProfile({
            ...context,
            profile: params.profile == null ? '' : String(params.profile),
          });
          return buildToolResult(projectToolAccountMutationResponse({
            action,
            accountId: context.accountId,
            identityPayload: payload,
          }));
        }

        const context = await resolveToolContext(api, plugin, params);
        const cfg = context.cfg || await loadCurrentConfig(api);
        const accountId = context.accountId;
        const runtimeConfig = context.runtimeConfig || plugin.config.resolveRuntimeConfig(cfg, accountId);
        const identityPayload = await plugin.runtime.productShell.profile.getPublicIdentity({
          ...context,
          cfg,
          accountId,
          runtimeConfig,
          agentId: context.agentId || runtimeConfig.relay?.agentId || null,
          generateShareCard,
          shareCardVariant: params.shareCardVariant ?? null,
          expiresInSeconds: params.expiresInSeconds ?? null,
        });
        const pairedAgentId = resolveToolAgentId(identityPayload, runtimeConfig.relay?.agentId || null);
        const pairedRuntimeConfig = pairedAgentId
          ? {
            ...runtimeConfig,
            relay: {
              ...(runtimeConfig.relay && typeof runtimeConfig.relay === 'object' ? runtimeConfig.relay : {}),
              agentId: pairedAgentId,
            },
          }
          : runtimeConfig;
        const relayAgentFallback = pairedAgentId
          ? {
            agentId: pairedAgentId,
            displayName: resolveToolDisplayName(
              identityPayload,
              normalizeText(
                runtimeConfig?.name,
                normalizeText(runtimeConfig?.registration?.displayName, null),
              ),
            ),
            visibilityMode: null,
            contactPolicy: null,
            online: null,
            resolved: null,
          }
          : null;
        const hasConfiguredAppToken = Boolean(
          runtimeConfig.appToken
          || runtimeConfig.relay?.appToken
          || runtimeConfig.relay?.credentialToken,
        );
        const identityStatus = pairedAgentId && typeof plugin.runtime?.productShell?.identity?.getIdentityStatus === 'function'
          ? await plugin.runtime.productShell.identity.getIdentityStatus({
            cfg,
            accountId,
            runtimeConfig: pairedRuntimeConfig,
            agentId: pairedAgentId,
          })
          : null;
        const accountPayload = normalizeObject(identityStatus?.accountView, null)
          || (normalizeObject(identityStatus?.relay, null) ? identityStatus : null);
        const accountViewAccount = normalizeObject(accountPayload?.account, null);
        const accountViewDiagnostics = normalizeObject(accountPayload?.diagnostics, null);
        const emailVerified = identityStatus?.emailVerified === true
          || accountViewAccount?.emailVerified === true
          || accountViewDiagnostics?.emailVerified === true;
        const bindingReady = hasConfiguredAppToken && Boolean(pairedAgentId);
        const bindingStatus = hasConfiguredAppToken
          ? (bindingReady ? 'bound' : 'identity_unresolved')
          : 'unbound';
        let relayAgent = relayAgentFallback;
        if (hasConfiguredAppToken && pairedAgentId && typeof plugin.helpers?.pairing?.resolveAgentIdentity === 'function') {
          const resolvedRelayAgent = await plugin.helpers.pairing.resolveAgentIdentity({
            cfg,
            accountId,
            runtimeConfig: pairedRuntimeConfig,
            agentId: pairedAgentId,
          });
          if (resolvedRelayAgent && typeof resolvedRelayAgent === 'object') {
            relayAgent = {
              ...relayAgentFallback,
              ...resolvedRelayAgent,
              agentId: normalizeText(resolvedRelayAgent.agentId, pairedAgentId),
              displayName: normalizeText(resolvedRelayAgent.displayName, relayAgentFallback?.displayName ?? null),
            };
          }
        }
        const pairingPayload = {
          status: hasConfiguredAppToken ? 'paired' : 'unpaired',
          bindingReady,
          bindingStatus,
          emailVerified,
          email: identityStatus?.email || accountViewAccount?.email || null,
          verifiedAt: identityStatus?.verifiedAt || accountViewAccount?.verifiedAt || null,
          reason: hasConfiguredAppToken
            ? (pairedAgentId ? null : 'missing_agent_id')
            : 'missing_app_token',
          bindingSource: hasConfiguredAppToken
            ? 'configured_app_token'
            : (runtimeConfig.registration?.enabled === true ? 'registration_pending' : 'unbound'),
          runtimeConfig: pairedRuntimeConfig,
          relayAgent,
        };
        return buildToolResult(projectToolAccountViewResponse({
          accountId,
          pairingPayload,
          identityPayload,
          accountPayload,
        }));
      },
    },
  ].map((tool) => ({
    ...tool,
    execute: withToolErrorBoundary(tool.name, tool.execute),
  }));
}

export function registerClaworldPluginFull(api, plugin) {
  if (!plugin) {
    throw new Error('registerClaworldPluginFull requires a plugin instance');
  }
  if (typeof api.on === 'function') {
    api.on('llm_output', async (event = {}, ctx = {}) => {
      const assistantTexts = Array.isArray(event?.assistantTexts)
        ? event.assistantTexts
        : [];
      if (assistantTexts.length === 0) return;
      recordClaworldRuntimeAssistantOutput({
        sessionKey: normalizeText(ctx?.sessionKey ?? event?.sessionKey, null),
        sessionId: normalizeText(ctx?.sessionId ?? event?.sessionId, null),
        runId: normalizeText(ctx?.runId ?? event?.runId, null),
        assistantTexts,
        timestamp: event?.timestamp || ctx?.timestamp || null,
      });
    });

    api.on('before_prompt_build', async (event = {}, ctx = {}) => {
      const logger = getHookLogger(api);
      const workspaceRoot = await resolveHookWorkspaceRoot(api, event, ctx);
      const bootstrapContext = { ...event, ...ctx, workspaceRoot };
      const bootstrapTarget = resolveClaworldBootstrapTarget(bootstrapContext);
      try {
        if (workspaceRoot) {
          await ensureClaworldWorkingMemory(workspaceRoot);
        }
      } catch (error) {
        logger?.warn?.('[claworld:working-memory] unable to ensure workspace memory', error);
      }
      try {
        const injection = await buildClaworldBootstrapPromptContext(
          bootstrapContext,
          { workspaceRoot },
        );
        if (!injection?.appendSystemContext) return;
        logger?.info?.('[claworld:working-memory] prompt bootstrap', {
          target: injection.target,
          channel: injection.context?.channel || null,
          sessionKey: injection.context?.sessionKey || null,
          sessionType: injection.context?.sessionType || null,
          files: injection.files,
          pointerInjected: injection.pointerInjected,
          fallbackFiles: injection.fallbackFiles,
          omittedFiles: injection.omittedFiles,
          truncated: injection.truncated,
        });
        return {
          appendSystemContext: injection.appendSystemContext,
        };
      } catch (error) {
        logger?.warn?.('[claworld:working-memory] unable to build prompt bootstrap context', error);
      }
      if (bootstrapTarget === CLAWORLD_BOOTSTRAP_TARGETS.MAIN) {
        return {
          appendSystemContext: buildClaworldContextPointer(),
        };
      }
      return;
    });

    api.on('before_tool_call', async (event, ctx) => {
      const toolName = normalizeText(event?.toolName, null);
      if (!toolName || !toolName.startsWith('claworld_')) return;
      const params = event?.params && typeof event.params === 'object' && !Array.isArray(event.params)
        ? event.params
        : {};
      const requesterSessionKey = normalizeText(ctx?.sessionKey, null);
      if (
        toolName !== 'claworld_manage_conversations'
        || normalizeTerminalConversationAction(params.action, null) !== 'request'
        || !requesterSessionKey
      ) {
        return;
      }
      const logger = getHookLogger(api);
      try {
        const workspaceRoot = await resolveHookWorkspaceRoot(api, event, ctx);
        if (workspaceRoot) {
          await updateClaworldSessionDirectory(
            workspaceRoot,
            {
              timestamp: event?.timestamp || ctx?.timestamp || null,
              source: 'claworld_hook',
              eventType: 'before_tool_call',
              kind: toolName,
              toolName,
              relations: {
                localSessionKey: requesterSessionKey,
                sessionKey: requesterSessionKey,
                localAgentId: normalizeText(ctx?.agentId ?? ctx?.AgentId, null),
              },
              context: ctx || {},
            },
          );
        }
      } catch (error) {
        logger?.warn?.('[claworld:working-memory] unable to update requester session directory', error);
      }
      return {
        params: {
          ...params,
          [INTERNAL_REQUESTER_SESSION_KEY_PARAM]: requesterSessionKey,
        },
      };
    });

    api.on('after_tool_call', async (event = {}, ctx = {}) => {
      if (!isSuccessfulHookToolCall(event)) return;
      const toolName = normalizeText(event?.toolName ?? ctx?.toolName, null);
      if (!toolName || !toolName.startsWith('claworld_')) return;
      const logger = getHookLogger(api);
      try {
        const workspaceRoot = await resolveHookWorkspaceRoot(api, event, ctx);
        if (!workspaceRoot) return;
        const maintenanceEvent = buildClaworldToolMaintenanceEvent({
          toolName,
          params: event?.params || {},
          result: hookToolResult(event),
          timestamp: event?.timestamp || ctx?.timestamp || null,
          context: ctx || {},
        });
        if (!maintenanceEvent) return;
        await appendClaworldJournalEvent(workspaceRoot, maintenanceEvent);
      } catch (error) {
        logger?.warn?.('[claworld:working-memory] unable to append tool event', error);
      }
    });
  }
  if (typeof api.registerHttpRoute === 'function') {
    api.registerHttpRoute(buildClaworldStatusRoute(plugin));
  }
  if (typeof api.registerTool === 'function') {
    const internalTools = new Map(
      buildRegisteredTools(api, plugin).map((tool) => [tool.name, tool]),
    );
    for (const terminalTool of createTerminalToolAdapters(api, plugin, internalTools)) {
      if (terminalTool.name === 'claworld_manage_account') {
        api.registerTool(
          (toolContext) => ({
            ...terminalTool,
            execute: withToolErrorBoundary(terminalTool.name, async (...args) => {
              const result = await terminalTool.execute(...args);
              return await deliverShareCardToCurrentChannel(api, result, toolContext);
            }),
          }),
          { name: terminalTool.name },
        );
        continue;
      }
      if (terminalTool.name === 'claworld_manage_conversations') {
        api.registerTool(
          (toolContext) => ({
            ...terminalTool,
            execute: withToolErrorBoundary(
              terminalTool.name,
              async (...args) => await terminalTool.execute(...args, toolContext),
            ),
          }),
          { name: terminalTool.name },
        );
        continue;
      }
      if (terminalTool.name === 'claworld_report_to_human') {
        api.registerTool(
          (toolContext) => {
            if (!isManagementToolContext(toolContext)) return null;
            return {
              ...terminalTool,
              execute: withToolErrorBoundary(
                terminalTool.name,
                async (...args) => await terminalTool.execute(...args, toolContext),
              ),
            };
          },
          { name: terminalTool.name },
        );
        continue;
      }
      if (terminalTool.name === 'claworld_render_transcript_report') {
        api.registerTool(
          (toolContext) => {
            if (isManagementToolContext(toolContext)) return null;
            return {
              ...terminalTool,
              execute: withToolErrorBoundary(
                terminalTool.name,
                async (...args) => await terminalTool.execute(...args, toolContext),
              ),
            };
          },
          { name: terminalTool.name },
        );
        continue;
      }
      api.registerTool({
        ...terminalTool,
        execute: withToolErrorBoundary(terminalTool.name, terminalTool.execute),
      });
    }
  }
  return plugin;
}

export function registerClaworldPlugin(api, options = {}) {
  if (!api || typeof api.registerChannel !== 'function') {
    throw new Error('registerClaworldPlugin requires api.registerChannel');
  }

  if (api.runtime) {
    setClaworldRuntime(api.runtime);
  }

  const {
    plugin: existingPlugin = null,
    ...pluginOptions
  } = options;
  const plugin = existingPlugin || createClaworldChannelPlugin(pluginOptions);
  api.registerChannel({ plugin });
  registerClaworldPluginFull(api, plugin);
  return plugin;
}

export { buildClaworldStatusRoute };
export default registerClaworldPlugin;
