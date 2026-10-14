import type { Message } from "@shared/i18n/translate";
import { useI18n, type Translator } from "../i18n/I18nContext";
import { nameFew } from "../util/shortenedText";

/**
 * One item a message is about: `name` identifies it in the summary (already
 * shortened, such as a path's final segment), and `line`, when given, is its
 * whole entry in the full list (the full path, or the name with its reason).
 */
export type NamedItem = { name: string; line?: Message };

/**
 * A result about several items. Its sentence is followed by a summary naming a
 * few of them, or, with `namesIn`, carries that summary in the named
 * placeholder of its own sentence.
 */
export type ListedMessage = { message: Message; items?: readonly NamedItem[]; namesIn?: string };

/**
 * A few names run together in the current language, then a count of the rest.
 * Followed by a count, the names take only the language's list separator: the
 * count sentence brings its own "and", and German "a, b und c und 2 weitere"
 * would otherwise say it twice. The separator is read from the same formatter
 * that lists the names when every one is named.
 */
export function fewNamesText(translator: Pick<Translator, "t" | "list">, names: readonly string[]): string {
  const { named, more } = nameFew(names);
  if (more === 0) return translator.list(named);
  const sample = translator.list(["\u0001", "\u0002", "\u0003"]);
  const separator = sample.slice(sample.indexOf("\u0001") + 1, sample.indexOf("\u0002"));
  return translator.t("result.namesAndMore", { names: named.join(separator), count: more });
}

/**
 * A message about several items, as a compact surface shows it (interface-
 * styling conventions, Labels): the sentence, a few names and a count of the
 * rest. When the items carry their own lines — a reason or message to be read
 * — a disclosure follows whose height-limited, scrolling list holds every line
 * whole; it is a native <details>, so keyboard and touch open it. Items that
 * are only names get no disclosure: the summary already tells them apart.
 */
export function ListedMessageView({ listed }: { listed: ListedMessage }) {
  const translator = useI18n();
  const { text, t } = translator;
  const items = listed.items ?? [];
  if (items.length === 0) return <>{text(listed.message)}</>;
  const names = items.map((item) => item.name);
  const summary = fewNamesText(translator, names);
  const sentence = listed.namesIn
    ? text({ ...listed.message, values: { ...listed.message.values, [listed.namesIn]: summary } })
    : text(listed.message);
  const lines = items.flatMap((item) => (item.line ? [item.line] : []));
  return (
    <>
      <div>{sentence}</div>
      {!listed.namesIn && <div className="named-items-summary">{summary}</div>}
      {lines.length > 0 && (
        <details className="named-items">
          <summary className="named-items-toggle">{t("result.fullList")}</summary>
          <ul className="named-items-list" data-passive-scroll-region="">
            {lines.map((line, index) => (
              <li key={index}>{text(line)}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
