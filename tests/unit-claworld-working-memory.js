import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { registerClaworldPluginFull } from '../src/openclaw/plugin/register.js';
import {
  buildClaworldBootstrapPromptContext,
  CLAWORLD_BOOTSTRAP_TARGETS,
  CLAWORLD_MAINTENANCE_RUN_TYPES,
  appendClaworldJournalEvent,
  buildClaworldContextPointer,
  buildClaworldRuntimeMaintenanceEvent,
  buildClaworldWorkingMemoryTemplates,
  ensureClaworldWorkingMemory,
  readClaworldSessionDirectory,
  resolveClaworldBootstrapContext,
  resolveClaworldBootstrapTarget,
  resolveClaworldMaintenanceWorkspaceRoot,
  runClaworldMemoryMaintenance,
  updateClaworldSessionDirectory,
  runClaworldMemoryMaintenanceForOpenClaw,
  validateClaworldMaintenanceOutput,
} from '../src/openclaw/runtime/working-memory.js';

async function readText(filePath) {
  return fs.readFile(filePath, 'utf8');
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildNowFixture(activeGoal = '- none') {
  return [
    '# Claworld Now',
    '',
    '## Active Goals',
    activeGoal,
    '',
    '## Pending Approvals',
    '- none',
    '',
    '## Watched People And Worlds',
    '- none',
    '',
    '## Open Conversations',
    '- none',
    '',
    '## Recent Changes',
    '- none',
    '',
    '## Closed Recently',
    '- none',
    '',
  ].join('\n');
}

function buildProfileFixture(socialStyle = '- unknown') {
  return [
    '# Claworld Profile',
    '',
    '## Identity And Background',
    '- unknown',
    '',
    '## Goals And Interests',
    '- unknown',
    '',
    '## Social Style',
    socialStyle,
    '',
    '## Autonomy Policy',
    '- unknown',
    '',
    '## Contact And Notification Preferences',
    '- unknown',
    '',
    '## Privacy And Sensitive Boundaries',
    '- unknown',
    '',
    '## World And People Preferences',
    '- unknown',
    '',
    '## Explicit Do-Not Rules',
    '- unknown',
    '',
  ].join('\n');
}

function buildMemoryFixture(memory = '- none') {
  return [
    '# Claworld Memory',
    '',
    '## Memories',
    memory,
    '',
  ].join('\n');
}

function markdownHeadings(text) {
  return text.split('\n').filter((line) => /^#{1,4} /u.test(line));
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claworld-working-memory-'));
  try {
    const workspaceRoot = path.join(tempRoot, 'workspace');
    const customNow = buildNowFixture('- [ ] id: goal-custom | status: active | next: keep this user-edited state | report: main | source: unit | updated: 2026-04-22');

    await ensureClaworldWorkingMemory(workspaceRoot);
    const indexPath = path.join(workspaceRoot, '.claworld', 'INDEX.md');
    const nowPath = path.join(workspaceRoot, '.claworld', 'context', 'NOW.md');
    const profilePath = path.join(workspaceRoot, '.claworld', 'context', 'PROFILE.md');
    const memoryPath = path.join(workspaceRoot, '.claworld', 'context', 'MEMORY.md');
    await fs.access(indexPath);
    await fs.access(nowPath);
    await fs.access(profilePath);
    await fs.access(memoryPath);
    await fs.access(path.join(workspaceRoot, '.claworld', 'journal'));
    await fs.access(path.join(workspaceRoot, '.claworld', 'reports'));
    const templates = buildClaworldWorkingMemoryTemplates();
    assert.equal(await readText(nowPath), templates['context/NOW.md']);
    assert.equal(await readText(profilePath), templates['context/PROFILE.md']);
    assert.equal(await readText(memoryPath), templates['context/MEMORY.md']);

    await fs.writeFile(nowPath, customNow, 'utf8');
    await ensureClaworldWorkingMemory(workspaceRoot);
    assert.equal(await readText(nowPath), customNow);

    const pointer = buildClaworldContextPointer({ workspaceRoot });
    assert.ok(pointer.includes(path.join(workspaceRoot, '.claworld', 'context', 'NOW.md')));
    assert.ok(pointer.includes(path.join(workspaceRoot, '.claworld', 'context', 'MEMORY.md')));
    assert.ok(pointer.includes(path.join(workspaceRoot, '.claworld', 'context', 'PROFILE.md')));
    assert.ok(pointer.includes(path.join(workspaceRoot, '.claworld', 'journal') + '/'));
    assert.ok(pointer.includes(path.join(workspaceRoot, '.claworld', 'reports') + '/'));
    assert.ok(pointer.includes(path.join(workspaceRoot, '.claworld', 'sessions', 'index.json')));
    assert.ok(pointer.includes('Claworld is a social app that you and your human are connected to'));
    assert.ok(pointer.includes('## Other Claworld Sessions'));
    assert.ok(pointer.includes('Do not proactively contact Conversation Sessions'));
    assert.ok(pointer.includes('## Required Skill Routing'));
    assert.ok(pointer.includes('read the `claworld-manage-worlds` skill again'));
    assert.ok(pointer.includes('read the `claworld-help` skill'));
    assert.ok(pointer.includes('Read `sessions/index.json` before searching raw local session files'));
    assert.ok(pointer.includes('## Claworld Memory Routing'));
    assert.ok(pointer.includes('Stable Claworld preferences'));
    assert.ok(pointer.includes('Current Claworld goals'));
    assert.ok(pointer.includes('Durable Claworld people'));
    assert.ok(pointer.includes('Use generic memory only when the human clearly asks for global personal memory outside Claworld'));
    assert.ok(pointer.includes('## World Operation Confirmation'));
    assert.ok(pointer.includes('read like an announcement a person would understand'), 'broadcast preview should read like a human announcement');
    assert.ok(pointer.includes('do not put raw field names'), 'world confirmation should keep raw field names out of human-facing text');
    assert.ok(pointer.includes('## Feedback Routing'));
    assert.ok(pointer.includes('claworld_manage_account(action=submit_feedback)'));
    assert.ok(pointer.includes('Redact app tokens'));
    assert.ok(pointer.includes('## Conversation Request Recovery'));
    assert.ok(pointer.includes('Before `action=request`, inspect the resolved person and exact direct/world scope'));
    assert.ok(pointer.includes('Make one `action=request` call for each human instruction'));
    assert.ok(pointer.includes('first or last seen in the current request window proves creation'));
    assert.ok(pointer.includes('If the backend returns `conversation_already_active`, do not retry'));
    assert.ok(pointer.includes('## Conversation Transcript Images'));
    assert.ok(pointer.includes('what was actually discussed in this conversation'));
    assert.ok(pointer.includes('anything unrelated to the content'));
    assert.ok(pointer.includes('8000px default maximum'));
    assert.ok(pointer.includes('900 through 32000'));
    assert.ok(pointer.includes('send every absolute PNG path in page order'));
    assert.ok(pointer.includes('forceDocument=true'));
    assert.ok(pointer.includes('## Plugin-Owned Report Context Sync'));
    assert.ok(pointer.includes('# Claworld Management Report Context'));
    assert.ok(pointer.includes('CLAWORLD_REPORT_CONTEXT_RECORDED:<reportId>'));
    assert.equal(pointer.includes('sessions_send'), false);
    assert.equal(pointer.includes('ANNOUNCE_READY'), false);
    assert.equal(pointer.includes('## Contact Settings And Review Instructions'), false);
    assert.equal(pointer.includes('## Tools'), false);
    assert.equal(pointer.includes('### Starting a Conversation'), false);

    const manageWorldsSkill = await readText(path.join(process.cwd(), 'skills', 'claworld-manage-worlds', 'SKILL.md'));
    assert.ok(manageWorldsSkill.includes('World Operation Confirmation Rules'));
    assert.ok(manageWorldsSkill.includes('`publish_broadcast`'));
    assert.ok(manageWorldsSkill.includes('action=update_world_profile, worldId, participantContextText'));
    assert.equal(manageWorldsSkill.includes('profileContextText'), false);
    assert.ok(manageWorldsSkill.includes('read like an announcement a person would understand'), 'broadcast preview should read like a human announcement');
    assert.ok(manageWorldsSkill.includes('Keep field names like'), 'broadcast preview should keep raw field names out of human-facing text');
    assert.ok(manageWorldsSkill.includes('inspect `list_broadcast_history` or `list_world_activity` before retrying'));

    const helpSkill = await readText(path.join(process.cwd(), 'skills', 'claworld-help', 'SKILL.md'));
    assert.ok(helpSkill.includes('claworld_manage_account(action=view_account)'));
    assert.ok(helpSkill.includes('claworld_manage_account(action=update_human_profile, humanProfile=...)'));
    assert.ok(helpSkill.includes('claworld_manage_account(action=update_agent_profile, agentProfile=...)'));
    assert.ok(helpSkill.includes('`upgradeCommand`'));
    assert.ok(helpSkill.includes('send `/restart`'));
    assert.ok(helpSkill.includes('OpenClaw runtime update'));
    assert.equal(helpSkill.includes('openclaw plugins update @xfxstudio/claworld --dry-run'), false);

    const mainSkill = await readText(path.join(process.cwd(), 'skills', 'claworld-main-session', 'SKILL.md'));
    assert.ok(mainSkill.includes('Before installing, upgrading'));
    assert.ok(mainSkill.includes('read the `claworld-help` skill'));
    assert.ok(mainSkill.includes('claworld_manage_account(action=update_human_profile, humanProfile=...)'));
    assert.ok(mainSkill.includes('claworld_manage_account(action=update_agent_profile, agentProfile=...)'));
    assert.ok(mainSkill.includes('Main Session owns the review instructions'));
    assert.ok(mainSkill.includes('`.claworld/context/PROFILE.md`'));
    assert.ok(mainSkill.includes('`.claworld/context/NOW.md`'));
    assert.ok(mainSkill.includes('host-wide or generic user memory'));

    const managementSkill = await readText(path.join(process.cwd(), 'skills', 'claworld-management-session', 'SKILL.md'));
    assert.ok(managementSkill.includes('`approval_required` is review mode'));
    assert.ok(managementSkill.includes('Accept, reject, or ask the human'));
    assert.ok(managementSkill.includes('No request, review, or accept/reject action reaches you'));
    assert.ok(managementSkill.includes('Always report the outcome to the human'));
    assert.ok(managementSkill.includes('value affects length, not whether to report'));
    assert.ok(managementSkill.includes("use the notification's exact `chatRequestId`"));
    assert.ok(managementSkill.includes('Process every delivered conversation-ended notification'));
    assert.equal(managementSkill.includes('has already been reported successfully'), false);

    assert.deepEqual(markdownHeadings(helpSkill), [
      '# Claworld Help',
      '## When To Read This',
      '## Your Role',
      '## Default Diagnostic Path',
      '## Account And Policy Tools',
      '## Plugin Lifecycle',
      '### First Install',
      '### Upgrade An Installed Plugin',
      '### Uninstall',
      '## Troubleshooting Order',
      '### World, Join, Or Conversation Errors',
      '### Accepting A Request',
      '### Conversation Or Request State',
      '### Conversation Request Targets',
      '## Validation',
      '## Feedback',
    ]);
    assert.deepEqual(markdownHeadings(mainSkill), [
      '# Claworld Main Session Skill',
      '## Your Role',
      '## Sessions',
      '## Talking To The Human',
      '## Working Memory',
      '## Tools',
      '## Actions',
      '### Discovering Worlds',
      '### Joining a World',
      '### Finding Members',
      '### Starting a Conversation',
      '### Inbound Requests',
      '### Exporting a Transcript',
      '### Following Up on Management Reports',
      '## Contact Settings And Review Instructions',
      '## Guardrails',
      '## Verification',
      '## Quick Reference',
      '## When To Load This Skill',
    ]);
    assert.deepEqual(markdownHeadings(manageWorldsSkill), [
      '# Claworld World Management',
      '## Explaining Worlds To The Human',
      '## Public Capabilities',
      '## World Operation Confirmation Rules',
      '## `worldContextText` Minimum Contract',
      '## World Context Templates',
      '## Join And Follow-Up',
      '## Broadcast / Activity',
      '## Common Workflows',
      '### Creating a World',
      '### Managing Owned Worlds',
      '### Managing Joined Worlds',
      '### Reviewing Received Invites',
      '## Quick Reference',
      '## Pitfalls',
      '## Verification',
    ]);
    assert.deepEqual(markdownHeadings(managementSkill), [
      '## Your Role',
      '## Working Memory',
      '## Wake Loop',
      '## Handling Notifications',
      '### Conversation Ended',
      '#### What To Do',
      '#### What To Report',
      '### Chat Request Created',
      '#### What To Do',
      '#### What To Report',
      '### World Invitation Received',
      '#### What To Do',
      '#### What To Report',
      '### World Broadcast Published',
      '#### What To Do',
      '#### What To Report',
      '### Other Notifications',
      '## Reporting',
      '### Report Principles',
      '### What Every Report Should Cover',
      '### Golden Quote',
      '### Information Exchange Opportunity',
      '### Openings: Never The Same Twice',
      '### Weave Your Judgment Into The Narrative',
      "### Combined Reports: Don't Sound Like An Assembly Line",
      '### Quick Reference: Stiff vs. Natural',
      '### Ending: Always Leave A CTA',
      '### Full Examples',
      '### Report Content Guardrails',
      '## Delivery',
      '### Main Session And Human Route',
      '### Preparing The Tool Call',
      '### One-call Reporting',
      '### After The Tool Call',
      '## Proactive Actions',
      '### When to Reach Out',
      '### Starting a World-Scoped Conversation',
      '### Direct Conversations',
      '## Tools',
      '## Guardrails',
      '## Quick Reference',
    ]);

    const runtimeEvent = buildClaworldRuntimeMaintenanceEvent({
      timestamp: '2026-04-22T00:00:00.000Z',
      kind: 'owner_report',
      summary: 'Owner report summarized a completed Claworld chat.',
    });
    assert.equal(runtimeEvent.source, 'claworld_runtime');
    assert.equal(runtimeEvent.kind, 'owner_report');

    await appendClaworldJournalEvent(
      workspaceRoot,
      {
        timestamp: '2026-04-22T00:00:00.000Z',
        source: 'unit',
        kind: 'milestone',
        summary: 'User reviewed a Claworld progress milestone.',
        refs: { worldId: 'world-1' },
      },
    );
    const journal = await readText(path.join(workspaceRoot, '.claworld', 'journal', '2026-04-22.md'));
    assert.ok(journal.includes('User reviewed a Claworld progress milestone.'));
    assert.ok(journal.includes('"schema": "claworld.journal.v2"'));
    assert.ok(journal.includes('"worldId": "world-1"'));

    await updateClaworldSessionDirectory(
      workspaceRoot,
      {
        timestamp: '2026-04-22T00:10:00.000Z',
        source: 'unit',
        scope: 'main',
        relations: {
          localSessionKey: 'agent:main:feishu:direct:ou_123',
          sessionKey: 'agent:main:feishu:direct:ou_123',
          localAgentId: 'main',
        },
      },
    );
    await updateClaworldSessionDirectory(
      workspaceRoot,
      {
        timestamp: '2026-04-22T00:11:00.000Z',
        source: 'unit',
        relations: {
          localSessionKey: 'agent:main:management:agt_alice',
          sessionKey: 'agent:main:management:agt_alice',
          relaySessionKey: 'management:agt_alice',
          localAgentId: 'main',
          targetAgentId: 'agt_alice',
        },
        context: {
          SessionType: 'management',
        },
      },
    );
    const mainManagementDirectory = await readClaworldSessionDirectory(workspaceRoot);
    assert.equal(
      mainManagementDirectory.directory.main.lastActiveSessionKey,
      'agent:main:feishu:direct:ou_123',
    );
    assert.equal(
      mainManagementDirectory.directory.management.lastActiveLocalSessionKey,
      'agent:main:management:agt_alice',
    );
    assert.equal(mainManagementDirectory.directory.management.relaySessionKey, 'management:agt_alice');

    await appendClaworldJournalEvent(
      workspaceRoot,
      buildClaworldRuntimeMaintenanceEvent({
        timestamp: '2026-04-22T00:12:00.000Z',
        kind: 'delivery',
        scope: 'conversation',
        summary: 'Inbound Claworld delivery joined local session.',
        relations: {
          chatRequestId: 'req_1',
          requestId: 'req_1',
          conversationKey: 'pair:agt_alice::agt_bob:world:world-1',
          worldId: 'world-1',
          localSessionKey: 'agent:main:conversation:pair:agt_alice::agt_bob:world:world-1',
          relaySessionKey: 'conversation:pair:agt_alice::agt_bob:world:world-1',
          sessionId: 'session_1',
          sessionFile: '/tmp/claworld/session_1.json',
          transcriptPath: '/tmp/claworld/session_1.transcript.jsonl',
          deliveryId: 'delivery_1',
        },
      }),
    );
    await appendClaworldJournalEvent(
      workspaceRoot,
      buildClaworldRuntimeMaintenanceEvent({
        timestamp: '2026-04-22T00:13:00.000Z',
        kind: 'delivery',
        scope: 'conversation',
        summary: 'Inbound Claworld delivery joined refreshed local session.',
        relations: {
          chatRequestId: 'req_1',
          conversationKey: 'pair:agt_alice::agt_bob:world:world-1',
          localSessionKey: 'agent:main:conversation:pair:agt_alice::agt_bob:world:world-1',
          relaySessionKey: 'conversation:pair:agt_alice::agt_bob:world:world-1',
          sessionId: 'session_2',
          sessionFile: '/tmp/claworld/session_2.json',
          deliveryId: 'delivery_2',
        },
      }),
    );
    await appendClaworldJournalEvent(
      workspaceRoot,
      buildClaworldRuntimeMaintenanceEvent({
        timestamp: '2026-04-22T00:14:00.000Z',
        kind: 'delivery',
        scope: 'conversation',
        summary: 'Another request joined the same local session key.',
        relations: {
          chatRequestId: 'req_2',
          conversationKey: 'pair:agt_alice::agt_bob:world:world-1',
          localSessionKey: 'agent:main:conversation:pair:agt_alice::agt_bob:world:world-1',
          sessionId: 'session_2',
          sessionFile: '/tmp/claworld/session_2.json',
          deliveryId: 'delivery_3',
        },
      }),
    );
    const sessionDirectory = await readClaworldSessionDirectory(workspaceRoot);
    const conversationSession = sessionDirectory.directory.conversationSessions[
      'agent:main:conversation:pair:agt_alice::agt_bob:world:world-1'
    ];
    assert.equal(conversationSession.conversationKey, 'pair:agt_alice::agt_bob:world:world-1');
    assert.equal(Object.prototype.hasOwnProperty.call(conversationSession, 'localSessionKey'), false);
    assert.equal(conversationSession.latest.sessionId, 'session_2');
    assert.equal(conversationSession.latest.sessionFile, '/tmp/claworld/session_2.json');
    assert.equal(Object.prototype.hasOwnProperty.call(conversationSession.latest, 'transcriptPath'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(conversationSession, 'latestSessionId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(conversationSession.chatRequests.req_1, 'chatRequestId'), false);
    assert.equal(conversationSession.chatRequests.req_1.artifacts.length, 2);
    assert.equal(conversationSession.chatRequests.req_1.artifacts[0].transcriptPath, '/tmp/claworld/session_1.transcript.jsonl');
    assert.equal(Object.prototype.hasOwnProperty.call(conversationSession.chatRequests.req_1.artifacts[1], 'transcriptPath'), false);
    assert.equal(conversationSession.chatRequests.req_2.artifacts.length, 1);
    assert.equal(
      sessionDirectory.directory.main.lastActiveSessionKey,
      'agent:main:feishu:direct:ou_123',
    );

    const l1NoOpOutput = validateClaworldMaintenanceOutput(
      CLAWORLD_MAINTENANCE_RUN_TYPES.L1_NOW_REFRESH,
      { nowMd: { operation: 'no_op', rationale: 'fresh' } },
    );
    assert.deepEqual(l1NoOpOutput.patches, [
      {
        operation: 'no_op',
        target: 'context/NOW.md',
        content: '',
        rationale: 'fresh',
      },
    ]);

    const l1ReplaceOutput = validateClaworldMaintenanceOutput(
      CLAWORLD_MAINTENANCE_RUN_TYPES.L1_NOW_REFRESH,
      {
        nowMd: {
          operation: 'replace',
          content: buildNowFixture('- [ ] id: goal-object | status: active | next: object form | report: main | source: unit | updated: 2026-04-22'),
        },
      },
    );
    assert.equal(l1ReplaceOutput.patches[0].content.includes('object form'), true);
    assert.throws(
      () => validateClaworldMaintenanceOutput(
        CLAWORLD_MAINTENANCE_RUN_TYPES.L1_NOW_REFRESH,
        { nowMd: { operation: 'replace', content: '# Claworld Now\n\n## Current Focus\n- old format\n' } },
      ),
      /missing required section ## Active Goals/,
    );
    assert.throws(
      () => validateClaworldMaintenanceOutput(
        CLAWORLD_MAINTENANCE_RUN_TYPES.L2_MEMORY_PROFILE_REVIEW,
        {
          memoryMd: {
            operation: 'replace',
            content: '# Claworld Memory\n\n## Memories\nThis is an unstructured paragraph.\n',
          },
        },
      ),
      /must use bullet lines/,
    );

    assert.throws(
      () => validateClaworldMaintenanceOutput(
        CLAWORLD_MAINTENANCE_RUN_TYPES.L1_NOW_REFRESH,
        { profileMd: { operation: 'replace', content: '# should not be allowed\n' } },
      ),
      /cannot write target context\/PROFILE.md/,
    );
    assert.throws(
      () => validateClaworldMaintenanceOutput(
        CLAWORLD_MAINTENANCE_RUN_TYPES.L2_MEMORY_PROFILE_REVIEW,
        { patches: [{ target: 'MEMORY.md', operation: 'replace', content: '# global memory\n' }] },
      ),
      /Global MEMORY.md/,
    );
    assert.throws(
      () => validateClaworldMaintenanceOutput(
        'L2_PROFILE_MEMORY_REVIEW',
        { memoryMd: { operation: 'no_op', rationale: 'old run type name' } },
      ),
      /Unsupported Claworld maintenance run type/,
    );

    const bootstrapContext = resolveClaworldBootstrapContext(
      { session: { sessionKey: 'agent:alice:main' } },
      { channel: 'claworld', sessionType: 'conversation' },
    );
    assert.equal(bootstrapContext.sessionKey, 'agent:alice:main');
    assert.equal(bootstrapContext.channel, 'claworld');
    assert.equal(bootstrapContext.sessionType, 'conversation');
    assert.equal(
      resolveClaworldBootstrapTarget({ sessionKey: 'agent:alice:main' }),
      CLAWORLD_BOOTSTRAP_TARGETS.MAIN,
    );
    assert.equal(
      resolveClaworldBootstrapTarget({
        sessionKey: 'agent:alice:claworld:direct:agt_bob@relay.local',
      }),
      CLAWORLD_BOOTSTRAP_TARGETS.CLAWORLD_CONVERSATION,
    );
    assert.equal(
      resolveClaworldBootstrapTarget({
        sessionType: 'management',
        sessionKey: 'management:alice',
      }),
      CLAWORLD_BOOTSTRAP_TARGETS.MANAGEMENT,
    );
    assert.equal(
      resolveClaworldBootstrapTarget({
        sessionKey: 'agent:alice:management:agt_alice',
      }),
      CLAWORLD_BOOTSTRAP_TARGETS.MANAGEMENT,
    );
    assert.equal(
      resolveClaworldBootstrapTarget({
        sessionKey: 'agent:main:management:agt_alice',
      }),
      CLAWORLD_BOOTSTRAP_TARGETS.MANAGEMENT,
    );
    assert.equal(
      resolveClaworldBootstrapTarget({
        sessionKey: 'agent:alice:claworld:orchestration',
      }),
      CLAWORLD_BOOTSTRAP_TARGETS.MANAGEMENT,
    );
    assert.equal(
      resolveClaworldBootstrapTarget({
        channel: 'claworld',
        sessionType: 'operator',
      }),
      CLAWORLD_BOOTSTRAP_TARGETS.MANAGEMENT,
    );
    assert.equal(
      resolveClaworldBootstrapTarget({
        channel: 'telegram',
        sessionType: 'conversation',
        sessionKey: 'agent:alice:telegram:direct:user_123',
      }),
      CLAWORLD_BOOTSTRAP_TARGETS.MAIN,
    );
    assert.equal(
      resolveClaworldBootstrapTarget({
        channelId: 'feishu',
        sessionKey: 'agent:main:feishu:direct:ou_123',
      }),
      CLAWORLD_BOOTSTRAP_TARGETS.MAIN,
    );
    assert.equal(
      resolveClaworldBootstrapTarget({
        sessionKey: 'agent:alice:conversation:pair:agt_alice::agt_bob:world:dating-demo-world',
      }),
      CLAWORLD_BOOTSTRAP_TARGETS.CLAWORLD_CONVERSATION,
    );
    assert.equal(
      resolveClaworldBootstrapTarget({
        sessionKey: 'agent:main:conversation:pair:agt_alice::agt_bob:world:dating-demo-world',
      }),
      CLAWORLD_BOOTSTRAP_TARGETS.CLAWORLD_CONVERSATION,
    );

    await fs.writeFile(
      path.join(workspaceRoot, '.claworld', 'context', 'NOW.md'),
      buildNowFixture('- [ ] id: goal-follow-up | status: active | next: current turn needs follow-up | report: main | source: unit | updated: 2026-04-22'),
      'utf8',
    );
    await fs.writeFile(
      path.join(workspaceRoot, '.claworld', 'context', 'PROFILE.md'),
      buildProfileFixture('- 2026-04-22 likes warm intros. Source: unit.'),
      'utf8',
    );
    await fs.writeFile(
      path.join(workspaceRoot, '.claworld', 'context', 'MEMORY.md'),
      buildMemoryFixture('- 2026-04-22 [person] met Bob in world-1. Source: unit.'),
      'utf8',
    );

    const mainBootstrap = await buildClaworldBootstrapPromptContext({
      workspaceDir: workspaceRoot,
      sessionKey: 'agent:alice:main',
    });
    assert.equal(mainBootstrap.target, CLAWORLD_BOOTSTRAP_TARGETS.MAIN);
    assert.equal(mainBootstrap.pointerInjected, true);
    assert.ok(mainBootstrap.appendSystemContext.includes('# About working with Claworld'));
    assert.ok(mainBootstrap.appendSystemContext.includes(path.join(workspaceRoot, '.claworld', 'context', 'MEMORY.md')));
    assert.ok(mainBootstrap.appendSystemContext.includes(path.join(workspaceRoot, '.claworld', 'context', 'NOW.md')));
    assert.ok(mainBootstrap.appendSystemContext.includes(path.join(workspaceRoot, '.claworld', 'context', 'PROFILE.md')));
    assert.ok(mainBootstrap.appendSystemContext.includes(path.join(workspaceRoot, '.claworld', 'sessions', 'index.json')));
    assert.ok(mainBootstrap.appendSystemContext.includes('met Bob in world-1'));
    assert.ok(mainBootstrap.appendSystemContext.includes('Claworld is a social app that you and your human are connected to'));
    assert.ok(mainBootstrap.appendSystemContext.includes('A Management Session handles Claworld updates'));
    assert.ok(mainBootstrap.appendSystemContext.includes('records every human-facing Management report in this Main Session'));
    assert.ok(mainBootstrap.appendSystemContext.includes('Do not proactively contact Conversation Sessions'));
    assert.ok(mainBootstrap.appendSystemContext.includes('## Managing PROFILE.md'));
    assert.ok(mainBootstrap.appendSystemContext.includes('You are responsible to maintain'));
    assert.ok(mainBootstrap.appendSystemContext.includes('Claworld-relevant profile or behavior guidance'));
    assert.ok(mainBootstrap.appendSystemContext.includes('Keep single-event conversation details'));
    assert.ok(mainBootstrap.appendSystemContext.includes('When you report Claworld activity to the human'));
    assert.ok(mainBootstrap.appendSystemContext.includes('sound like a normal person giving a useful update'));
    assert.ok(mainBootstrap.appendSystemContext.includes('## Required Skill Routing'));
    assert.ok(mainBootstrap.appendSystemContext.includes('read the `claworld-manage-worlds` skill again'));
    assert.ok(mainBootstrap.appendSystemContext.includes('read the `claworld-help` skill'));
    assert.ok(mainBootstrap.appendSystemContext.includes('## Claworld Memory Routing'));
    assert.ok(mainBootstrap.appendSystemContext.includes('## World Operation Confirmation'));
    assert.ok(mainBootstrap.appendSystemContext.includes('## Feedback Routing'));
    assert.ok(mainBootstrap.appendSystemContext.includes('## Conversation Transcript Images'));
    // Skill body content (injected from claworld-main-session/SKILL.md)
    assert.ok(mainBootstrap.appendSystemContext.includes('\n## Contact Settings And Review Instructions\n'));
    assert.ok(mainBootstrap.appendSystemContext.includes('\n## Tools\n'));
    assert.ok(mainBootstrap.appendSystemContext.includes('\n### Joining a World\n'));
    assert.ok(mainBootstrap.appendSystemContext.includes('\n### Inbound Requests\n'));
    assert.ok(mainBootstrap.appendSystemContext.includes('\n## Talking To The Human\n'));
    assert.ok(mainBootstrap.appendSystemContext.includes('participantContextField'));
    assert.ok(mainBootstrap.appendSystemContext.includes('Select only visible original messages'));
    assert.ok(mainBootstrap.appendSystemContext.includes('writes local SVG and PNG files'));
    assert.equal(mainBootstrap.appendSystemContext.includes('# Claworld Context Pointer'), false);

    const externalMainBootstrap = await buildClaworldBootstrapPromptContext({
      workspaceDir: workspaceRoot,
      channelId: 'feishu',
      sessionKey: 'agent:main:feishu:direct:ou_123',
    });
    assert.equal(externalMainBootstrap.target, CLAWORLD_BOOTSTRAP_TARGETS.MAIN);
    assert.equal(externalMainBootstrap.pointerInjected, true);
    assert.ok(externalMainBootstrap.appendSystemContext.includes('# About working with Claworld'));
    assert.ok(externalMainBootstrap.appendSystemContext.includes(path.join(workspaceRoot, '.claworld', 'context', 'MEMORY.md')));
    assert.ok(externalMainBootstrap.appendSystemContext.includes(path.join(workspaceRoot, '.claworld', 'sessions', 'index.json')));
    assert.ok(externalMainBootstrap.appendSystemContext.includes('met Bob in world-1'));
    assert.ok(externalMainBootstrap.appendSystemContext.includes('Do not proactively contact Conversation Sessions'));
    assert.equal(externalMainBootstrap.appendSystemContext.includes('# Claworld Context Pointer'), false);

    const conversationBootstrap = await buildClaworldBootstrapPromptContext({
      workspaceDir: workspaceRoot,
      channel: 'claworld',
      sessionType: 'conversation',
    });
    assert.equal(conversationBootstrap.target, CLAWORLD_BOOTSTRAP_TARGETS.CLAWORLD_CONVERSATION);
    assert.equal(conversationBootstrap.pointerInjected, false);
    assert.ok(conversationBootstrap.appendSystemContext.includes('.claworld/context/NOW.md'));
    assert.ok(conversationBootstrap.appendSystemContext.includes('.claworld/context/MEMORY.md'));
    assert.ok(conversationBootstrap.appendSystemContext.includes('.claworld/context/PROFILE.md'));
    assert.ok(conversationBootstrap.appendSystemContext.includes('You should never report your activity to the human or modify the claworld working memory.'));
    assert.equal(conversationBootstrap.appendSystemContext.includes('# Claworld Context Pointer'), false);

    const agentScopedConversationBootstrap = await buildClaworldBootstrapPromptContext({
      workspaceDir: workspaceRoot,
      sessionKey: 'agent:alice:conversation:pair:agt_alice::agt_bob:world:dating-demo-world',
    });
    assert.equal(agentScopedConversationBootstrap.target, CLAWORLD_BOOTSTRAP_TARGETS.CLAWORLD_CONVERSATION);
    assert.equal(agentScopedConversationBootstrap.pointerInjected, false);
    assert.ok(agentScopedConversationBootstrap.appendSystemContext.includes('.claworld/context/NOW.md'));
    assert.ok(agentScopedConversationBootstrap.appendSystemContext.includes('.claworld/context/MEMORY.md'));
    assert.ok(agentScopedConversationBootstrap.appendSystemContext.includes('.claworld/context/PROFILE.md'));
    assert.ok(agentScopedConversationBootstrap.appendSystemContext.includes('You should never report your activity to the human or modify the claworld working memory.'));
    assert.equal(agentScopedConversationBootstrap.appendSystemContext.includes('# Claworld Context Pointer'), false);

    const managementBootstrap = await buildClaworldBootstrapPromptContext({
      workspaceDir: workspaceRoot,
      sessionType: 'management',
      sessionKey: 'management:alice',
    });
    assert.equal(managementBootstrap.target, CLAWORLD_BOOTSTRAP_TARGETS.MANAGEMENT);
    assert.equal(managementBootstrap.pointerInjected, false);
    assert.equal(managementBootstrap.managementPolicyInjected, true);
    assert.ok(managementBootstrap.appendSystemContext.includes('# Claworld Management Session Instructions'));
    assert.ok(managementBootstrap.appendSystemContext.includes('You are the private Claworld Management Session for this account'));
    assert.ok(managementBootstrap.appendSystemContext.includes('## Session Roles'));
    assert.ok(managementBootstrap.appendSystemContext.includes('External Main Session is the human chat'));
    assert.ok(managementBootstrap.appendSystemContext.includes('Management Session is you'));
    assert.ok(managementBootstrap.appendSystemContext.includes('Conversation Session handles live peer-facing Claworld chat'));
    assert.ok(managementBootstrap.appendSystemContext.includes('## First Rule'));
    assert.ok(managementBootstrap.appendSystemContext.includes('read the `claworld-management-session` skill before deciding what to do'));
    assert.ok(managementBootstrap.appendSystemContext.includes('A memory compaction is a maintenance turn only'));
    assert.ok(managementBootstrap.appendSystemContext.includes('handle the pending or next Claworld notification from scratch'));
    assert.ok(managementBootstrap.appendSystemContext.includes('## Human-Facing Management Reports'));
    assert.ok(managementBootstrap.appendSystemContext.includes('Use `claworld_report_to_human` once'));
    assert.ok(managementBootstrap.appendSystemContext.includes('A normal Management assistant reply stays inside the Management Session'));
    assert.ok(managementBootstrap.appendSystemContext.includes('world.broadcast_published:<broadcastId>'));
    assert.ok(managementBootstrap.appendSystemContext.includes('Do not call `claworld_render_transcript_report` in Management'));
    assert.ok(managementBootstrap.appendSystemContext.includes('source.kind=`notification`'));
    assert.ok(managementBootstrap.appendSystemContext.includes('Non-conversation reports contain text only'));
    assert.ok(managementBootstrap.appendSystemContext.includes('## Active Conversation Admission'));
    assert.ok(managementBootstrap.appendSystemContext.includes('If the backend returns `conversation_already_active`, do not retry'));
    assert.ok(managementBootstrap.appendSystemContext.includes("use the notification's exact `chatRequestId`"));
    assert.ok(managementBootstrap.appendSystemContext.includes('Process every delivered conversation-ended notification'));
    assert.equal(managementBootstrap.appendSystemContext.includes('has already been reported successfully'), false);
    assert.ok(managementBootstrap.appendSystemContext.includes('## Transcript Report Delivery'));
    assert.ok(managementBootstrap.appendSystemContext.includes('Every conversation-ended report includes its transcript images'));
    assert.ok(managementBootstrap.appendSystemContext.includes('localTranscriptEpisode.messages'));
    assert.ok(managementBootstrap.appendSystemContext.includes('what was actually discussed in this conversation'));
    assert.ok(managementBootstrap.appendSystemContext.includes('anything unrelated to the content'));
    assert.ok(managementBootstrap.appendSystemContext.includes('Call `claworld_report_to_human` once'));
    assert.ok(managementBootstrap.appendSystemContext.includes('transcript={mode: "stored", topic: "<exact episode topic>"}'));
    assert.ok(managementBootstrap.appendSystemContext.includes('at least one Golden Quote or vivid highlighted moment'));
    assert.ok(managementBootstrap.appendSystemContext.includes('contextSynced=true, textSent=true, and every page sent'));
    assert.ok(managementBootstrap.appendSystemContext.includes('## Local Files'));
    assert.ok(managementBootstrap.appendSystemContext.includes('PROFILE.md:'));
    assert.ok(managementBootstrap.appendSystemContext.includes('sessions/index.json:'));
    // Skill body content (injected from claworld-management-session/SKILL.md)
    assert.ok(managementBootstrap.appendSystemContext.includes('\n### Chat Request Created\n'));
    assert.ok(managementBootstrap.appendSystemContext.includes('`approval_required` is review mode'));
    assert.ok(managementBootstrap.appendSystemContext.includes('\n## Reporting\n'));
    assert.ok(managementBootstrap.appendSystemContext.includes('Always report the outcome to the human'));
    assert.equal(managementBootstrap.appendSystemContext.includes('sessions_send'), false);
    assert.equal(managementBootstrap.appendSystemContext.includes('ANNOUNCE_READY'), false);
    assert.ok(managementBootstrap.appendSystemContext.includes('\n### World Broadcast Published\n'));
    assert.ok(managementBootstrap.appendSystemContext.includes('\n## Working Memory\n'));
    assert.ok(managementBootstrap.appendSystemContext.includes('\n## Wake Loop\n'));
    assert.ok(managementBootstrap.appendSystemContext.includes('\n#### What To Report\n'));
    assert.ok(managementBootstrap.appendSystemContext.includes('Every conversation-ended report includes a text summary and a transcript image'));
    assert.ok(managementBootstrap.appendSystemContext.includes('The same person can matter differently in different'));
    assert.equal(managementBootstrap.appendSystemContext.includes('## Runtime Hints'), false);
    assert.equal(managementBootstrap.appendSystemContext.includes('journal meaningful side effects'), false);
    assert.equal(managementBootstrap.appendSystemContext.includes('## Event Handling'), false);
    assert.equal(managementBootstrap.appendSystemContext.includes('## Reporting Route'), false);
    assert.equal(managementBootstrap.appendSystemContext.includes('This startup prompt is the operating map'), false);
    assert.equal(managementBootstrap.appendSystemContext.includes('## File Schemas'), false);
    assert.equal(managementBootstrap.appendSystemContext.includes('Testing observability is intentionally high'), false);
    assert.ok(managementBootstrap.appendSystemContext.includes('# Claworld Management Startup Memory'));
    assert.ok(managementBootstrap.appendSystemContext.includes(path.join(workspaceRoot, '.claworld', 'context', 'PROFILE.md')));
    assert.ok(managementBootstrap.appendSystemContext.includes(path.join(workspaceRoot, '.claworld', 'context', 'MEMORY.md')));
    assert.ok(managementBootstrap.appendSystemContext.includes(path.join(workspaceRoot, '.claworld', 'context', 'NOW.md')));
    assert.ok(managementBootstrap.appendSystemContext.includes(path.join(workspaceRoot, '.claworld', 'sessions', 'index.json')));
    assert.equal(managementBootstrap.appendSystemContext.includes('agent:main:feishu:direct:ou_123'), false);
    assert.ok(managementBootstrap.appendSystemContext.includes('likes warm intros'));
    assert.ok(managementBootstrap.appendSystemContext.includes('met Bob in world-1'));
    assert.ok(managementBootstrap.appendSystemContext.includes('current turn needs follow-up'));
    assert.equal(managementBootstrap.appendSystemContext.includes('# Claworld Context Pointer'), false);
    assert.ok(
      managementBootstrap.appendSystemContext.indexOf('# Claworld Management Session Instructions')
        < managementBootstrap.appendSystemContext.indexOf('# Claworld Management Startup Memory'),
    );

    const orchestrationBootstrap = await buildClaworldBootstrapPromptContext({
      workspaceDir: workspaceRoot,
      sessionKey: 'agent:alice:claworld:orchestration',
    });
    assert.equal(orchestrationBootstrap.target, CLAWORLD_BOOTSTRAP_TARGETS.MANAGEMENT);
    assert.equal(orchestrationBootstrap.managementPolicyInjected, true);
    assert.ok(orchestrationBootstrap.appendSystemContext.includes('# Claworld Management Session Instructions'));
    assert.ok(orchestrationBootstrap.appendSystemContext.includes(path.join(workspaceRoot, '.claworld', 'context', 'NOW.md')));
    assert.ok(orchestrationBootstrap.appendSystemContext.includes(path.join(workspaceRoot, '.claworld', 'context', 'MEMORY.md')));
    assert.ok(orchestrationBootstrap.appendSystemContext.includes(path.join(workspaceRoot, '.claworld', 'context', 'PROFILE.md')));

    const fallbackBootstrap = await buildClaworldBootstrapPromptContext({
      channel: 'claworld',
      sessionType: 'conversation',
    });
    assert.equal(fallbackBootstrap.target, CLAWORLD_BOOTSTRAP_TARGETS.CLAWORLD_CONVERSATION);
    assert.deepEqual(
      fallbackBootstrap.fallbackFiles,
      [
        '.claworld/context/NOW.md',
        '.claworld/context/MEMORY.md',
        '.claworld/context/PROFILE.md',
      ],
    );
    assert.ok(fallbackBootstrap.appendSystemContext.includes('No local content was available'));

    const budgetWorkspace = path.join(tempRoot, 'budget-workspace');
    await ensureClaworldWorkingMemory(budgetWorkspace);
    await fs.writeFile(
      path.join(budgetWorkspace, '.claworld', 'context', 'NOW.md'),
      `# Claworld Now\n\n${'N'.repeat(300)}\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(budgetWorkspace, '.claworld', 'context', 'MEMORY.md'),
      `# Claworld Memory\n\n${'M'.repeat(300)}\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(budgetWorkspace, '.claworld', 'context', 'PROFILE.md'),
      `# Claworld Profile\n\n${'P'.repeat(300)}\n`,
      'utf8',
    );
    const truncatedBootstrap = await buildClaworldBootstrapPromptContext(
      {
        workspaceDir: budgetWorkspace,
        sessionKey: 'agent:alice:claworld:direct:agt_bob@relay.local',
      },
      {
        maxCharsPerFile: 90,
        maxTotalChars: 700,
      },
    );
    assert.equal(truncatedBootstrap.target, CLAWORLD_BOOTSTRAP_TARGETS.CLAWORLD_CONVERSATION);
    assert.equal(truncatedBootstrap.truncated, true);
    assert.ok(truncatedBootstrap.appendSystemContext.includes('# Claworld Conversation Startup Context'));
    assert.ok(truncatedBootstrap.appendSystemContext.includes('## Conversation Behavior'));
    assert.ok(truncatedBootstrap.appendSystemContext.includes('You should never report your activity to the human or modify the claworld working memory.'));
    assert.ok(truncatedBootstrap.appendSystemContext.includes('Truncated'));
    assert.deepEqual(
      truncatedBootstrap.omittedFiles,
      [
        '.claworld/context/MEMORY.md',
        '.claworld/context/PROFILE.md',
      ],
    );
    assert.ok(truncatedBootstrap.appendSystemContext.includes('Truncated'));

    const l1Result = await runClaworldMemoryMaintenance(
      CLAWORLD_MAINTENANCE_RUN_TYPES.L1_NOW_REFRESH,
      { events: [{ summary: 'Refresh now.' }] },
      {
        workspaceRoot,
        output: {
          nowMd: buildNowFixture('- [ ] id: goal-l1 | status: active | next: refreshed by L1 | report: main | source: unit | updated: 2026-04-22'),
          journalAppendMd: '## 2026-04-22\n- L1 refreshed NOW.\n',
        },
        timestamp: '2026-04-22T00:00:00.000Z',
      },
    );
    assert.equal(l1Result.ok, true);
    assert.ok((await readText(nowPath)).includes('refreshed by L1'));

    const l2Result = await runClaworldMemoryMaintenance(
      CLAWORLD_MAINTENANCE_RUN_TYPES.L2_MEMORY_PROFILE_REVIEW,
      { events: [{ summary: 'Review durable memory.' }] },
      {
        workspaceRoot,
        output: {
          profileMd: {
            operation: 'replace',
            content: buildProfileFixture('- 2026-04-22 likes concise world summaries. Source: unit.'),
          },
          memoryMd: {
            operation: 'replace',
            content: buildMemoryFixture('- 2026-04-22 [world] joined world-1. Source: unit.'),
          },
        },
      },
    );
    assert.equal(l2Result.applied.length, 2);
    assert.ok((await readText(path.join(workspaceRoot, '.claworld', 'context', 'PROFILE.md'))).includes('concise world summaries'));
    assert.ok((await readText(path.join(workspaceRoot, '.claworld', 'context', 'MEMORY.md'))).includes('joined world-1'));

    await assert.rejects(
      runClaworldMemoryMaintenance(
        CLAWORLD_MAINTENANCE_RUN_TYPES.L1_NOW_REFRESH,
        {},
        {
          workspaceRoot,
          output: { nowMd: { operation: 'replace', content: '' } },
        },
      ),
      /must start with # Claworld Now/,
    );

    const hooks = new Map();
    const hookWorkspace = path.join(tempRoot, 'hook-workspace');
    await fs.mkdir(hookWorkspace, { recursive: true });
    await fs.writeFile(path.join(hookWorkspace, 'AGENTS.md'), '# user agent file\n', 'utf8');
    registerClaworldPluginFull(
      {
        on(name, handler) {
          hooks.set(name, handler);
        },
        logger: { warn() {} },
      },
      { id: 'claworld' },
    );

    const promptHookResult = await hooks.get('before_prompt_build')(
      { workspaceDir: hookWorkspace, sessionKey: 'agent:alice:main' },
      {},
    );
    assert.equal(promptHookResult.appendSystemContext.includes('.claworld/INDEX.md'), false);
    assert.ok(promptHookResult.appendSystemContext.includes(path.join(hookWorkspace, '.claworld', 'context', 'MEMORY.md')));
    assert.ok(promptHookResult.appendSystemContext.includes(path.join(hookWorkspace, '.claworld', 'context', 'NOW.md')));
    assert.ok(promptHookResult.appendSystemContext.includes(path.join(hookWorkspace, '.claworld', 'context', 'PROFILE.md')));
    assert.ok(promptHookResult.appendSystemContext.includes(path.join(hookWorkspace, '.claworld', 'sessions', 'index.json')));
    assert.equal(await readText(path.join(hookWorkspace, 'AGENTS.md')), '# user agent file\n');
    await fs.access(path.join(hookWorkspace, '.claworld', 'INDEX.md'));

    const conversationPromptHookResult = await hooks.get('before_prompt_build')(
      {
        workspaceDir: hookWorkspace,
        channel: 'claworld',
        sessionType: 'conversation',
      },
      {},
    );
    assert.equal(conversationPromptHookResult.appendSystemContext.includes('# Claworld Context Pointer'), false);
    assert.ok(conversationPromptHookResult.appendSystemContext.includes('.claworld/context/NOW.md'));
    assert.ok(conversationPromptHookResult.appendSystemContext.includes('.claworld/context/MEMORY.md'));
    assert.ok(conversationPromptHookResult.appendSystemContext.includes('.claworld/context/PROFILE.md'));

    const requestHookResult = await hooks.get('before_tool_call')(
      {
        toolName: 'claworld_manage_conversations',
        workspaceDir: hookWorkspace,
        params: { accountId: 'claworld', action: 'request' },
        timestamp: '2026-04-22T00:30:00.000Z',
      },
      {
        agentId: 'main',
        sessionKey: 'agent:main:feishu:direct:ou_123',
        sessionType: 'direct',
      },
    );
    assert.equal(
      requestHookResult.params.__claworldRequesterSessionKey,
      'agent:main:feishu:direct:ou_123',
    );
    const hookSessionDirectory = await readClaworldSessionDirectory(hookWorkspace);
    assert.equal(
      hookSessionDirectory.directory.main.lastActiveSessionKey,
      'agent:main:feishu:direct:ou_123',
    );

    await hooks.get('after_tool_call')(
      {
        toolName: 'claworld_search_worlds',
        workspaceDir: hookWorkspace,
        params: { accountId: 'claworld', worldId: 'world-2' },
        timestamp: '2026-04-22T01:00:00.000Z',
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'ok',
                tool: 'claworld_search_worlds',
                accountId: 'claworld',
                worldId: 'world-2',
                summary: 'Found worlds.',
              }),
            },
          ],
        },
      },
      {},
    );
    const hookJournal = await readText(path.join(hookWorkspace, '.claworld', 'journal', '2026-04-22.md'));
    assert.ok(hookJournal.includes('claworld_search_worlds completed'));
    assert.ok(hookJournal.includes('worldId=world-2'));
    assert.ok(hookJournal.includes('"scope": "runtime"'));
    assert.ok(hookJournal.includes('"name": "claworld_search_worlds"'));
    assert.ok(hookJournal.includes('"worldId": "world-2"'));
    const hookNow = await readText(path.join(hookWorkspace, '.claworld', 'context', 'NOW.md'));
    const hookMemory = await readText(path.join(hookWorkspace, '.claworld', 'context', 'MEMORY.md'));
    assert.equal(hookNow.includes('## Auto L1 Refresh'), false);
    assert.equal(hookNow.includes('worldId=world-2'), false);
    assert.equal(hookMemory.includes('## Auto L2 Durable Signals'), false);
    assert.equal(hookMemory.includes('worldId=world-2'), false);

    await hooks.get('after_tool_call')(
      {
        toolName: 'claworld_search_worlds',
        workspaceDir: hookWorkspace,
        params: { accountId: 'claworld', worldId: 'world-main' },
        timestamp: '2026-04-23T01:00:00.000Z',
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ status: 'ok', tool: 'claworld_search_worlds' }),
            },
          ],
        },
      },
      { agentId: 'alice', sessionKey: 'agent:alice:main', sessionType: 'main' },
    );
    const mainToolJournal = await readText(path.join(hookWorkspace, '.claworld', 'journal', '2026-04-23.md'));
    assert.ok(mainToolJournal.includes('"scope": "main"'));
    assert.ok(mainToolJournal.includes('"localSessionKey": "agent:alice:main"'));

    await hooks.get('after_tool_call')(
      {
        toolName: 'claworld_search_worlds',
        workspaceDir: hookWorkspace,
        params: { accountId: 'claworld', worldId: 'world-management' },
        timestamp: '2026-04-24T01:00:00.000Z',
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ status: 'ok', tool: 'claworld_search_worlds' }),
            },
          ],
        },
      },
      {
        agentId: 'alice',
        SessionKey: 'agent:alice:management:agt_alice',
        SessionType: 'management',
      },
    );
    const managementToolJournal = await readText(path.join(hookWorkspace, '.claworld', 'journal', '2026-04-24.md'));
    assert.ok(managementToolJournal.includes('"scope": "management"'));
    assert.ok(managementToolJournal.includes('"localSessionKey": "agent:alice:management:agt_alice"'));

    const conversationLocalSessionKey = 'agent:alice:conversation:pair:agt_alice::agt_bob:direct';
    await hooks.get('after_tool_call')(
      {
        toolName: 'claworld_manage_conversations',
        workspaceDir: hookWorkspace,
        params: {
          accountId: 'claworld',
          action: 'get_state',
          conversationKey: 'pair:agt_alice::agt_bob:direct',
        },
        timestamp: '2026-04-24T02:00:00.000Z',
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'get_state',
                accountId: 'claworld',
                filters: { conversationKey: 'pair:agt_alice::agt_bob:direct' },
                chats: [
                  {
                    chatRequestId: 'req_state_1',
                    status: 'ended',
                    direction: 'inbound',
                    conversationKey: 'pair:agt_alice::agt_bob:direct',
                    localSessionKey: conversationLocalSessionKey,
                    conversation: { mode: 'direct', worldId: null },
                  },
                ],
                tool: 'claworld_manage_conversations',
              }),
            },
          ],
        },
      },
      {
        agentId: 'alice',
        SessionKey: 'agent:alice:management:agt_alice',
        SessionType: 'management',
        SessionId: 'management-session-id',
        SessionFile: '/tmp/claworld/management-session.jsonl',
      },
    );
    const conversationToolJournal = await readText(path.join(hookWorkspace, '.claworld', 'journal', '2026-04-24.md'));
    assert.ok(conversationToolJournal.includes('"scope": "conversation"'));
    assert.ok(conversationToolJournal.includes('"chatRequestId": "req_state_1"'));
    assert.ok(conversationToolJournal.includes('"localSessionKey": "agent:alice:conversation:pair:agt_alice::agt_bob:direct"'));
    assert.ok(conversationToolJournal.includes('"requesterSessionKey": "agent:alice:management:agt_alice"'));
    assert.ok(conversationToolJournal.includes('"targetSessionKey": "agent:alice:conversation:pair:agt_alice::agt_bob:direct"'));

    const conversationToolDirectory = await readClaworldSessionDirectory(hookWorkspace);
    const indexedConversation = conversationToolDirectory.directory.conversationSessions[conversationLocalSessionKey];
    assert.equal(indexedConversation.conversationKey, 'pair:agt_alice::agt_bob:direct');
    assert.ok(indexedConversation.chatRequests.req_state_1);
    assert.equal(Object.prototype.hasOwnProperty.call(indexedConversation.chatRequests.req_state_1, 'artifacts'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(indexedConversation, 'latest'), false);

    const defaultsWorkspace = path.join(tempRoot, 'defaults-workspace');
    const defaultsHooks = new Map();
    registerClaworldPluginFull(
      {
        on(name, handler) {
          defaultsHooks.set(name, handler);
        },
        config: {
          agents: {
            list: [{ id: 'main' }],
            defaults: { workspace: defaultsWorkspace },
          },
        },
        logger: { warn() {} },
      },
      { id: 'claworld' },
    );
    await defaultsHooks.get('after_tool_call')(
      {
        toolName: 'claworld_search_worlds',
        params: { accountId: 'claworld', worldId: 'world-defaults' },
        timestamp: '2026-04-22T02:00:00.000Z',
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ status: 'ok', tool: 'claworld_search_worlds' }),
            },
          ],
        },
      },
      { agentId: 'main' },
    );
    const defaultsJournal = await readText(path.join(defaultsWorkspace, '.claworld', 'journal', '2026-04-22.md'));
    assert.ok(defaultsJournal.includes('"worldId": "world-defaults"'));

    const objectWorkspace = path.join(tempRoot, 'object-workspace');
    const objectHooks = new Map();
    registerClaworldPluginFull(
      {
        on(name, handler) {
          objectHooks.set(name, handler);
        },
        config: {
          agents: {
            list: { main: { workspace: objectWorkspace } },
            defaults: { workspace: path.join(tempRoot, 'object-fallback') },
          },
        },
        logger: { warn() {} },
      },
      { id: 'claworld' },
    );
    await objectHooks.get('after_tool_call')(
      {
        toolName: 'claworld_search_worlds',
        params: { accountId: 'claworld', worldId: 'world-object' },
        timestamp: '2026-04-22T03:00:00.000Z',
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ status: 'ok', tool: 'claworld_search_worlds' }),
            },
          ],
        },
      },
      { agentId: 'main' },
    );
    const objectJournal = await readText(path.join(objectWorkspace, '.claworld', 'journal', '2026-04-22.md'));
    assert.ok(objectJournal.includes('"worldId": "world-object"'));

    const agentWorkspace = path.join(tempRoot, 'agent-workspace');
    const fallbackWorkspace = path.join(tempRoot, 'agent-fallback');
    const priorityHooks = new Map();
    registerClaworldPluginFull(
      {
        on(name, handler) {
          priorityHooks.set(name, handler);
        },
        config: {
          agents: {
            list: [{ id: 'main', workspace: agentWorkspace }],
            defaults: { workspace: fallbackWorkspace },
          },
        },
        logger: { warn() {} },
      },
      { id: 'claworld' },
    );
    await priorityHooks.get('after_tool_call')(
      {
        toolName: 'claworld_search_worlds',
        params: { accountId: 'claworld', worldId: 'world-agent' },
        timestamp: '2026-04-22T04:00:00.000Z',
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ status: 'ok', tool: 'claworld_search_worlds' }),
            },
          ],
        },
      },
      { agentId: 'main' },
    );
    const agentJournal = await readText(path.join(agentWorkspace, '.claworld', 'journal', '2026-04-22.md'));
    assert.ok(agentJournal.includes('"worldId": "world-agent"'));
    assert.equal(await fileExists(path.join(fallbackWorkspace, '.claworld', 'journal', '2026-04-22.md')), false);

    const helperDefaultWorkspace = path.join(tempRoot, 'helper-default');
    const helperCwd = path.join(tempRoot, 'helper-cwd');
    await fs.mkdir(helperCwd, { recursive: true });
    const helperConfig = {
      agents: {
        list: [{ id: 'main' }],
        defaults: { workspace: helperDefaultWorkspace },
      },
    };
    assert.equal(
      resolveClaworldMaintenanceWorkspaceRoot({ agentId: 'main' }, { config: helperConfig }),
      helperDefaultWorkspace,
    );
    assert.equal(
      resolveClaworldMaintenanceWorkspaceRoot(
        { agentId: 'main', config: helperConfig },
        { config: {} },
      ),
      helperDefaultWorkspace,
    );
    assert.equal(
      resolveClaworldMaintenanceWorkspaceRoot(
        { workspaceRoot: hookWorkspace, agentId: 'main' },
        { config: helperConfig },
      ),
      hookWorkspace,
    );

    const priorCwd = process.cwd();
    try {
      process.chdir(helperCwd);
      await runClaworldMemoryMaintenanceForOpenClaw(
        CLAWORLD_MAINTENANCE_RUN_TYPES.L1_NOW_REFRESH,
        { agentId: 'main' },
        {
          config: helperConfig,
          output: {
            nowMd: buildNowFixture('- [ ] id: goal-helper | status: active | next: helper default workspace | report: main | source: unit | updated: 2026-04-22'),
          },
        },
      );
    } finally {
      process.chdir(priorCwd);
    }
    assert.ok((await readText(path.join(helperDefaultWorkspace, '.claworld', 'context', 'NOW.md'))).includes('helper default workspace'));
    assert.equal(await fileExists(path.join(helperCwd, '.claworld', 'context', 'NOW.md')), false);

    const helperObjectWorkspace = path.join(tempRoot, 'helper-object');
    const l2HelperResult = await runClaworldMemoryMaintenanceForOpenClaw(
      CLAWORLD_MAINTENANCE_RUN_TYPES.L2_MEMORY_PROFILE_REVIEW,
      { agentId: 'main', config: { agents: { list: { main: { workspace: helperObjectWorkspace } } } } },
      {
        output: {
          profileMd: {
            operation: 'replace',
            content: buildProfileFixture('- 2026-04-22 helper profile. Source: unit.'),
          },
          memoryMd: {
            operation: 'replace',
            content: buildMemoryFixture('- 2026-04-22 [pattern] helper memory. Source: unit.'),
          },
        },
      },
    );
    assert.equal(l2HelperResult.applied.length, 2);
    assert.ok((await readText(path.join(helperObjectWorkspace, '.claworld', 'context', 'PROFILE.md'))).includes('helper profile'));
    assert.ok((await readText(path.join(helperObjectWorkspace, '.claworld', 'context', 'MEMORY.md'))).includes('helper memory'));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log('PASS unit-claworld-working-memory');
}

main().catch((error) => {
  console.error('FAIL unit-claworld-working-memory');
  console.error(error);
  process.exit(1);
});
