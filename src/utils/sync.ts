import { SyncClient, SyncMap } from 'twilio-sync';
import * as Flex from '@twilio/flex-ui';

const FUNCTIONS_BASE = (process.env.FLEX_APP_FUNCTIONS_BASE_URL || '').replace(/\/$/, '');

export interface SendHistoryEntry {
  conversationSid: string;
  to: string;
  templateSid: string;
  templateName?: string | null;
  mode: 'open-chat' | 'same-agent' | 'any-agent';
  sentAt: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'undelivered' | 'replied' | 'parked';
  initiatingWorkerSid?: string;
  initiatingWorkerName?: string;
  lastReplyAt?: string;
  lastReplyPreview?: string;
  lastStatusAt?: string;
  parkedAt?: string;
  parkedByWorkerSid?: string;
  parkedByWorkerName?: string;
}

export type HistoryScope = 'mine' | 'team';

let clientPromise: Promise<SyncClient> | null = null;

async function fetchSyncToken(): Promise<string> {
  const manager = Flex.Manager.getInstance();
  const res = await fetch(`${FUNCTIONS_BASE}/sync-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ Token: manager.user.token }),
  });
  if (!res.ok) throw new Error(`sync-token failed: ${res.status}`);
  const data = await res.json();
  return data.token;
}

async function getClient(): Promise<SyncClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const token = await fetchSyncToken();
      const client = new SyncClient(token);
      // Auto-refresh before expiry. `tokenAboutToExpire` fires ~3 min before,
      // `tokenExpired` if refresh missed. Both call the same refresh path.
      client.on('tokenAboutToExpire', async () => {
        try { client.updateToken(await fetchSyncToken()); } catch (e) { console.error('sync token refresh failed', e); }
      });
      client.on('tokenExpired', async () => {
        try { client.updateToken(await fetchSyncToken()); } catch (e) { console.error('sync token refresh failed', e); }
      });
      return client;
    })();
  }
  return clientPromise;
}

// Subscribe to a send-history map. Scope 'mine' -> per-worker map; 'team' -> shared.
// Fires `onChange` any time an item is added or updated. Returns an unsubscribe fn.
export async function subscribeSendHistory(
  workerSid: string,
  scope: HistoryScope,
  onChange: (entries: SendHistoryEntry[]) => void,
): Promise<() => void> {
  const client = await getClient();
  const mapName = scope === 'team' ? 'outbound-sends-team' : `outbound-sends-${workerSid}`;
  let map: SyncMap;
  try {
    map = await client.map(mapName);
  } catch (e) {
    // If the map doesn't exist yet (agent has never sent), create-or-open pattern
    // via .map() should have created it. Bubble other errors.
    throw e;
  }

  const load = async () => {
    const items: SendHistoryEntry[] = [];
    const paginator = await map.getItems({ pageSize: 100, order: 'desc' });
    let page = paginator;
    while (true) {
      page.items.forEach((it) => items.push(it.data as unknown as SendHistoryEntry));
      if (!page.hasNextPage) break;
      page = await page.nextPage();
    }
    onChange(items);
  };

  await load();
  const bump = () => { load().catch((err) => console.error('sync map reload failed', err)); };
  map.on('itemAdded', bump);
  map.on('itemUpdated', bump);
  map.on('itemRemoved', bump);

  return () => {
    map.off('itemAdded', bump);
    map.off('itemUpdated', bump);
    map.off('itemRemoved', bump);
  };
}
