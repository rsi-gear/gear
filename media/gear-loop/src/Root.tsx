import "./index.css";
import {
  AbsoluteFill,
  Composition,
  Interactive,
  useCurrentFrame,
} from "remotion";
import { GearLoop } from "./Composition";
import { GearArchitectureScene } from "./GearArchitecture";

const GearArchitecture: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#fcfdfd",
        scale: 0.993,
        translate: "5px 0px",
      }}
    >
      <Interactive.Div
        name="Gear algorithm architecture"
        style={{ width: 1440, height: 760 }}
      >
        <GearArchitectureScene frame={frame} />
      </Interactive.Div>
    </AbsoluteFill>
  );
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="GearLoop"
        component={GearLoop}
        durationInFrames={360}
        fps={30}
        width={1440}
        height={580}
      />
      <Composition
        id="GearArchitecture"
        component={GearArchitecture}
        durationInFrames={360}
        fps={30}
        width={1440}
        height={760}
      />
    </>
  );
};
