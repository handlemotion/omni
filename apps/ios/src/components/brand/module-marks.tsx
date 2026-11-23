import { useId, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, Defs, G, LinearGradient, Path, Rect, Stop } from "react-native-svg";

export interface ModuleMarkProps {
  size?: number;
}

function Mark({ size = 22, children }: { size?: number; children: ReactNode }) {
  return (
    <View style={styles.drop}>
      <Svg width={size} height={size} viewBox="0 0 20 20" fill="none" accessible={false}>
        {children}
      </Svg>
    </View>
  );
}

function Fade({ id, from, to }: { id: string; from: string; to: string }) {
  return (
    <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <Stop offset="0" stopColor={from} />
      <Stop offset="1" stopColor={to} />
    </LinearGradient>
  );
}

const useIds = () => useId().replaceAll(":", "");

/** A blue envelope with its white flap down (ported from the web/desktop rail). */
export function IconMailMark({ size }: ModuleMarkProps) {
  const id = useIds();
  return (
    <Mark size={size}>
      <Defs>
        <Fade id={`${id}b`} from="#5eabff" to="#1765dc" />
        <Fade id={`${id}f`} from="#ffffff" to="#dcebff" />
      </Defs>
      <Rect x={1.5} y={3.75} width={17} height={12.5} rx={2.5} fill={`url(#${id}b)`} />
      <Path
        d="M2.7 15.4 8.4 10.9M17.3 15.4 11.6 10.9"
        stroke="#fff"
        strokeOpacity={0.28}
        strokeWidth={0.7}
        strokeLinecap="round"
      />
      <Path d="M2.5 5.8 9 11.1q1 .8 2 0l6.5-5.3Z" fill="#0a4cb3" fillOpacity={0.35} />
      <Path
        d="M2.4 4.5 9 10q1 .8 2 0l6.6-5.5Z"
        fill={`url(#${id}f)`}
        stroke={`url(#${id}f)`}
        strokeWidth={0.6}
        strokeLinejoin="round"
      />
      <Rect
        x={1.75}
        y={4}
        width={16.5}
        height={12}
        rx={2.25}
        stroke="#0a4cb3"
        strokeOpacity={0.45}
        strokeWidth={0.5}
      />
    </Mark>
  );
}

/** A green folder with a sheet of paper showing above its front (ported from the web/desktop rail). */
export function IconDriveMark({ size }: ModuleMarkProps) {
  const id = useIds();
  return (
    <Mark size={size}>
      <Defs>
        <Fade id={`${id}k`} from="#1fa45c" to="#0d7a3e" />
        <Fade id={`${id}f`} from="#5fdc95" to="#1c9f56" />
      </Defs>
      <G>
        <Path
          d="M1.5 5.6a2 2 0 0 1 2-2h3.7a1.6 1.6 0 0 1 1.2.5l1 1.1h7.1a2 2 0 0 1 2 2v7.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"
          fill={`url(#${id}k)`}
        />
        <Rect x={3.3} y={6.3} width={13.4} height={6} rx={0.8} fill="#fff" fillOpacity={0.95} />
        <Path
          d="M1.5 9.2a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v5.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"
          fill={`url(#${id}f)`}
        />
      </G>
      <Path
        d="M3.5 7.55h13"
        stroke="#fff"
        strokeOpacity={0.6}
        strokeWidth={0.6}
        strokeLinecap="round"
      />
      <Path
        d="M1.75 9.2a1.75 1.75 0 0 1 1.75-1.75h13a1.75 1.75 0 0 1 1.75 1.75v5.3a1.75 1.75 0 0 1-1.75 1.75h-13a1.75 1.75 0 0 1-1.75-1.75Z"
        stroke="#08602f"
        strokeOpacity={0.4}
        strokeWidth={0.5}
      />
    </Mark>
  );
}

/** A violet contacts book: a darker spine, a white bust on its cover (ported from the web/desktop rail). */
export function IconCrmMark({ size }: ModuleMarkProps) {
  const id = useIds();
  return (
    <Mark size={size}>
      <Defs>
        <Fade id={`${id}b`} from="#a687ff" to="#6a3fd0" />
        <Fade id={`${id}p`} from="#ffffff" to="#ece4ff" />
      </Defs>
      <Rect x={3} y={1.75} width={14.5} height={16.5} rx={2.5} fill={`url(#${id}b)`} />
      <Path
        d="M6 1.75v16.5h-.5A2.5 2.5 0 0 1 3 15.75v-11.5a2.5 2.5 0 0 1 2.5-2.5Z"
        fill="#3d1d96"
        fillOpacity={0.22}
      />
      <Path d="M6.25 2.3v15.4" stroke="#fff" strokeOpacity={0.3} strokeWidth={0.5} />
      <Circle cx={11.75} cy={8} r={2.45} fill={`url(#${id}p)`} />
      <Path d="M7.9 14.6a3.85 3.1 0 0 1 7.7 0q0 .6-.6.6H8.5q-.6 0-.6-.6Z" fill={`url(#${id}p)`} />
      <Rect
        x={3.25}
        y={2}
        width={14}
        height={16}
        rx={2.25}
        stroke="#3d1d96"
        strokeOpacity={0.45}
        strokeWidth={0.5}
      />
    </Mark>
  );
}

/** A white desk calendar under a burnt-orange header, two rings on top, a few days marked. */
export function IconCalendarMark({ size }: ModuleMarkProps) {
  const id = useIds();
  return (
    <Mark size={size}>
      <Defs>
        <Fade id={`${id}h`} from="#ff7a6e" to="#e5352f" />
        <Fade id={`${id}p`} from="#ffffff" to="#f4eceb" />
      </Defs>
      <G>
        <Rect x={2} y={3} width={16} height={14.5} rx={2.5} fill={`url(#${id}p)`} />
        <Path d="M2 5.5A2.5 2.5 0 0 1 4.5 3h11A2.5 2.5 0 0 1 18 5.5V7H2Z" fill={`url(#${id}h)`} />
      </G>
      <Path d="M2.3 6.95h15.4" stroke="#fff" strokeOpacity={0.35} strokeWidth={0.5} />
      <Rect x={6} y={1.6} width={1.5} height={3.2} rx={0.75} fill="#8c1d18" />
      <Rect x={12.5} y={1.6} width={1.5} height={3.2} rx={0.75} fill="#8c1d18" />
      <G fill="#b42318" fillOpacity={0.55}>
        <Circle cx={6} cy={10.2} r={0.85} />
        <Circle cx={10} cy={10.2} r={0.85} />
        <Circle cx={14} cy={10.2} r={0.85} />
        <Circle cx={6} cy={13.8} r={0.85} />
        <Circle cx={10} cy={13.8} r={0.85} />
      </G>
      <Circle cx={14} cy={13.8} r={1.25} fill={`url(#${id}h)`} />
      <Rect
        x={2.25}
        y={3.25}
        width={15.5}
        height={14}
        rx={2.25}
        stroke="#8c1d18"
        strokeOpacity={0.4}
        strokeWidth={0.5}
      />
    </Mark>
  );
}

const styles = StyleSheet.create({
  drop: {
    shadowColor: "#000000",
    shadowOpacity: 0.16,
    shadowRadius: 1,
    shadowOffset: { width: 0, height: 0.75 },
  },
});
