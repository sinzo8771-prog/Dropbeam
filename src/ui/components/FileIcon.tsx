/**
 * The file-type icon (PRD 10.1 screen 6: a transfer row carries an icon).
 *
 * Flat, stroked in `currentColor`, no fills and no emoji - the same rules the
 * rest of the app's artwork follows (PRD 10.2), so a row's icon never
 * introduces a second visual language.
 *
 * The icon is decorative: the file's name sits right next to it, and the row
 * already names the file for a screen reader, so the glyph is hidden from
 * assistive technology rather than read out as a second label.
 */

export type FileKind = "image" | "video" | "audio" | "document" | "archive" | "code" | "file";

/**
 * The kind of file, from its media type.
 *
 * The extension is a fallback for the types browsers do not name - a `.zip`
 * arrives as `application/zip` on some platforms and as nothing at all on
 * others - and a file with neither is a plain file.
 */
export function fileKind(type: string, name = ""): FileKind {
  const mime = type.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/")) return "document";
  if (mime === "application/pdf" || mime === "application/rtf" || mime === "application/msword") {
    return "document";
  }
  if (
    mime === "application/zip" ||
    mime === "application/gzip" ||
    mime === "application/x-tar" ||
    mime === "application/x-7z-compressed"
  ) {
    return "archive";
  }
  if (
    mime === "application/json" ||
    mime === "application/javascript" ||
    mime === "application/typescript" ||
    mime === "text/x-python" ||
    mime === "application/x-sh"
  ) {
    return "code";
  }
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "heic"].includes(ext)) return "image";
  if (["mp4", "mov", "mkv", "webm", "avi"].includes(ext)) return "video";
  if (["mp3", "m4a", "wav", "flac", "ogg", "aac"].includes(ext)) return "audio";
  if (["pdf", "doc", "docx", "txt", "md", "rtf", "odt"].includes(ext)) return "document";
  if (["zip", "tar", "gz", "7z", "rar", "bz2"].includes(ext)) return "archive";
  if (["js", "ts", "json", "py", "sh", "rs", "go", "rb", "html", "css"].includes(ext)) return "code";
  return "file";
}

const PATHS: Record<FileKind, string> = {
  // A picture: a frame with a hill and a sun.
  image:
    "M3.5 5.5h17v13h-17zM3.5 15l4.5-4.5 3.5 3.5 3-3 4.5 4.5M7 9.5a1 1 0 100-2 1 1 0 000-2-1",
  // A play triangle in a frame.
  video: "M3.5 5.5h17v13h-17zM10.5 9.5l5 2.5-5 2.5z",
  // A note.
  audio: "M9 18V6l10-2v12M9 18a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0M19 16a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0",
  // A page with lines.
  document: "M6 3.5h8l4 4v13H6zM14 3.5v4h4M9 12h6M9 15.5h6",
  // A box.
  archive: "M3.5 6.5h17v4h-17zM5 10.5v9h14v-9M10 14h4",
  // Angle brackets.
  code: "M8.5 8L4 12l4.5 4M15.5 8l4.5 4-4.5 4",
  // A plain page.
  file: "M6 3.5h8l4 4v13H6zM14 3.5v4h4",
};

export type FileIconProps = {
  kind: FileKind;
  /** The icon's size in pixels; the row's other type is smaller. */
  size?: number;
};

export function FileIcon({ kind, size = 18 }: FileIconProps) {
  return (
    <svg
      class="file-icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      role="presentation"
      aria-hidden="true"
      focusable="false"
      data-testid="file-icon"
      data-kind={kind}
    >
      <path d={PATHS[kind]} />
    </svg>
  );
}
