import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { developmentOrigin } from './build-config.mjs';
import { plannerPwa } from './src/pwa/build.mjs';

export default defineConfig(({ mode }) => {
  const origin = developmentOrigin(mode, process.env.KLAXON_PUBLIC_DEV_ORIGIN);

  return {
    base: './',
    envPrefix: [],
    plugins: [
      svelte(),
      origin && plannerPwa(),
      {
        name: 'klaxon-development-origin',
        transformIndexHtml: () => origin ? [{
          tag: 'meta',
          attrs: { name: 'klaxon-development-origin', content: origin },
        }] : [],
      },
    ],
  };
});
