# Plan: animated effects and faster painterly previews

Status: planning (2026-11-11). Nothing here is built yet.

## 1. Faster painterly previews

Today the painterly filters in `server/lib/filters/stylize.js` run at a
working size of 1200-4000 px (`detail`), and the live preview mirrors the
server by sizing from the full photo (`client/src/gpu/stack.ts`,
`workingSize()`). That costs ~200-300 ms a frame on the Iris 6100.

Steps, cheapest first:

1. **Preview at a capped working size, then refine.** `FilterStack` already
   takes `maxWorkingSide` (the preset thumbnails use it). For the live preview:
   render a draft with the cap at ~800 px while a slider moves, then one
   matching render at the true working size when the slider settles (on its
   `change` event, which EditHistory already commits on). Radii are in
   working-size pixels, so the draft must scale them by `cap / workingSize`
   so the result looks like the final one.
2. **Measure per pass.** Add an opt-in timing log per kernel (CPU time
   around `queue.onSubmittedWorkDone`; timestamp-query was skipped earlier)
   to find which passes dominate (Kuwahara sectors, oil-paint histograms).
3. **Cache across slider moves.** Keep the downscaled working copy and any
   intermediate that a parameter does not affect (e.g. the structure tensor
   for anisotropic Kuwahara when only colour changes). The stack already
   caches per layer; this adds caching inside a filter's plan.
4. **Kernel work.** Separable or shared-memory versions of the hottest
   kernels in the WGSL ports; check pixel parity with e2e/gpu.spec.js.

Done when: painterly sliders preview at ≥30 fps on the Iris and the settled
frame still matches the server pixel by pixel within today's tolerance.

## 2. Animated effects

`reaction_diffusion` (`server/lib/filters/generative.js`) already runs the
Gray-Scott model as thousands of `rd_step` passes in one plan. Animation
reuses those kernels, but steps them over time instead of all at once.

1. **Animation engine (client only).** A `requestAnimationFrame` loop that
   runs N `rd_step` passes per frame on persistent ping-pong buffers, then
   `rd_render`. Pauses when the page is hidden, during full-size jobs (as
   the live preview does now), and under `prefers-reduced-motion`.
2. **Touch.** Pointer events (in canvas pixels) seed chemical B in a small
   disc via a new `rd_seed` kernel. Ripple: a two-buffer wave equation
   (`wave_step`, `wave_render` refracting the photo), with taps as drops.
3. **Freeze into a result.** "Keep this frame" turns the current state into
   an ordinary result that goes through the existing result card and save
   path. The server can't replay touches, so a kept frame is stored as
   pixels with a recipe flag marking it non-reproducible.
4. **Fallbacks.** WebGL2 gets the same kernels via the webgl2 engine; with
   no GPU, the effect is hidden (no server path).
5. **Tests.** Unit-test the step and seed kernels deterministically (fixed
   seed, fixed step count, compared with the existing rd output); one e2e
   that taps and checks the canvas changed.

6. **GIF export (first export format, decided 2026-11-12).** Record frames
   from the animation canvas at a capped size (e.g. 480 px wide, 10-15 fps,
   a few seconds) into a ring buffer; encode in a Web Worker with a small
   dependency-free GIF encoder (per-frame or global palette via median cut,
   optional ordered dither so gradients don't band). Offer it through the
   result card's save/share path. Video (WebCodecs/MediaRecorder) can follow.

Open question for the user:
- Which effect first: reaction-diffusion with touch, ripple, or both?
