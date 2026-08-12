# After the first upload: pin the extension id with `key`

An unpacked build gets a random extension id, so today a dev build must be
paired against `nff-brain serve --allow-origin chrome-extension://<random id>`
(the server pins each client's origin at pair time). Once the store assigns the
real id, kill that friction:

1. In the dashboard (or `chrome://extensions` with the store build installed),
   note the published extension **id**.
2. Get the public key: dashboard → item → "Public key", or from the installed
   `.crx`. It is a base64 string.
3. Add to `manifest.json`:

   ```json
   "key": "<base64 public key>"
   ```

   Now `Load unpacked` derives the SAME id as the store build — one origin, no
   `--allow-origin` juggling, pairings survive switching between dev and store
   builds.

4. Add a pin to `test/manifest.test.ts` so the key can never be dropped or
   swapped silently:

   ```ts
   it('pins the published store key', () => {
     expect(manifest.key).toBe('<the same base64>');
   });
   ```

5. `zip.mjs` packs `dist/` verbatim, so the key ships in the store zip too —
   that is fine and expected (the store ignores it on upload but keeps ids
   consistent).

Note: the `key` is a PUBLIC key. It is not a secret and belongs in git.
