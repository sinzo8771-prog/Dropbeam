/**
 * The beam — the single signature animation (PRD 10.2): a line of light between
 * two device glyphs. Motion is allowed only for connect success, so this is
 * the one decorative flourish in the app, and it respects
 * `prefers-reduced-motion` (tokens collapse transitions to 0 ms).
 */

export type BeamProps = {
  /** "idle" draws the resting line, "active" pulses toward the peer. */
  active?: boolean;
  reduceMotion?: boolean;
};

export function Beam({ active = false, reduceMotion = false }: BeamProps) {
  return (
    <div class={`beam${active ? " is-active" : ""}`} aria-hidden="true" data-testid="beam">
      <svg viewBox="0 0 120 24" class="beam-line" focusable="false">
        <line
          x1="4"
          y1="12"
          x2="116"
          y2="12"
          stroke="var(--accent)"
          stroke-width="2"
          stroke-linecap="round"
          stroke-dasharray={active && !reduceMotion ? "8 10" : undefined}
        />
      </svg>
    </div>
  );
}
