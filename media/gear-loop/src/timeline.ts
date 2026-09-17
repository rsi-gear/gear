// One 12-second timeline for frame-driven Remotion and script-free SVG/CSS.
export const FPS = 30;
export const DURATION = 360;
export const FADE_OUT = 345;

export const cues = {
  serve: [0, 15],
  innerAction: [18, 18],
  innerReturn: [33, 20],
  innerFlow: [45, 9],
  trajectory: [61, 20],
  diagnose: [78, 15],
  plan: [108, 18],
  evolve: [108, 18],
  harnessPath: [130, 20],
  harness: [141, 18],
  seedPath: [160, 23],
  seeds: [174, 18],
  modelPath: [204, 24],
  model: [222, 18],
  merge: [240, 18],
  return: [258, 42],
  refreshed: [300, 12],
  versions: [309, 12],
} as const;

export type Cue = keyof typeof cues;
const percent = (frame: number) =>
  `${Number(((frame / DURATION) * 100).toFixed(5))}%`;

export const svgAnimationCss = () => {
  const rules = Object.entries(cues)
    .map(([name, [start, duration]]) => {
      const end = start + duration;
      return `
      @keyframes gear-${name} {
        0%, ${percent(start)} { opacity: 0; }
        ${percent(end)}, ${percent(FADE_OUT)} { opacity: 1; }
        100% { opacity: 0; }
      }
      @keyframes gear-draw-${name} {
        0%, ${percent(start)} { stroke-dashoffset: 100; }
        ${percent(end)}, 100% { stroke-dashoffset: 0; }
      }
      .gear-${name} { animation: gear-${name} 12s linear infinite; }
      .gear-draw-${name} {
        animation: gear-${name} 12s linear infinite, gear-draw-${name} 12s linear infinite;
      }
    `;
    })
    .join("\n");
  return `${rules}
    @keyframes gear-circulate {
      0%, ${percent(cues.innerFlow[0])} { stroke-dashoffset: 0; }
      100% { stroke-dashoffset: -500; }
    }
    .gear-flow {
      animation: gear-innerFlow 12s linear infinite, gear-circulate 12s linear infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .gear-flow { display: none !important; }
      .gear-motion { animation: none !important; opacity: 1 !important; stroke-dashoffset: 0 !important; }
    }
  `;
};
