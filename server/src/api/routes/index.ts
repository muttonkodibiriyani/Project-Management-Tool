import type { FastifyInstance } from 'fastify';
import type { ApiOptions } from '../plugin.js';
import { comments } from './comments.js';
import { me } from './me.js';
import { projects } from './projects.js';
import { records } from './records.js';
import { sync } from './sync.js';
import { tasks } from './tasks.js';
import { workspaces } from './workspaces.js';

export async function routes(app: FastifyInstance, options: ApiOptions) {
  await app.register(me, options);
  await app.register(workspaces, options);
  for (const plugin of [projects, tasks, comments, records, sync]) await app.register(plugin, { ...options, prefix: '/w/:ws' });
}
