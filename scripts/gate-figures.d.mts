/**
 * Types for scripts/gate-figures.mjs, so the unit that tests it can import the
 * real module under `tsc --noEmit` (the project compiles no JS, and an untyped
 * import would be an implicit `any`). The implementation is the source of
 * truth: nothing here affects what runs, and the unit suite exercises it.
 */

export interface GateFigures {
  /** Vitest's total across tests/unit + tests/integration. */
  unitTests: number;
  /** Playwright's total. */
  e2eTests: number;
  /** The two above, added - the figure the README leads with. */
  totalTests: number;
  /** Initial JS, decimal KB, as a string: it is rendered, not calculated. */
  initialKb: string;
  /** The gzip budget, decimal KB, as a string. */
  budgetKb: string;
  /**
   * The same initial JS before compression, decimal KB. It is the figure the
   * stricter budget is held to, so it is published beside the download size:
   * quoting only the compressed one would read as three times the headroom
   * there is.
   */
  rawKb: string;
}

export type FigureMode = "check" | "write";

export interface FigureModeInput {
  args?: string[];
  ci?: boolean;
  /**
   * The process environment. `E2E_BROWSERS` is read from it: a run that names
   * WebKit collects a smaller suite than the README describes and is refused.
   */
  env?: Record<string, string | undefined>;
}

/**
 * Which relationship this run has to the README's figures. Throws on a typo or on
 * a contradictory pair of flags rather than falling back to a default, and on a
 * WebKit run, which has no relationship to those figures to describe.
 */
export function figureMode(input?: FigureModeInput): FigureMode;

/** The figures described by a whole gate run's output. Throws when a figure cannot be read. */
export function parseFigures(output: string): GateFigures;

/** One line describing the figures, for a log. */
export function formatFigures(figures: GateFigures): string;

/** `readme` with every figure brought in line. Throws rather than guessing. */
export function applyFigures(readme: string, figures: GateFigures): string;
