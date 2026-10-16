# Interface skins

A skin changes the shape of Weave's interface (corners, shadows, fonts, spacing, bar heights, surfaces and motion) but never its palette, so every skin works with every colour scheme.

- `../skin-contract.css` lists every token a skin may change, with Classic's values. Classic has no stylesheet of its own.
- `../skins.mjs` registers each skin: its name, description and, optionally, the skin it `extends`.
- Each other skin is one stylesheet here, `<id>.css`, appended by the build in registry order.

## Writing a skin

1. Add an entry to `skins.mjs`. To build on an existing skin, set `extends` and write only the differences; the root's `data-skin` then lists the chain, base first.
2. Create `<id>.css`. Every selector starts with `:root[data-skin~=<id>]`, or `.skin-preview[data-preview~=<id>]` for its miniature in the picker.
3. Set contract tokens, or private tokens your skin uses itself. Prefer tokens over selector overrides so the skin survives markup changes, and add a contract token when a skin needs a new decision.
4. Keep large translucent surfaces unblurred; blur only small overlays.

`../tests/skins.test.mjs` enforces these rules, and `npm run test:browser` cycles through every skin.
