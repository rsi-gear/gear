# Gear evolution loop

12-second, 1440 × 580 vector animation: **Serve → Diagnose → Evolve → Repeat**.
The inner loop shows a **Rollout Agent** exchanging actions, observations and
rewards with an environment, inside stacked cards labeled **Inner loop — Interact within each task**. The outer loop aggregates
trajectories and **feedback** across tasks. The Meta Agent occupies the Diagnose
node and drives all three evolution branches: editing the harness, designing seed
tasks and training the model. A larger return path wraps around the inner
loop and feeds the evolved harness, tasks and model directly back into the inner
loop, with no intermediate steps on the return path. The inner and outer loop
labels share aligned title and explanation columns.

The Harness branch lists prompts, tools, hooks, skills and context management.

## Deliverables

- [`gear-loop-light.svg`](../../docs/guide/assets/gear-loop-light.svg): standalone,
  infinitely looping SVG with CSS animation, no JavaScript, external fonts or assets.
- [`gear-loop-poster.svg`](../../docs/guide/assets/gear-loop-poster.svg): static full diagram.
- [`gear-architecture-light.svg`](../../docs/guide/assets/gear-architecture-light.svg): 1440 × 760 component architecture following the supplied sketch. The upper-right **Serve → Diagnose → Evolve → Serve** overview is a true circle with three equal arcs, an orbiting dot and phase highlights. Its 12-second cycle synchronizes with highlighted components and moving data along the main diagram's arrows. Powered by Hitch lists shared capabilities and remains entirely static. The diagram uses a white background, thin outlines, muted descriptions and a restrained red accent.
- `src/GearArchitecture.tsx`: architecture artwork shared by SVG export and the `GearArchitecture` Remotion composition.
- `src/architecture-timeline.ts`: shared timing for the circular overview and main data flow, 360 frames at 30 fps.
- `src/GearScene.tsx`: shared SVG artwork.
- `src/timeline.ts`: shared timing for native SVG and Remotion, 360 frames at 30 fps.

The architecture follows the supplied component relationships:

- Algorithm Registry configures Optimization Engine.
- Task Registry and Agent supply inputs to the engine.
- Optimization Engine sends candidates to Evaluator.
- Evaluator writes Trajectory Storage.
- Trajectory Storage sends feedback to the engine and training data to Trainer.
- Optimization Engine returns seed-task updates to Task Registry and harness updates to Agent.
- Trainer returns model updates to Agent.

All six main cards share the same dimensions in two aligned rows and three
evenly spaced columns. Task Registry, Optimization Engine and Evaluator form
the upper row; Agent, Trainer and Trajectory Storage form the lower row.
Agent input and stored feedback enter the engine through mirrored lower paths.
Seed-task and harness updates use separate return paths without crossing inputs.

The diagram groups responsibilities rather than exposing internal algorithm
steps. Registry maps to `src/evolution/components.ts`; the engine covers
`src/refine/service.ts` and `src/search/engine.ts`; evaluation uses the Hitch
adapter; storage covers persisted trajectory/evidence data; Trainer maps to
`src/training` and `python/gear_training`. Training consumes authorized training
data, not held-out evaluation trajectories. Model training currently has a
separate experiment lifecycle; the complete joint harness/model loop remains
in progress. Hitch's four labels describe shared infrastructure, not stages.

The SVG is exported from the shared React artwork, with generated CSS keyframes.
Remotion uses the same artwork and cues with `useCurrentFrame()` and `interpolate()`;
its composition contains no CSS animation and can be scrubbed or rendered deterministically.

## Preview and edit

```sh
cd media/gear-loop
npm ci
npm run export:svg
npm run dev
```

Open `/GearLoop` at the URL printed by Remotion for the source composition.
Open `/GearArchitecture` for the looping architecture composition and press Play.
Render a PNG with `npm run still:architecture`.
The standalone SVG plays at `/gear-architecture-light.svg` on the preview server.

For native SVG playback with pause, scrub and full-diagram controls, run
`npm run preview` in a second terminal and open the printed URL (default
`http://127.0.0.1:4175`). The preview’s Studio link assumes the default port 3000.

Edit the artwork or cues, then run `npm run export:svg` to update both documentation
assets and the generated copies in `public/`. Studio updates automatically.

```sh
npm run lint
npm run still
# Optional video export:
npx remotion render GearLoop out/gear-loop.mp4
```

## Embed

From the repository README:

```md
![Gear evolution loop](docs/guide/assets/gear-loop-light.svg)
```

Or use an `<img>` with responsive width. The SVG needs no Remotion runtime.
`prefers-reduced-motion: reduce` displays the complete diagram without animation.

The circular indicator and main diagram share these phases:

- **Serve, 0–4s:** task and agent inputs → engine → evaluator → trajectory storage.
- **Diagnose, 4–8s:** stored feedback returns to the engine.
- **Evolve, 8–12s:** the engine updates seed tasks and the harness; training data
  reaches Trainer and model updates return to Agent.

Phase highlights switch directly, with no fades. Drawing strokes and moving
dots show flow direction. Hitch's four infrastructure capabilities never animate.

## Timing

| Time     | Focus                                                     |
| -------- | --------------------------------------------------------- |
| 0–2s     | Rollout Agent ↔ Environment: the inner interaction loop   |
| 2–4s     | Meta Agent diagnoses cross-task trajectories and feedback |
| 4–8s     | Meta Agent → Harness / Seed Tasks / Model                 |
| 8–10s    | Direct return from the evolution branches to Seed Tasks   |
| 10–11.5s | Complete diagram and evaluated versions                   |
| 11.5–12s | Fade back to the initial state                            |

The diagram presents the full evolution architecture. The inner interaction loop
continues animating while the slower outer evolution loop unfolds.
