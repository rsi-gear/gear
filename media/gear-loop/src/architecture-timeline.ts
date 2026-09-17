// Shared phase and data-flow timing for Remotion and standalone SVG.
export const ARCHITECTURE_FPS = 30;
export const ARCHITECTURE_DURATION = 360;
export const architecturePhases = {
  serve: [0, 120],
  diagnose: [120, 240],
  evolve: [240, 360],
} as const;
export type ArchitecturePhase = keyof typeof architecturePhases;

export const architectureCues = {
  ...architecturePhases,
  inputs: [0, 36],
  dispatch: [36, 80],
  capture: [80, 120],
  feedback: [120, 218],
  seedUpdates: [240, 318],
  harnessUpdates: [240, 318],
  trainingData: [240, 280],
  modelUpdates: [280, 360],
} as const;
export type ArchitectureCue = keyof typeof architectureCues;

const percent = (frame: number) =>
  `${Number(((frame / ARCHITECTURE_DURATION) * 100).toFixed(5))}%`;

export const architectureAnimationCss = () =>
  `${Object.entries(architectureCues)
    .map(
      ([name, [start, end]]) => `
      @keyframes arch-active-${name} {
        ${start > 0 ? "0% { visibility: hidden; }" : ""}
        ${percent(start)} { visibility: visible; }
        ${percent(end)}, 100% { visibility: hidden; }
      }
      @keyframes arch-draw-${name} {
        0%, ${percent(start)} { stroke-dashoffset: 100; }
        ${percent(end - 3)}, 100% { stroke-dashoffset: 0; }
      }
      @keyframes arch-dot-${name} {
        0%, ${percent(start)} { stroke-dashoffset: 0; }
        ${percent(end - 3)}, 100% { stroke-dashoffset: -99.9; }
      }
      .arch-active-${name} {
        animation: arch-active-${name} 12s steps(1, end) infinite;
      }
      .arch-draw-${name} { animation: arch-draw-${name} 12s linear infinite; }
      .arch-dot-${name} { animation: arch-dot-${name} 12s linear infinite; }
    `,
    )
    .join("\n")}
    ${Object.entries(architecturePhases)
      .map(
        ([name, [start, end]]) => `
      @keyframes arch-word-${name} {
        ${start > 0 ? "0% { fill: #7d766e; }" : ""}
        ${percent(start)} { fill: #a03729; }
        ${percent(end)}, 100% { fill: #7d766e; }
      }
      .arch-word-${name} { animation: arch-word-${name} 12s steps(1, end) infinite; }
    `,
      )
      .join("\n")}
    @keyframes arch-orbit { from { rotate: 0deg; } to { rotate: 360deg; } }
    .arch-orbit { animation: arch-orbit 12s linear infinite; }
    @media (prefers-reduced-motion: reduce) {
      .arch-motion { animation: none !important; visibility: hidden !important; }
      .arch-loop-word { animation: none !important; fill: #14110e !important; }
    }
  `;
