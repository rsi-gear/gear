import type { ReactNode } from "react";
import { interpolate } from "remotion";
import {
  architectureAnimationCss,
  architecturePhases,
  architectureCues,
  type ArchitecturePhase,
  type ArchitectureCue,
} from "./architecture-timeline";

const p = {
  bg: "#ffffff",
  ink: "#14110e",
  muted: "#7d766e",
  border: "#3c3630",
  line: "#ddd8d2",
  accent: "#a03729",
  active: "#fff4ef",
};

function Text({
  x,
  y,
  children,
  size = 22,
  fill = p.ink,
  weight = 400,
  anchor,
  className,
}: {
  x: number;
  y: number;
  children: ReactNode;
  size?: number;
  fill?: string;
  weight?: number;
  anchor?: "middle" | "start" | "end";
  className?: string;
}) {
  return (
    <text
      x={x}
      y={y}
      fontSize={size}
      fill={fill}
      fontWeight={weight}
      textAnchor={anchor}
      className={className}
    >
      {children}
    </text>
  );
}

function Active({
  frame,
  cue,
  children,
}: {
  frame?: number;
  cue: ArchitectureCue;
  children: ReactNode;
}) {
  const [start, end] = architectureCues[cue];
  return (
    <g
      data-cue={cue}
      className={
        frame === undefined ? `arch-motion arch-active-${cue}` : undefined
      }
      style={
        frame === undefined
          ? undefined
          : { visibility: frame >= start && frame < end ? "visible" : "hidden" }
      }
    >
      {children}
    </g>
  );
}

function Component({
  x,
  y,
  title,
  lines,
  backend,
  frame,
  cues = [],
}: {
  x: number;
  y: number;
  title: string;
  lines: string[];
  backend?: string;
  frame?: number;
  cues?: ArchitectureCue[];
}) {
  return (
    <g data-component={title}>
      <rect
        x={x}
        y={y}
        width={352}
        height={112}
        rx={10}
        fill={p.bg}
        stroke={p.border}
        strokeWidth={1.3}
      />
      {cues.map((cue) => (
        <Active key={cue} frame={frame} cue={cue}>
          <rect
            x={x}
            y={y}
            width={352}
            height={112}
            rx={10}
            fill={p.active}
            stroke={p.accent}
            strokeWidth={2.4}
          />
        </Active>
      ))}
      <Text x={x + 20} y={y + 39} size={24} weight={600}>
        {title}
      </Text>
      {backend ? (
        <Text x={x + 332} y={y + 38} size={16} fill={p.muted} anchor="end">
          {backend}
        </Text>
      ) : null}
      {lines.map((line, i) => (
        <Text
          key={line}
          x={x + 20}
          y={y + 70 + i * 24}
          size={17}
          fill={p.muted}
        >
          {line}
        </Text>
      ))}
    </g>
  );
}

function Flow({
  d,
  frame,
  cue,
}: {
  d: string;
  frame?: number;
  cue?: ArchitectureCue;
}) {
  const timing = cue ? architectureCues[cue] : null;
  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke={p.muted}
        strokeWidth={1.3}
        strokeLinecap="round"
        strokeLinejoin="round"
        markerEnd="url(#arch-arrow)"
      />
      {cue && timing ? (
        <Active frame={frame} cue={cue}>
          <path
            d={d}
            fill="none"
            stroke={p.accent}
            strokeWidth={2.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={100}
            strokeDasharray="100 100"
            className={frame === undefined ? `arch-draw-${cue}` : undefined}
            style={
              frame === undefined
                ? undefined
                : {
                    strokeDashoffset: interpolate(
                      frame,
                      [timing[0], timing[1] - 3],
                      [100, 0],
                      {
                        extrapolateLeft: "clamp",
                        extrapolateRight: "clamp",
                      },
                    ),
                  }
            }
          />
          <path
            d={d}
            fill="none"
            stroke={p.accent}
            strokeWidth={7}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray="0.01 200"
            className={frame === undefined ? `arch-dot-${cue}` : undefined}
            style={
              frame === undefined
                ? undefined
                : {
                    strokeDashoffset: interpolate(
                      frame,
                      [timing[0], timing[1] - 3],
                      [0, -99.9],
                      {
                        extrapolateLeft: "clamp",
                        extrapolateRight: "clamp",
                      },
                    ),
                  }
            }
          />
        </Active>
      ) : null}
    </g>
  );
}

// All three arcs lie on the same circle (cx=1216, cy=118, r=82),
// with nodes exactly 120 degrees apart.
const loopSteps: {
  phase: ArchitecturePhase;
  label: string;
  x: number;
  y: number;
  width: number;
  path: string;
}[] = [
  {
    phase: "serve",
    label: "Serve",
    x: 1216,
    y: 26,
    width: 88,
    path: "M1216 36A82 82 0 0 1 1287.014083 159",
  },
  {
    phase: "diagnose",
    label: "Diagnose",
    x: 1340,
    y: 165,
    width: 104,
    path: "M1287.014083 159A82 82 0 0 1 1144.985917 159",
  },
  {
    phase: "evolve",
    label: "Evolve",
    x: 1092,
    y: 165,
    width: 104,
    path: "M1144.985917 159A82 82 0 0 1 1216 36",
  },
];

function OverviewLoop({ frame }: { frame?: number }) {
  return (
    <g data-component="Evolution overview">
      <circle
        cx={1216}
        cy={118}
        r={82}
        fill="none"
        stroke={p.line}
        strokeWidth={1.8}
      />
      {loopSteps.map(({ phase, label, x, y, width, path }) => {
        const [start, end] = architecturePhases[phase];
        const active = frame !== undefined && frame >= start && frame < end;
        return (
          <g key={phase} data-phase={phase}>
            <path
              d={path}
              fill="none"
              stroke={p.muted}
              strokeWidth={1.5}
              markerEnd="url(#arch-arrow)"
            />
            <Active frame={frame} cue={phase}>
              <path
                d={path}
                fill="none"
                stroke={p.accent}
                strokeWidth={3.8}
                markerEnd="url(#arch-active-arrow)"
              />
              <rect
                x={x - width / 2}
                y={y - 22}
                width={width}
                height={30}
                rx={7}
                fill={p.active}
              />
            </Active>
            <Text
              x={x}
              y={y}
              size={19}
              weight={600}
              anchor="middle"
              fill={active ? p.accent : p.muted}
              className={
                frame === undefined
                  ? `arch-loop-word arch-word-${phase}`
                  : undefined
              }
            >
              {label}
            </Text>
          </g>
        );
      })}
      <g
        className={frame === undefined ? "arch-motion arch-orbit" : undefined}
        style={{
          transformOrigin: "1216px 118px",
          rotate:
            frame === undefined
              ? undefined
              : `${interpolate(frame, [0, 360], [0, 360])}deg`,
        }}
      >
        <circle
          cx={1216}
          cy={36}
          r={5.5}
          fill={p.accent}
          stroke={p.bg}
          strokeWidth={2}
        />
      </g>
    </g>
  );
}

const infrastructure = [
  { title: "Harness versions", detail: "Resolve · Build · Cache" },
  { title: "Model inference", detail: "API routing · Local serving" },
  {
    title: "Parallel execution",
    detail: "Isolated tasks · Resource scheduling",
  },
  { title: "Benchmark evaluation", detail: "Rewards · Verifier feedback" },
];

export const GearArchitectureScene = ({ frame }: { frame?: number }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={1440}
    height={760}
    viewBox="0 0 1440 760"
    role="img"
    aria-labelledby="architecture-title architecture-description"
    style={{
      fontFamily:
        "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
    }}
  >
    <title id="architecture-title">Gear architecture</title>
    <desc id="architecture-description">
      Algorithm Registry configures the Optimization Engine. Task Registry and
      Agent feed the engine, which sends candidates to Evaluator. Evaluator
      writes Trajectory Storage. Storage returns feedback to the engine and
      supplies Trainer. The engine updates seed tasks in Task Registry and the
      harness in Agent. Trainer returns model updates to Agent. The circular
      Serve, Diagnose, Evolve overview is synchronized with highlighted
      components and moving data on the corresponding paths. Hitch's four shared
      infrastructure capabilities stay static.
    </desc>
    {frame === undefined ? <style>{architectureAnimationCss()}</style> : null}
    <defs>
      {[
        ["arch-arrow", p.muted],
        ["arch-active-arrow", p.accent],
      ].map(([id, color]) => (
        <marker
          key={id}
          id={id}
          viewBox="0 0 8 8"
          refX={7}
          refY={4}
          markerWidth={7}
          markerHeight={7}
          orient="auto-start-reverse"
          markerUnits="userSpaceOnUse"
        >
          <path
            d="M1 1L7 4L1 7"
            fill="none"
            stroke={color}
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </marker>
      ))}
    </defs>
    <rect width={1440} height={760} fill={p.bg} />

    <g data-component="Algorithm Registry">
      <rect
        x={400}
        y={42}
        width={640}
        height={96}
        rx={10}
        fill={p.bg}
        stroke={p.border}
        strokeWidth={1.3}
      />
      <Text x={422} y={81} size={26} weight={600}>
        Algorithm Registry
      </Text>
      <Text x={1018} y={80} size={17} fill={p.muted} anchor="end">
        GEPA · Your algorithm
      </Text>
      <Text x={422} y={114} size={17} fill={p.muted}>
        Customize the modules below to improve agents
      </Text>
    </g>
    <OverviewLoop frame={frame} />

    <Component
      x={48}
      y={281}
      title="Task Registry"
      lines={["Seed tasks · Environments"]}
      frame={frame}
      cues={["inputs", "seedUpdates"]}
    />
    <Component
      x={48}
      y={510}
      title="Agent"
      lines={["Harness · Model"]}
      frame={frame}
      cues={["inputs", "harnessUpdates", "modelUpdates"]}
    />
    <Component
      x={544}
      y={281}
      title="Optimization Engine"
      lines={["Propose and compare candidates", "Select agent improvements"]}
      frame={frame}
      cues={["dispatch", "diagnose", "seedUpdates"]}
    />
    <Component
      x={1040}
      y={281}
      title="Evaluator"
      lines={["Execute tasks", "Collect trajectories and feedback"]}
      frame={frame}
      cues={["dispatch", "capture"]}
    />
    <Component
      x={1040}
      y={510}
      title="Trajectory Storage"
      lines={["Trajectories · Rewards · Feedback"]}
      frame={frame}
      cues={["capture", "feedback", "trainingData"]}
    />
    <Component
      x={544}
      y={510}
      title="Trainer"
      backend="Slime"
      lines={["Update model weights"]}
      frame={frame}
      cues={["trainingData", "modelUpdates"]}
    />

    <g data-relationship="Algorithm Registry to Optimization Engine">
      <Flow d="M720 142V275" />
    </g>
    <g data-relationship="Task Registry and Agent to Optimization Engine">
      <Flow
        d="M404 337H538"
        frame={frame}
        cue="inputs"
      />
      <Flow
        d="M382 506V476Q382 464 394 464H644Q656 464 656 452V399"
        frame={frame}
        cue="inputs"
      />
    </g>
    <g data-relationship="Optimization Engine updates seed tasks in Task Registry">
      <Flow
        d="M600 277V252Q600 240 588 240H236Q224 240 224 252V275"
        frame={frame}
        cue="seedUpdates"
      />
      <Text x={412} y={226} size={15} fill={p.muted} anchor="middle">
        seed task updates
      </Text>
    </g>
    <g data-relationship="Optimization Engine updates harness in Agent">
      <Flow
        d="M600 397V422Q600 434 588 434H236Q224 434 224 446V504"
        frame={frame}
        cue="harnessUpdates"
      />
      <Text x={412} y={420} size={15} fill={p.muted} anchor="middle">
        harness updates
      </Text>
    </g>
    <g data-relationship="Optimization Engine to Evaluator">
      <Flow d="M900 337H1034" frame={frame} cue="dispatch" />
      <Text x={967} y={323} size={16} fill={p.muted} anchor="middle">
        candidates
      </Text>
    </g>
    <g data-relationship="Evaluator to Trajectory Storage">
      <Flow d="M1216 397V504" frame={frame} cue="capture" />
    </g>
    <g data-relationship="Trajectory Storage feedback to Optimization Engine">
      <Flow
        d="M1058 506V476Q1058 464 1046 464H796Q784 464 784 452V399"
        frame={frame}
        cue="feedback"
      />
      <Text x={922} y={450} size={16} fill={p.muted} anchor="middle">
        feedback
      </Text>
    </g>
    <g data-relationship="Trajectory Storage to Trainer">
      <Flow d="M1036 566H902" frame={frame} cue="trainingData" />
      <Text x={968} y={552} size={16} fill={p.muted} anchor="middle">
        training data
      </Text>
    </g>
    <g data-relationship="Trainer model updates to Agent">
      <Flow
        d="M540 566H406"
        frame={frame}
        cue="modelUpdates"
      />
      <Text x={472} y={552} size={16} fill={p.muted} anchor="middle">
        model updates
      </Text>
    </g>

    <g data-layer="Powered by Hitch">
      <Text x={48} y={656} size={18} fill={p.muted} weight={500}>
        Powered by Hitch
      </Text>
      <path d="M48 674H1392" stroke={p.line} strokeWidth={1} />
      {infrastructure.map((item, i) => (
        <g key={item.title}>
          <Text x={48 + i * 344} y={709} size={21} weight={600}>
            {item.title}
          </Text>
          <Text x={48 + i * 344} y={737} size={16} fill={p.muted}>
            {item.detail}
          </Text>
        </g>
      ))}
    </g>
  </svg>
);
