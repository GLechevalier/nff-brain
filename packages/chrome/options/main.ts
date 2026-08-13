// Options page wiring. Same discipline as popup/main.ts: all work rides
// chrome.runtime messages to the service worker; this page holds no secrets
// beyond the moment a key sits in its (password-type) input, and the stored
// key is NEVER rendered back — PublicState carries zero key material.

import { PROVIDERS, PROVIDER_CHOICES } from '@nff-brain/core/provider';
import type { ProviderId } from '@nff-brain/core/provider';
import type { PopupToSw, PublicState, SwToPopup } from '../src/protocol.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function send(msg: PopupToSw): Promise<SwToPopup> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (reply: SwToPopup) => {
      if (chrome.runtime.lastError) {
        resolve({ type: 'error', message: chrome.runtime.lastError.message ?? 'no response' });
        return;
      }
      resolve(reply);
    });
  });
}

function showError(id: string, message: string | null): void {
  const el = $(id);
  el.textContent = message ?? '';
  el.classList.toggle('hidden', message === null);
}

function selectedProvider(): ProviderId {
  return ($('provider') as HTMLSelectElement).value as ProviderId;
}

function fillProviderSelect(current: ProviderId | null): void {
  const select = $('provider') as HTMLSelectElement;
  select.replaceChildren(
    ...PROVIDER_CHOICES.map((c) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.available ? c.label : `${c.label} (coming soon)`;
      opt.disabled = !c.available;
      return opt;
    }),
  );
  select.value = current ?? 'anthropic';
}

function fillModelDatalists(provider: ProviderId): void {
  const adapter = PROVIDERS[provider];
  const models = adapter?.knownModels ?? [];
  for (const listId of ['models-background', 'models-chat']) {
    $(listId).replaceChildren(
      ...models.map((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        return opt;
      }),
    );
  }
}

function paint(state: PublicState): void {
  fillProviderSelect(state.provider);
  fillModelDatalists(state.provider ?? 'anthropic');

  const status = $('key-status');
  if (state.providerConfigured) {
    const saved = `Key saved${state.providerLastTest ? ` · last test: ${state.providerLastTest.message}` : ''}`;
    status.textContent = saved;
    status.classList.toggle('ok', state.providerLastTest?.ok !== false);
  } else {
    status.textContent = 'No key saved — captures stay queued on this device.';
    status.classList.remove('ok');
  }

  const models = state.providerModels ?? PROVIDERS[state.provider ?? 'anthropic']?.defaultModels ?? null;
  if (models) {
    ($('model-background') as HTMLInputElement).value = models.background;
    ($('model-chat') as HTMLInputElement).value = models.chat;
  }
}

async function refresh(): Promise<void> {
  const reply = await send({ type: 'getState' });
  if (reply.type === 'state') paint(reply.state);
}

async function saveKey(): Promise<void> {
  const input = $('api-key') as HTMLInputElement;
  const apiKey = input.value.trim();
  if (!apiKey) {
    showError('key-error', 'paste a key first');
    return;
  }
  const reply = await send({ type: 'setProvider', provider: selectedProvider(), apiKey });
  if (reply.type === 'error') {
    showError('key-error', reply.message);
    return;
  }
  showError('key-error', null);
  input.value = ''; // the key never lingers in the DOM
  await refresh();
}

async function clearKey(): Promise<void> {
  const reply = await send({ type: 'clearProvider' });
  if (reply.type === 'error') {
    showError('key-error', reply.message);
    return;
  }
  showError('key-error', null);
  ($('api-key') as HTMLInputElement).value = '';
  await refresh();
}

async function saveModels(): Promise<void> {
  const background = ($('model-background') as HTMLInputElement).value.trim();
  const chat = ($('model-chat') as HTMLInputElement).value.trim();
  const reply = await send({ type: 'setProviderModels', models: { background, chat } });
  showError('models-error', reply.type === 'error' ? reply.message : null);
  if (reply.type !== 'error') await refresh();
}

async function testConnection(): Promise<void> {
  const el = $('test-result');
  el.classList.remove('hidden', 'ok', 'error');
  el.textContent = 'Testing…';
  const reply = await send({ type: 'testProvider' });
  if (reply.type === 'providerTest') {
    el.textContent = reply.result.message;
    el.classList.add(reply.result.ok ? 'ok' : 'error');
  } else {
    el.textContent = reply.type === 'error' ? reply.message : 'test failed';
    el.classList.add('error');
  }
  await refresh();
}

function wire(): void {
  $('provider').addEventListener('change', () => fillModelDatalists(selectedProvider()));
  $('key-save').addEventListener('click', () => void saveKey());
  $('api-key').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void saveKey();
  });
  $('key-clear').addEventListener('click', () => void clearKey());
  $('models-save').addEventListener('click', () => void saveModels());
  $('test').addEventListener('click', () => void testConnection());
}

wire();
void refresh();
