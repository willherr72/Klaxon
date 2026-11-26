/// <reference types="vite/client" />

import { mount } from 'svelte';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('Missing Klaxon mount element');

const origin = import.meta.env.MODE === 'development' && !('__TAURI_INTERNALS__' in window)
  ? document.querySelector<HTMLMetaElement>('meta[name="klaxon-development-origin"]')?.content
  : undefined;

if (origin) {
  void import('./Development.svelte').then(({ default: Development }) => {
    mount(Development, { target, props: { origin } });
  });
} else {
  mount(App, { target });
}
