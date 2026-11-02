import net from 'node:net';
import process from 'node:process';

const upstreamHost = process.env.APP_HOST;
if (!upstreamHost) throw new Error('APP_HOST is required.');

net
  .createServer(client => {
    const upstream = net.connect(8080, upstreamHost);
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  })
  .listen(8080, '127.0.0.1');
