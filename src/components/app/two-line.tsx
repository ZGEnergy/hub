import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";

/**
 * The one way a record shows two facts: what it is, over the quieter fact that identifies it.
 * Emphasis here is colour and size, never weight, and both lines truncate rather than wrap so
 * a table row keeps its height whatever the data is.
 */
export function TwoLine({
  primary,
  secondary,
  mono = false,
  wrap = false,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  /** The secondary line is an identifier — a key prefix, a slug, an id — not prose. */
  mono?: boolean;
  /**
   * Both lines wrap instead of truncating. For a record the reader must read in full before
   * deciding, such as a permission being granted; never inside a table row.
   */
  wrap?: boolean;
}) {
  const fit = wrap ? "break-words" : "truncate";
  return (
    <span className="grid min-w-0 gap-0.5">
      <span className={cn(fit, "text-sm")}>{primary}</span>
      {secondary === undefined ? null : (
        <span className={cn(fit, "text-xs text-muted-foreground", mono && "font-mono")}>
          {secondary}
        </span>
      )}
    </span>
  );
}
