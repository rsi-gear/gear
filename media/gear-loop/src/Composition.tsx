import { AbsoluteFill, useCurrentFrame } from "remotion";
import { GearScene } from "./GearScene";

export const GearLoop = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: "#fcfdfd" }}>
      <GearScene frame={frame} />
    </AbsoluteFill>
  );
};
