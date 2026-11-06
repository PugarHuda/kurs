import React from "react";
import { Composition } from "remotion";
import { KursDemo, FPS, totalSeconds } from "./KursDemo";

export const Root: React.FC = () => (
  <Composition id="KursDemo" component={KursDemo} fps={FPS} width={1600} height={900} durationInFrames={Math.ceil(totalSeconds * FPS)} />
);
