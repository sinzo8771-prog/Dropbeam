import { renderQrSvg } from "../../core/handshake/qr-render";

/**
 * The QR tile — the hero of the product (PRD 10.2). Always black on white
 * with a 4-module quiet zone in both themes so it scans reliably.
 *
 * The content is a code or pairing link this app generated, so rendering it
 * as SVG (never peer-supplied markup) is safe; peer-supplied text elsewhere
 * in the UI is rendered as text only.
 */

export type QrTileProps = {
  content: string;
  /** Announced to assistive tech, e.g. "Offer code". */
  label: string;
  /** Pixel size per QR module. */
  pixelSize?: number;
};

export function QrTile({ content, label, pixelSize = 8 }: QrTileProps) {
  if (content.length === 0) return null;
  const svg = renderQrSvg(content, { pixelSize, border: 4 });
  return (
    <div class="qr-tile">
      <div
        class="qr-tile-frame"
        role="img"
        aria-label={label}
        // Self-generated SVG markup from our own encoder — never peer input.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}
