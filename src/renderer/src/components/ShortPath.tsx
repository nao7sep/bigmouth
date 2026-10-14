import { splitPath } from "../util/shortenedText";

/**
 * A path as identifying text: one line that loses its middle and keeps its
 * final segment (interface-styling conventions, Labels). The head shrinks
 * first, behind its own ellipsis; the tail gives way only once the head is
 * gone. The whole path stays in the DOM, so assistive technology reads it all,
 * and in `title`, which shows it whole on hover.
 */
export function ShortPath({ path, className }: { path: string; className?: string }) {
  const { head, tail } = splitPath(path);
  return (
    <span className={`short-path${className ? ` ${className}` : ""}`} title={path}>
      {head && <span className="short-path-head">{head}</span>}
      <span className="short-path-tail">{tail}</span>
    </span>
  );
}
