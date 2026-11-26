import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const manifestName = 'pwa-manifest.webmanifest';
const notificationName = 'pwa-notifications.js';
const iconSources = {
  192: './icons/192.png',
  512: './icons/512.png',
};
const iconName = size => `pwa-icon-${size}.png`;

export function plannerPwa() {
  return {
    name: 'klaxon-development-pwa',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'link', attrs: { rel: 'manifest', href: `./${manifestName}`, 'data-klaxon-pwa': '' } },
      { tag: 'link', attrs: { rel: 'apple-touch-icon', href: `./${iconName(192)}` } },
    ],
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const emit = (fileName, source) => this.emitFile({ type: 'asset', fileName, source });
        const manifest = JSON.stringify({
          id: './', name: 'Klaxon', short_name: 'Klaxon', start_url: './', scope: './', display: 'standalone',
          theme_color: '#141413', background_color: '#141413',
          icons: Object.keys(iconSources).map(size => ({ src: `./${iconName(size)}`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' })),
        });
        const template = readFileSync(new URL('./shell-worker.js', import.meta.url), 'utf8');
        const notifications = readFileSync(new URL('./notification-worker.js', import.meta.url), 'utf8');
        const hash = createHash('sha256').update(manifest).update(template).update(notifications);
        const files = Object.keys(bundle).filter(name => name === 'index.html' || (name.startsWith('assets/') && !name.endsWith('.map'))).sort();
        for (const name of files) {
          const result = bundle[name];
          hash.update(name).update(result.type === 'asset' ? result.source : result.code);
        }
        for (const [size, file] of Object.entries(iconSources)) {
          const bytes = readFileSync(new URL(file, import.meta.url));
          const name = iconName(size);
          emit(name, bytes);
          hash.update(bytes);
          files.push(name);
        }
        emit(manifestName, manifest);
        files.push(manifestName);
        emit(notificationName, notifications);
        const precache = { version: hash.digest('hex').slice(0, 24), files };
        const extension = `\nglobalThis.importScripts('./${notificationName}');\n`;
        emit('pwa-sw.js', `globalThis.KLAXON_PWA_BUILD = ${JSON.stringify(precache)};\n${template}${extension}`);
      },
    },
  };
}
