import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNginxLocations } from './server.js';

test('parseNginxLocations finds proxied services and skips non-proxy locations', () => {
  const services = parseNginxLocations(`
server {
    location /dnd-control-panel {
        proxy_pass http://dnd-control-panel:80;
    }

    location = /daria {
        absolute_redirect off;
        return 308 /daria/;
    }

    # <lisa-managed>
    location /daria/ {
        proxy_pass http://daria:80/;
    }
    # </lisa-managed>

    location / {
        proxy_pass http://homelab-dashboard:3000;
    }
}
`);

  assert.deepEqual(
    services.map(service => [service.path, service.kind, service.origin, service.upstream, service.redirectTo]),
    [
      ['/dnd-control-panel', 'Web', 'Otros', 'http://dnd-control-panel:80', null],
      ['/daria/', 'Web', 'Ilicilabs', 'http://daria:80/', null],
      ['/', 'Web', 'Otros', 'http://homelab-dashboard:3000', null]
    ]);
});
