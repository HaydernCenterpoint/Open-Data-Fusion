import { describe, expect, it } from 'vitest';

import { WorkspaceEventHub, type WorkspaceEvent, type WorkspaceMember } from '../src/collaboration.js';
import { InMemorySharedEventDelivery } from '../src/shared-event-delivery.js';

const owner: WorkspaceMember = {
  workspaceId: 'cooling-water-system',
  userId: 'harper.dennis',
  displayName: 'Harper Dennis',
  role: 'owner',
};

const editor: WorkspaceMember = {
  workspaceId: 'cooling-water-system',
  userId: 'riley.chen',
  displayName: 'Riley Chen',
  role: 'editor',
};

describe('WorkspaceEventHub', () => {
  it('broadcasts workspace updates and unique live presence', () => {
    const hub = new WorkspaceEventHub();
    const ownerEvents: WorkspaceEvent[] = [];
    const editorEvents: WorkspaceEvent[] = [];

    const unsubscribeOwner = hub.subscribe(owner.workspaceId, owner, (event) => ownerEvents.push(event));
    const unsubscribeEditor = hub.subscribe(editor.workspaceId, editor, (event) => editorEvents.push(event));
    const unsubscribeSecondEditorConnection = hub.subscribe(editor.workspaceId, editor, () => undefined);

    const latestPresence = ownerEvents.filter((event) => event.type === 'presence.updated').at(-1);
    expect(latestPresence?.data.users).toEqual([owner, editor]);

    hub.publishWorkspaceUpdated({
      workspaceId: owner.workspaceId,
      version: 2,
      actor: editor.userId,
      changeSummary: 'Moved a node',
    });
    expect(ownerEvents.at(-1)).toMatchObject({
      type: 'workspace.updated',
      data: { workspaceId: owner.workspaceId, version: 2, actor: editor.userId },
    });
    expect(editorEvents.at(-1)?.type).toBe('workspace.updated');

    unsubscribeSecondEditorConnection();
    expect((ownerEvents.filter((event) => event.type === 'presence.updated').at(-1)?.data.users as unknown[])).toHaveLength(2);
    unsubscribeEditor();
    expect(ownerEvents.filter((event) => event.type === 'presence.updated').at(-1)?.data.users).toEqual([owner]);
    unsubscribeOwner();
  });

  it('broadcasts membership changes and refreshes or revokes live presence', () => {
    const hub = new WorkspaceEventHub();
    const ownerEvents: WorkspaceEvent[] = [];
    const editorEvents: WorkspaceEvent[] = [];
    const unsubscribeOwner = hub.subscribe(owner.workspaceId, owner, (event) => ownerEvents.push(event));
    const unsubscribeEditor = hub.subscribe(editor.workspaceId, editor, (event) => editorEvents.push(event));

    const reviewer = { ...editor, role: 'reviewer' as const };
    hub.publishMembersUpdated({
      workspaceId: owner.workspaceId,
      actor: owner.userId,
      change: 'updated',
      member: reviewer,
      occurredAt: '2026-07-10T00:00:00.000Z',
    });
    expect(ownerEvents.findLast((event) => event.type === 'members.updated')).toMatchObject({
      data: { actor: owner.userId, change: 'updated', member: reviewer },
    });
    expect(ownerEvents.filter((event) => event.type === 'presence.updated').at(-1)?.data.users).toEqual([owner, reviewer]);

    const editorEventCount = editorEvents.length;
    hub.publishMembersUpdated({
      workspaceId: owner.workspaceId,
      actor: owner.userId,
      change: 'removed',
      member: reviewer,
      occurredAt: '2026-07-10T00:01:00.000Z',
    });
    expect(ownerEvents.findLast((event) => event.type === 'members.updated')).toMatchObject({
      data: { change: 'removed', member: reviewer },
    });
    expect(ownerEvents.filter((event) => event.type === 'presence.updated').at(-1)?.data.users).toEqual([owner]);
    expect(editorEvents).toHaveLength(editorEventCount + 1);
    expect(editorEvents.at(-1)).toMatchObject({
      type: 'members.updated',
      data: { change: 'removed', member: reviewer },
    });

    unsubscribeEditor();
    unsubscribeOwner();
  });

  it('fans committed workspace events across hubs while leaving presence local', async () => {
    const delivery = new InMemorySharedEventDelivery();
    const first = new WorkspaceEventHub(delivery);
    const second = new WorkspaceEventHub(delivery);
    const received: WorkspaceEvent[] = [];
    const unsubscribe = second.subscribe(owner.workspaceId, owner, (event) => received.push(event));

    first.publishWorkspaceUpdated({
      workspaceId: owner.workspaceId,
      version: 3,
      actor: editor.userId,
      changeSummary: 'Shared through Redis-compatible transport',
    });

    expect(received.findLast((event) => event.type === 'workspace.updated')).toMatchObject({
      type: 'workspace.updated',
      data: { workspaceId: owner.workspaceId, version: 3, actor: editor.userId },
    });
    expect(received.filter((event) => event.type === 'presence.updated')).toHaveLength(1);

    unsubscribe();
    await first.close();
    await second.close();
  });
});
