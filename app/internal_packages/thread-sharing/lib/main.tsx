import fs from 'fs';
import {
  IdentityStore,
  DatabaseStore,
  Thread,
  Message,
  Actions,
  AttachmentStore,
  SyncbackMetadataTask,
  MailspringAPIRequest,
  QuotedHTMLTransformer,
  ComponentRegistry,
  DatabaseChangeRecord,
} from 'mailspring-exports';

import plugin from '../package.json';
import ThreadSharingButton from './thread-sharing-button';

export const PLUGIN_NAME = plugin.title;
export const PLUGIN_ID = plugin.name;

const _readFile = Promise.promisify(fs.readFile);

const _onDatabaseChange = (change: DatabaseChangeRecord<any>) => {
  if (change.type !== 'persist' || change.objectClass !== Thread.name) {
    return;
  }

  change.objects.forEach(async thread => {
    if (isShared(thread)) {
      syncThreadToWebSoon(thread);
    }
  });
};

export function isShared(thread: Thread) {
  const metadata = thread.metadataForPluginId(PLUGIN_ID) || {};
  return metadata.shared || false;
}

export function sharingURLForThread(thread: Thread) {
  const metadata = thread.metadataForPluginId(PLUGIN_ID) || {};
  if (!metadata || !metadata.key || !metadata.shared) {
    return null;
  }
  const identity = IdentityStore.identity();
  return `https://shared.getmailspring.com/thread/${identity.id}/${metadata.key}`;
}

let soon = {};
let soonTimer = null;
const syncThreadToWebSoon = (thread: Thread) => {
  soon[thread.id] = thread;
  if (!soonTimer) {
    soonTimer = setTimeout(() => {
      const processing = Object.values(soon);
      soon = {};
      soonTimer = null;

      processing.forEach(async (thread: Thread) => {
        try {
          await syncThreadToWeb(thread);
        } catch (err) {
          console.warn(`Unable to sync thread '${thread.subject}' to the cloud: ${err}`);
        }
      });
    }, 5000);
  }
};

export const syncThreadToWeb = async (thread: Thread) => {
  const metadata = thread.metadataForPluginId(PLUGIN_ID) || {};

  let messages = await DatabaseStore.findAll<Message>(Message, { threadId: thread.id }).include(
    Message.attributes.body
  );

  // hide reminder notifications, deleted emails, etc.
  messages = messages.filter(m => !m.isHidden());

  const combinedVersionHash = messages.map(m => m.version).join('|');
  if (metadata.combinedVersionHash === combinedVersionHash) {
    // since thread sharing really just shows the messages in the thread, we don't need
    // to perform work (and could enter an infinite loop if we continue to update the metadata.)
    return;
  }

  // initialize, update the metadata value
  metadata.shared = true;
  metadata.combinedVersionHash = combinedVersionHash;
  metadata.key = metadata.key || `${thread.id}-${Date.now()}`;
  metadata.fileURLs = metadata.fileURLs || {};

  // first, sync any new attachments
  const files = messages.reduce((a, m) => a.concat(m.files), []);
  const toUpload = files.filter(f => !metadata.fileURLs[f.id]);
  while (toUpload.length) {
    const file = toUpload.pop();
    try {
      const filePath = AttachmentStore.pathForFile(file);
      const data = await _readFile(filePath);
      if (data.length === 0) {
        throw new Error(`File ${filePath} is not on disk.`);
      }
      const link = await MailspringAPIRequest.postStaticAsset({
        filename: `${file.id}/${file.displayName()}`,
        blob: new Blob([new Uint8Array(data)], { type: 'application/octet-stream' }),
      });
      metadata.fileURLs[file.id] = link;
    } catch (err) {
      console.log(`Could not upload attachment ${file.displayName()}: ${err}`);
    }
  }

  const { firstName, lastName, emailAddress } = IdentityStore.identity();

  // next, post the JSON for the entire thread
  await MailspringAPIRequest.postStaticAsset({
    filename: metadata.key,
    blob: JSON.stringify({
      thread: thread,
      sharedBy: { firstName, lastName, emailAddress },
      fileURLs: metadata.fileURLs,
      messages: messages.map(m =>
        Object.assign({}, m.toJSON(), {
          body: QuotedHTMLTransformer.removeQuotedHTML(m.body, {
            keepIfWholeBodyIsQuote: true,
          }),
        })
      ),
    }),
  });

  Actions.queueTask(
    SyncbackMetadataTask.forSaving({
      model: thread,
      pluginId: PLUGIN_ID,
      value: metadata,
    })
  );
};

export const unsyncThread = async (thread: Thread) => {
  const metadata = thread.metadataForPluginId(PLUGIN_ID) || {};
  await MailspringAPIRequest.postStaticAsset({
    filename: metadata.key,
    blob: JSON.stringify({ shared: false }),
  });

  Actions.queueTask(
    SyncbackMetadataTask.forSaving({
      model: thread,
      pluginId: PLUGIN_ID,
      value: { shared: false, key: metadata.key },
    })
  );
};
export function activate() {
  // ComponentRegistry.register(ThreadSharingButton, {
  //   role: 'ThreadActionsToolbarButton',
  // });
  // this._unlisten = DatabaseStore.listen(_onDatabaseChange);
}

export function deactivate() {
  // ComponentRegistry.unregister(ThreadSharingButton);
  if (this._unlisten) {
    this._unlisten();
    this._unlisten = null;
  }
}
