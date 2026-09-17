import type { CSSProperties, ReactNode } from "react";
import { interpolate } from "remotion";
import {
  cues,
  DURATION,
  FADE_OUT,
  svgAnimationCss,
  type Cue,
} from "./timeline";

const color = {
  bg: "#fcfdfd",
  ink: "#263d44",
  muted: "#73898f",
  faint: "#b5c7ca",
  line: "#e0e9ea",
  teal: "#197f83",
  tealSoft: "#eaf5f4",
  seed: "#ab7b35",
  seedSoft: "#faf4e8",
  model: "#7c6b9f",
  modelSoft: "#f2eef8",
  outer: "#5a718a",
  innerFill: "#f3f9f8",
};
type AnimationProps = { frame?: number; cue: Cue };

function Motion({
  frame,
  cue,
  children,
}: AnimationProps & { children: ReactNode }) {
  const [start, duration] = cues[cue];
  return (
    <g
      className={frame === undefined ? `gear-motion gear-${cue}` : undefined}
      data-cue={cue}
      style={
        frame === undefined
          ? undefined
          : {
              opacity: interpolate(
                frame,
                [start, start + duration, FADE_OUT, DURATION],
                [0, 1, 1, 0],
                {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                },
              ),
            }
      }
    >
      {children}
    </g>
  );
}

function Draw({
  frame,
  cue,
  d,
  stroke = color.teal,
  width = 2.2,
}: AnimationProps & {
  d: string;
  stroke?: string;
  width?: number;
}) {
  const [start, duration] = cues[cue];
  return (
    <path
      d={d}
      fill="none"
      stroke={stroke}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      pathLength={100}
      strokeDasharray="100 100"
      className={
        frame === undefined ? `gear-motion gear-draw-${cue}` : undefined
      }
      data-cue={cue}
      style={
        frame === undefined
          ? undefined
          : {
              opacity: interpolate(
                frame,
                [start, start + duration, FADE_OUT, DURATION],
                [0, 1, 1, 0],
                {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                },
              ),
              strokeDashoffset: interpolate(
                frame,
                [start, start + duration],
                [100, 0],
                {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                },
              ),
            }
      }
    />
  );
}

function Label({
  x,
  y,
  children,
  size = 20,
  fill = color.ink,
  weight = 400,
  anchor = "start",
  style,
}: {
  x: number;
  y: number;
  children: ReactNode;
  size?: number;
  fill?: string;
  weight?: number;
  anchor?: "start" | "middle" | "end";
  style?: CSSProperties;
}) {
  return (
    <text
      x={x}
      y={y}
      fontSize={size}
      fill={fill}
      fontWeight={weight}
      textAnchor={anchor}
      style={style}
    >
      {children}
    </text>
  );
}

function Arrow({
  x,
  y,
  fill = color.teal,
  direction = "right",
}: {
  x: number;
  y: number;
  fill?: string;
  direction?: "right" | "left" | "up";
}) {
  const d =
    direction === "up"
      ? `M${x - 4.5} ${y + 7} L${x} ${y} L${x + 4.5} ${y + 7}`
      : direction === "left"
        ? `M${x + 7} ${y - 4.5} L${x} ${y} L${x + 7} ${y + 4.5}`
        : `M${x - 7} ${y - 4.5} L${x} ${y} L${x - 7} ${y + 4.5}`;
  return (
    <path
      d={d}
      stroke={fill}
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  );
}

// Short moving strokes make the fast interaction loop visible while the outer
// loop is still collecting evidence and proposing changes.
function InnerFlow({ frame, d }: { frame?: number; d: string }) {
  const [start, duration] = cues.innerFlow;
  return (
    <path
      d={d}
      fill="none"
      stroke={color.teal}
      strokeWidth={4}
      strokeLinecap="round"
      pathLength={100}
      strokeDasharray="4 96"
      className={frame === undefined ? "gear-motion gear-flow" : undefined}
      data-cue="innerFlow"
      style={
        frame === undefined
          ? undefined
          : {
              opacity: interpolate(
                frame,
                [start, start + duration, FADE_OUT, DURATION],
                [0, 1, 1, 0],
                {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                },
              ),
              strokeDashoffset: interpolate(
                frame,
                [start, DURATION],
                [0, -500],
                {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                },
              ),
            }
      }
    />
  );
}

const actionPath = "M338 350C376 310 454 310 487 337";
const observationPath = "M485 398C451 460 377 465 338 416";

export const GearScene = ({ frame }: { frame?: number }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="1440"
    height="580"
    viewBox="0 100 1440 580"
    fill="none"
    role="img"
    aria-labelledby="gear-title gear-desc"
    style={{
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
    }}
  >
    <title id="gear-title">Gear — inner and outer evolution loops</title>
    <desc id="gear-desc">
      A twelve-second animation of Gear's evolution architecture. Inner loop: a
      Rollout Agent, composed of a harness and model, serves each task by
      exchanging actions, observations and rewards with an environment. Outer
      loop: the Meta Agent diagnoses cross-task trajectories and feedback, then
      edits the harness, designs seed tasks and drives model training. The
      evolved harness, tasks and model feed directly back into the inner loop
      for the next iteration.
    </desc>
    {frame === undefined && <style>{svgAnimationCss()}</style>}
    <rect y="100" width="1440" height="580" fill={color.bg} />

    {/* Stacked task environments contain the fast, repeated interaction loop. */}
    <Motion frame={frame} cue="serve">
      <rect
        x="114"
        y="214"
        width="536"
        height="282"
        rx="23"
        fill="#f0f3f9"
        stroke="#d6dfeb"
        strokeWidth="1.2"
      />
      <rect
        x="102"
        y="226"
        width="536"
        height="282"
        rx="23"
        fill="#faf6ed"
        stroke="#e8dfcc"
        strokeWidth="1.2"
      />
      <rect
        x="90"
        y="238"
        width="536"
        height="282"
        rx="23"
        fill={color.innerFill}
        stroke="#b8d7d3"
        strokeWidth="1.5"
      />
      <Label x={116} y={277} size={23} fill={color.teal} weight={600}>
        Inner loop
      </Label>
      <Label x={254} y={277} size={17} fill={color.muted}>
        Interact within each task
      </Label>
      <Label x={356} y={202} size={27} weight={600} anchor="middle">
        Serve
      </Label>
      <Label x={595} y={276} size={14} fill={color.muted} anchor="end">
        Task i
      </Label>
      <path d="M116 294H598" stroke="#dce9e6" />
      <rect
        x="112"
        y="333"
        width="215"
        height="116"
        rx="12"
        stroke="#b5c7ca"
        strokeWidth="1.4"
        fill="white"
      />
      <Label x={219.5} y={365} anchor="middle" size={21} weight={600}>
        Rollout Agent
      </Label>
      <rect
        x="130"
        y="387"
        width="83"
        height="39"
        rx="6"
        fill={color.tealSoft}
      />
      <Label
        x={171.5}
        y={412}
        anchor="middle"
        size={16}
        fill={color.teal}
        weight={500}
      >
        Harness
      </Label>
      <rect
        x="225"
        y="387"
        width="83"
        height="39"
        rx="6"
        fill={color.modelSoft}
      />
      <Label
        x={266.5}
        y={412}
        anchor="middle"
        size={16}
        fill={color.model}
        weight={500}
      >
        Model
      </Label>
      <circle
        cx="523"
        cy="367"
        r="34"
        fill="white"
        stroke={color.teal}
        strokeWidth="1.5"
      />
      <ellipse
        cx="523"
        cy="367"
        rx="15"
        ry="34"
        stroke={color.teal}
        strokeWidth="1.3"
      />
      <path
        d="M490 367H556M496 349H550M496 385H550"
        stroke={color.teal}
        strokeWidth="1.3"
      />
      <Label x={523} y={432} anchor="middle" size={19} weight={500}>
        Environment
      </Label>
    </Motion>
    <Draw
      frame={frame}
      cue="innerAction"
      d={actionPath}
      stroke="#8ebdb8"
      width={1.7}
    />
    <Motion frame={frame} cue="innerAction">
      <path
        d="M478 337L488 339 486 329"
        stroke={color.teal}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Label x={412} y={313} size={14} fill={color.teal} anchor="middle">
        actions
      </Label>
    </Motion>
    <Draw
      frame={frame}
      cue="innerReturn"
      d={observationPath}
      stroke="#8ebdb8"
      width={1.7}
    />
    <Motion frame={frame} cue="innerReturn">
      <path
        d="M337 426L337 415 348 418"
        stroke={color.teal}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Label x={447} y={476} size={13} fill={color.teal} anchor="middle">
        observations + rewards
      </Label>
    </Motion>
    <InnerFlow frame={frame} d={actionPath} />
    <InnerFlow frame={frame} d={observationPath} />

    {/* Cross-task trajectories leave the task stack for the slower outer loop. */}
    <Motion frame={frame} cue="trajectory">
      <Label x={116} y={138} size={23} fill={color.outer} weight={600}>
        Outer loop
      </Label>
      <Label x={254} y={138} size={17} fill={color.muted}>
        Improve across tasks
      </Label>
      <Label x={678} y={337} size={13} anchor="middle" fill={color.muted}>
        trajectories
      </Label>
      <Label x={678} y={354} size={13} anchor="middle" fill={color.muted}>
        + feedback
      </Label>
      <Arrow x={710} y={367} fill={color.outer} />
    </Motion>
    <Draw
      frame={frame}
      cue="trajectory"
      d="M639 367H710"
      stroke={color.outer}
    />
    <Motion frame={frame} cue="diagnose">
      <Label x={756} y={202} size={27} weight={600} anchor="middle">
        Diagnose
      </Label>
      <Label x={756} y={318} size={21} weight={600} anchor="middle">
        Meta Agent
      </Label>
      <circle
        cx="756"
        cy="367"
        r="32"
        stroke={color.outer}
        strokeWidth="1.7"
        fill="white"
      />
      <g
        stroke={color.outer}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M744 379L756 356 769 375M744 379L769 375" />
        <circle cx="744" cy="379" r="4" fill="white" />
        <circle cx="756" cy="356" r="4" fill="white" />
        <circle cx="769" cy="375" r="4" fill="white" />
      </g>
      <Label x={756} y={421} size={16} fill={color.muted} anchor="middle">
        Analyze &amp; plan
      </Label>
    </Motion>
    <Draw frame={frame} cue="plan" d="M801 367H908" stroke={color.ink} />
    <Motion frame={frame} cue="evolve">
      <Label x={1154} y={202} size={27} weight={600} anchor="middle">
        Evolve
      </Label>
    </Motion>
    <Draw
      frame={frame}
      cue="harnessPath"
      d="M908 367Q930 367 930 345V270Q930 248 952 248H1031"
    />
    <Motion frame={frame} cue="harness">
      <circle cx="1042" cy="248" r="5.5" fill={color.teal} />
      <Label x={1063} y={255} size={25} weight={600} fill={color.teal}>
        Harness
      </Label>
      <Label x={1063} y={282} size={15} fill={color.muted}>
        Prompts · Tools · Hooks
      </Label>
      <Label x={1063} y={302} size={15} fill={color.muted}>
        Skills
      </Label>
      <Label x={1063} y={322} size={15} fill={color.muted}>
        Context management
      </Label>
    </Motion>
    <Draw frame={frame} cue="seedPath" d="M908 367H1031" stroke={color.seed} />
    <Motion frame={frame} cue="seeds">
      <circle cx="1042" cy="367" r="5.5" fill={color.seed} />
      <Label x={1063} y={374} size={25} weight={600} fill={color.seed}>
        Seed Tasks
      </Label>
      <Label x={1063} y={401} size={16} fill={color.muted}>
        Design targeted tasks
      </Label>
    </Motion>
    <Draw
      frame={frame}
      cue="modelPath"
      d="M908 367Q930 367 930 389V425Q930 447 952 447H1031"
      stroke={color.model}
    />
    <Motion frame={frame} cue="model">
      <circle cx="1042" cy="447" r="5.5" fill={color.model} />
      <Label x={1063} y={454} size={25} weight={600} fill={color.model}>
        Model
      </Label>
      <Label x={1063} y={481} size={16} fill={color.muted}>
        Train the model
      </Label>
    </Motion>

    {/* The large return route surrounds the inner loop and updates its next trial. */}
    <Draw
      frame={frame}
      cue="merge"
      d="M1270 248H1299Q1320 248 1320 269V447"
      stroke={color.faint}
    />
    <Draw frame={frame} cue="merge" d="M1270 367H1320" stroke={color.faint} />
    <Draw frame={frame} cue="merge" d="M1270 447H1320" stroke={color.faint} />
    <Draw
      frame={frame}
      cue="return"
      d="M1320 447V531Q1320 553 1298 553H68Q44 553 44 529V196Q44 172 70 172H114Q138 172 138 196V242"
      stroke={color.outer}
      width={2.5}
    />
    <Motion frame={frame} cue="return">
      <path
        d="M133 235L138 242 143 235"
        stroke={color.outer}
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Motion>
    <Motion frame={frame} cue="refreshed">
      <rect
        x="110"
        y="331"
        width="219"
        height="120"
        rx="14"
        stroke={color.teal}
        strokeWidth="1.8"
      />
      <circle cx="318" cy="335" r="10" fill={color.teal} />
      <path
        d="M314 335l3 3 6-6"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </Motion>

    <path d="M64 613H1376" stroke={color.line} />
    <Label x={64} y={650} size={15} fill={color.muted}>
      Serve → Diagnose → Evolve → Repeat
    </Label>
    <Motion frame={frame} cue="versions">
      <Label x={972} y={650} size={14} fill={color.muted} anchor="end">
        Evaluated versions
      </Label>
      <circle cx="1022" cy="644" r="17" stroke={color.faint} />
      <Label x={1022} y={649} size={13} fill={color.muted} anchor="middle">
        v1
      </Label>
      <path d="M1048 644H1077" stroke={color.faint} strokeWidth="1.5" />
      <Arrow x={1077} y={644} fill={color.faint} />
      <circle cx="1105" cy="644" r="17" stroke={color.outer} fill="#edf2f7" />
      <Label
        x={1105}
        y={649}
        size={13}
        fill={color.outer}
        anchor="middle"
        weight={600}
      >
        v2
      </Label>
      <path
        d="M1131 644H1160"
        stroke={color.outer}
        strokeWidth="1.5"
        strokeDasharray="4 5"
      />
      <Arrow x={1160} y={644} fill={color.outer} />
      <Label x={1184} y={649} size={14} fill={color.outer}>
        v3…
      </Label>
      <Label x={1376} y={650} size={13} fill={color.muted} anchor="end">
        keep learning
      </Label>
    </Motion>
  </svg>
);
