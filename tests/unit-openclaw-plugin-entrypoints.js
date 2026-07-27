import assert from 'assert';
import claworldChannelEntry, { claworldChannelPlugin, register } from '../index.js';
import claworldSetupEntry, { claworldSetupPlugin } from '../setup-entry.js';

function createRegistrationApi(registrationMode = 'full') {
  const channels = [];
  const httpRoutes = [];
  const tools = [];
  const toolFactories = new Map();

  return {
    api: {
      registrationMode,
      runtime: {
        config: {
          async loadConfig() {
            return {};
          },
        },
      },
      registerChannel({ plugin }) {
        channels.push(plugin);
      },
      registerHttpRoute(route) {
        httpRoutes.push(route);
      },
      registerTool(tool, options) {
        if (typeof tool === 'function') {
          toolFactories.set(options.name, tool);
          const toolContext = options.name === 'claworld_report_to_human'
            ? { sessionKey: 'agent:main:management:agent-local' }
            : {};
          const resolved = tool(toolContext);
          if (resolved) tools.push({ tool: resolved, options });
          return;
        }
        tools.push({ tool, options });
      },
    },
    channels,
    httpRoutes,
    tools,
    toolFactories,
  };
}

function parseToolPayload(result) {
  const text = result?.content?.[0]?.text;
  assert.equal(typeof text, 'string');
  return JSON.parse(text);
}

async function main() {
  assert.equal(typeof claworldChannelEntry, 'object');
  assert.equal(claworldChannelEntry.id, 'claworld');
  assert.equal(claworldChannelEntry.name, 'Claworld Relay Channel');
  assert.equal(claworldChannelEntry.description, 'Claworld relay channel plugin for OpenClaw.');
  assert.equal(typeof claworldChannelEntry.register, 'function');
  assert.equal(claworldChannelPlugin.id, 'claworld');
  assert.equal(typeof register, 'function');

  const setupOnly = createRegistrationApi('setup');
  claworldChannelEntry.register(setupOnly.api);
  assert.equal(setupOnly.channels.length, 1);
  assert.equal(setupOnly.channels[0].id, 'claworld');
  assert.equal(setupOnly.httpRoutes.length, 0);
  assert.equal(setupOnly.tools.length, 0);

  const full = createRegistrationApi('full');
  claworldChannelEntry.register(full.api);
  assert.equal(full.channels.length, 1);
  assert.equal(full.channels[0].id, 'claworld');
  assert.equal(full.httpRoutes.length, 1);
  assert.ok(full.tools.length > 0);
  assert.deepEqual(
    full.tools.filter(({ options }) => options != null).map(({ tool, options }) => ({
      name: tool.name,
      options,
    })),
    [
      { name: 'claworld_manage_account', options: { name: 'claworld_manage_account' } },
      { name: 'claworld_manage_conversations', options: { name: 'claworld_manage_conversations' } },
      { name: 'claworld_render_transcript_report', options: { name: 'claworld_render_transcript_report' } },
      { name: 'claworld_report_to_human', options: { name: 'claworld_report_to_human' } },
    ],
  );
  assert.deepEqual(
    full.tools.map(({ tool }) => tool.name).sort(),
    [
      'claworld_get_public_profile',
      'claworld_manage_account',
      'claworld_manage_conversations',
      'claworld_manage_worlds',
      'claworld_render_transcript_report',
      'claworld_report_to_human',
      'claworld_search',
    ],
  );
  const toolByName = new Map(full.tools.map(({ tool }) => [tool.name, tool]));
  for (const toolName of [
    'claworld_manage_account',
    'claworld_search',
    'claworld_get_public_profile',
    'claworld_manage_worlds',
    'claworld_manage_conversations',
    'claworld_render_transcript_report',
    'claworld_report_to_human',
  ]) {
    const description = toolByName.get(toolName)?.description || '';
    assert.equal(description.includes('claworld:'), false, `${toolName} description should use OpenClaw skill names without plugin prefix`);
  }
  assert.ok(toolByName.get('claworld_manage_account')?.description.includes('notification/proactivity policy'));
  assert.ok(toolByName.get('claworld_manage_worlds')?.description.includes('`claworld-manage-worlds` skill'), 'world tool should route to manage-worlds skill');
  assert.ok(!toolByName.get('claworld_manage_worlds')?.description.includes('draft/preview'), 'world confirmation detail belongs in skill/system prompt, not tool description');

  const manageConversations = toolByName.get('claworld_manage_conversations');
  assert.ok(manageConversations, 'expected conversation management tool to register');
  assert.ok(manageConversations.metadata.usageNotes.some((note) => note.includes('Make one action=request call')));
  const conversationProperties = manageConversations.parameters?.properties || {};
  assert.ok(conversationProperties.openingMessage?.description.includes('Owner intent for the upcoming chat'));
  assert.ok(conversationProperties.openingMessage?.description.includes('preferred speaking order'));
  assert.ok(conversationProperties.kickoffBrief?.description.includes('Structured owner intent'));
  assert.ok(conversationProperties.kickoffBrief?.properties?.text?.description.includes('Owner intent for the upcoming chat'));

  const renderTranscript = toolByName.get('claworld_render_transcript_report');
  assert.ok(renderTranscript, 'expected transcript render tool to register');
  const transcriptSchema = renderTranscript.parameters || {};
  const transcriptProperties = transcriptSchema.properties || {};
  const manualTranscript = transcriptProperties.manual || {};
  const manualProperties = manualTranscript.properties || {};
  const manualMessage = manualProperties.messages?.items || {};
  assert.deepEqual(transcriptSchema.required, ['mode']);
  assert.equal(transcriptSchema.additionalProperties, false);
  assert.equal(Object.prototype.hasOwnProperty.call(transcriptProperties, 'stored'), false);
  for (const field of [
    'chatRequestId',
    'accountId',
    'topic',
    'title',
    'chatMode',
    'worldName',
    'initiatedBy',
    'peerProfile',
    'worldContext',
    'localIdentity',
    'peerIdentity',
    'localLabel',
    'peerLabel',
  ]) {
    assert.ok(transcriptProperties[field], `expected flat stored transcript field ${field}`);
  }
  assert.deepEqual(transcriptProperties.chatMode.enum, ['direct', 'world']);
  assert.deepEqual(transcriptProperties.initiatedBy.enum, ['local', 'peer']);
  assert.equal(transcriptProperties.topic.minLength, 1);
  assert.match(transcriptProperties.topic.description, /Required for every new stored call/u);
  assert.match(transcriptProperties.topic.description, /what was actually discussed in this conversation/u);
  assert.match(transcriptProperties.title.description, /Compatibility alias/u);
  assert.match(transcriptProperties.accountId.description, /more than one local account/u);
  assert.equal(Object.prototype.hasOwnProperty.call(transcriptProperties, 'reportType'), false);

  assert.deepEqual(manualTranscript.required, ['messages']);
  assert.equal(manualTranscript.additionalProperties, false);
  assert.deepEqual(manualMessage.required, ['from', 'text']);
  assert.equal(manualMessage.additionalProperties, false);
  assert.ok(manualMessage.properties.createdAt);
  assert.equal(manualMessage.properties.createdAt.description.includes('Optional'), true);
  for (const field of [
    'topic',
    'title',
    'chatMode',
    'worldName',
    'initiatedBy',
    'reportType',
    'localIdentity',
    'peerIdentity',
    'peerProfile',
    'worldContext',
    'localLabel',
    'peerLabel',
  ]) {
    assert.ok(manualProperties[field], `expected manual transcript field ${field}`);
  }
  assert.deepEqual(manualProperties.reportType.enum, ['full', 'excerpt']);
  assert.deepEqual(manualProperties.initiatedBy.enum, ['local', 'peer']);
  assert.match(manualProperties.topic.description, /Required for every new Agent call/u);

  const maxPageHeight = renderTranscript.parameters?.properties?.maxPageHeight || {};
  assert.equal(maxPageHeight.minimum, 900);
  assert.equal(maxPageHeight.maximum, 32000);
  assert.ok(maxPageHeight.description.includes('Defaults to 8000'));
  assert.ok(maxPageHeight.description.includes('32000'));
  assert.ok(renderTranscript.description.includes('8000px default maximum'));
  assert.ok(renderTranscript.description.includes('top-level mode=stored, chatRequestId'));
  assert.ok(renderTranscript.description.includes('without requiring a prior state call'));
  assert.ok(renderTranscript.metadata.usageNotes.some((note) => note.includes('what was actually discussed')));
  assert.ok(renderTranscript.metadata.usageNotes.some((note) => note.includes('never infer initiatedBy')));
  assert.ok(renderTranscript.metadata.usageNotes.some((note) => note.includes('send every artifacts.pngPages[].path')));
  assert.ok(renderTranscript.metadata.usageNotes.some((note) => note.includes('forceDocument=true')));

  const reportToHuman = toolByName.get('claworld_report_to_human');
  assert.ok(reportToHuman, 'expected first-class Management report tool to register');
  const reportToHumanFactory = full.toolFactories.get('claworld_report_to_human');
  assert.ok(reportToHumanFactory, 'expected Management report tool factory to register');
  assert.equal(reportToHumanFactory({}), null);
  assert.equal(
    reportToHumanFactory({ sessionKey: 'agent:main:feishu:direct:user-owner' }),
    null,
  );
  assert.equal(
    reportToHumanFactory({ sessionKey: 'agent:main:conversation:pair:local::peer:direct' }),
    null,
  );
  assert.equal(
    reportToHumanFactory({ sessionKey: 'agent:main:management:agent-local' })?.name,
    'claworld_report_to_human',
  );
  assert.deepEqual(reportToHuman.parameters.required, ['source', 'reportText']);
  assert.ok(reportToHuman.parameters.properties.accountId, 'expected optional standard account selector');
  assert.deepEqual(reportToHuman.parameters.properties.source.properties.kind.enum, ['conversation', 'notification', 'proactive']);
  assert.deepEqual(reportToHuman.parameters.properties.transcript.properties.mode.enum, ['stored', 'manual']);
  assert.equal(reportToHuman.parameters.properties.transcript.properties.topic.minLength, 1);
  assert.match(
    reportToHuman.parameters.properties.transcript.properties.topic.description,
    /Required for stored mode.*what was actually discussed in this conversation/u,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(reportToHuman.parameters.properties.transcript.properties, 'presentation'),
    false,
  );
  assert.equal(Object.prototype.hasOwnProperty.call(reportToHuman.parameters.properties, 'sessionKey'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(reportToHuman.parameters.properties, 'channel'), false);
  assert.ok(reportToHuman.description.includes('one call'));
  assert.ok(reportToHuman.description.includes('other notifications deliver text only'));
  assert.ok(reportToHuman.metadata.usageNotes.some((note) => note.includes('normal Management assistant reply is internal')));
  assert.ok(reportToHuman.metadata.usageNotes.some((note) => note.includes('what was actually discussed')));
  assert.ok(reportToHuman.metadata.usageNotes.some((note) => note.includes('do not supply a target session')));
  assert.ok(reportToHuman.metadata.usageNotes.some((note) => note.includes('idempotency boundary')));

  const manageWorld = toolByName.get('claworld_manage_worlds');
  assert.ok(manageWorld, 'expected world management tool to register');
  const worldProperties = manageWorld.parameters?.properties || {};
  assert.ok(worldProperties.action.enum.includes('list_pending_invites'));

  const manageAccount = toolByName.get('claworld_manage_account');
  assert.ok(manageAccount, 'expected account management tool to register');
  const accountProperties = manageAccount.parameters?.properties || {};
  assert.equal(accountProperties.humanProfile.description, 'Human profile for action=update_human_profile.');
  assert.equal(accountProperties.agentProfile.description, 'Agent profile for action=update_agent_profile.');
  assert.ok(accountProperties.visibilityMode, 'expected visibilityMode account policy field');
  assert.ok(accountProperties.contactPolicy, 'expected contactPolicy account policy field');
  assert.deepEqual(accountProperties.contactPolicy.enum, ['open', 'approval_required', 'closed']);
  assert.ok(accountProperties.contactPolicy.description.includes('Management review'));
  assert.ok(accountProperties.contactPolicy.description.includes("human's instructions and context"));
  assert.equal(Object.prototype.hasOwnProperty.call(accountProperties, 'discoverable'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(accountProperties, 'contactable'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(accountProperties, 'contactMode'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(accountProperties, 'chatRequestApprovalPolicy'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(accountProperties, 'chatRequestPolicy'), false);
  assert.ok(accountProperties.action.enum.includes('set_visibility_mode'));
  assert.ok(accountProperties.action.enum.includes('set_contact_policy'));
  assert.ok(accountProperties.action.enum.includes('submit_feedback'));
  assert.deepEqual(accountProperties.category.enum, ['experience_issue', 'usage_issue', 'bug_report', 'feature_request']);
  assert.deepEqual(accountProperties.impact.enum, ['low', 'medium', 'high', 'blocker']);
  assert.ok(accountProperties.reproductionSteps);
  assert.ok(accountProperties.context);
  assert.equal(accountProperties.action.enum.includes('set_chat_request_policy'), false);
  assert.equal(accountProperties.action.enum.includes('set_discoverability'), false);
  assert.equal(accountProperties.action.enum.includes('set_contactability'), false);
  assert.equal(accountProperties.action.enum.includes('set_chat_policy'), false);

  const missingContactPolicy = parseToolPayload(await manageAccount.execute('tool-call-1', {
    accountId: 'claworld',
    action: 'set_contact_policy',
  }));
  assert.equal(missingContactPolicy.status, 'error');
  assert.equal(missingContactPolicy.code, 'tool_input_invalid');
  assert.equal(missingContactPolicy.message, 'contactPolicy is required for action=set_contact_policy');

  const mixedContactPolicy = parseToolPayload(await manageAccount.execute('tool-call-2', {
    accountId: 'claworld',
    action: 'set_contact_policy',
    visibilityMode: 'public',
    contactPolicy: 'approval_required',
  }));
  assert.equal(mixedContactPolicy.status, 'error');
  assert.equal(mixedContactPolicy.code, 'tool_input_invalid');
  assert.equal(mixedContactPolicy.message, 'visibilityMode is not supported for action=set_contact_policy');

  const legacyChatPolicy = parseToolPayload(await manageAccount.execute('tool-call-3', {
    accountId: 'claworld',
    action: 'set_chat_request_policy',
    chatRequestPolicy: { mode: 'manual_review' },
  }));
  assert.equal(legacyChatPolicy.status, 'error');
  assert.equal(legacyChatPolicy.code, 'tool_input_invalid');

  assert.equal(typeof claworldSetupEntry, 'object');
  assert.equal(claworldSetupEntry.plugin.id, 'claworld');
  assert.equal(typeof claworldSetupEntry.plugin.setup, 'object');
  assert.equal(claworldSetupPlugin.id, 'claworld');

  console.log('PASS unit-openclaw-plugin-entrypoints');
}

main().catch((error) => {
  console.error('FAIL unit-openclaw-plugin-entrypoints');
  console.error(error);
  process.exit(1);
});
