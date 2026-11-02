import { BlobServiceClient } from '@azure/storage-blob';
import { Readable } from 'node:stream';
import pg from 'pg';
import { tx } from '../db/tx.js';
import { storeFile } from './files.js';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Blob crash fixture.`);
  return value;
};

const phase = required('CRASH_PHASE');
const workspaceId = required('CRASH_WORKSPACE_ID');
const uploadedBy = required('CRASH_USER_ID');
const pool = new pg.Pool({ connectionString: required('CRASH_DATABASE_URL'), max: 1, connectionTimeoutMillis: 2_000 });
const container = BlobServiceClient.fromConnectionString(required('CRASH_BLOB_CONNECTION_STRING')).getContainerClient(required('CRASH_CONTAINER'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZJisAAAAASUVORK5CYII=', 'base64');
const input = {
  workspaceId,
  uploadedBy,
  name: 'crash-window.png',
  data: Readable.from(png),
  area: 'attachments' as const,
};

if (phase === 'after-intent') {
  const crashBeforeUpload = new Proxy(container, {
    get(target, property) {
      if (property === 'getBlockBlobClient') {
        return (name: string) => {
          const block = target.getBlockBlobClient(name);
          return new Proxy(block, {
            get(blockTarget, blockProperty) {
              if (blockProperty === 'uploadStream') return () => Promise.resolve(process.exit(42));
              return Reflect.get(blockTarget, blockProperty, blockTarget) as unknown;
            },
          });
        };
      }
      return Reflect.get(target, property, target) as unknown;
    },
  });
  await storeFile(pool, crashBeforeUpload, input);
} else if (phase === 'after-upload') {
  await storeFile(pool, container, input);
  process.exit(42);
} else if (phase === 'after-commit') {
  const staged = await storeFile(pool, container, input);
  const commitCrashPool = {
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            const query = target.query.bind(target) as (...args: unknown[]) => Promise<unknown>;
            return async (...args: unknown[]) => {
              const result = await query(...args);
              const sql = typeof args[0] === 'string' ? args[0].trim().toLowerCase() : '';
              if (sql === 'commit') process.exit(42);
              return result;
            };
          }
          if (property === 'release') return target.release.bind(target);
          return Reflect.get(target, property, target) as unknown;
        },
      });
    },
  } as pg.Pool;
  await tx(commitCrashPool, client => staged.attach(client));
} else {
  throw new Error(`Unknown CRASH_PHASE ${phase}.`);
}

throw new Error(`Crash phase ${phase} returned without terminating the child.`);
