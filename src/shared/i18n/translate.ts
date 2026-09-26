import { CATALOGUES, type Catalogue, type MessageKey } from "./catalogues.js";
import type { Language } from "./languages.js";

// A value is plain text, a number formatted for the locale, or another
// message, which renders in the same language (a reason inside a sentence).
export type MessageValue = string | number | Message;

export type MessageValues = { [name: string]: MessageValue };

// Text held in state (results, dialogs, load failures) is a key plus values,
// never a finished string, so it renders in whatever language is current when
// it is shown.
export type Message = {
  key: MessageKey;
  values?: MessageValues;
};

export function message(key: MessageKey, values?: MessageValues): Message {
  return values === undefined ? { key } : { key, values };
}

export function isMessage(value: unknown): value is Message {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { key?: unknown }).key === "string" &&
    (value as { key: string }).key in CATALOGUES.en
  );
}

const PLACEHOLDER = /\{(\w+)\}/g;

// One piece of an entry split at its placeholders, for callers that fill a
// placeholder with something other than text (markup in the renderer).
export type Segment = { text: string } | { placeholder: string };

export type Translator = {
  language: Language;
  locale: string;
  t: (key: MessageKey, values?: MessageValues) => string;
  segments: (key: MessageKey) => Segment[];
  text: (message: Message) => string;
  number: (value: number) => string;
  percent: (ratio: number) => string;
  // An instant, as a date and time in the given IANA zone (the computer's zone
  // when none is given).
  dateTime: (date: Date, timeZone?: string | null) => string;
  // Names run together the way the language lists them ("a, b, c").
  list: (items: readonly string[]) => string;
};

export function createTranslator(language: Language, locale: string = language): Translator {
  const catalogue: Catalogue = CATALOGUES[language];
  const numberFormat = new Intl.NumberFormat(locale);
  const percentFormat = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
  const listFormat = new Intl.ListFormat(locale, { type: "conjunction", style: "narrow" });
  const pluralRules = new Intl.PluralRules(language);

  function template(key: MessageKey, values: MessageValues | undefined): string {
    const entry = catalogue[key];
    if (typeof entry === "string") {
      return entry;
    }
    // A key the catalogue does not carry shows as itself rather than taking the
    // window down; the catalogue gate and the on-screen-key check both fail on
    // it, so it cannot reach a release unnoticed.
    if (entry === undefined || entry === null) {
      return key;
    }
    // A plural entry holds one form per CLDR category the language uses; the
    // catalogue gate guarantees the category the rules select is present.
    const count = typeof values?.count === "number" ? values.count : 0;
    const forms = entry as Record<string, string>;
    return forms[pluralRules.select(count)] ?? forms.other ?? key;
  }

  function format(value: MessageValue): string {
    if (typeof value === "number") return numberFormat.format(value);
    if (typeof value === "string") return value;
    return t(value.key, value.values);
  }

  function t(key: MessageKey, values?: MessageValues): string {
    return template(key, values).replace(PLACEHOLDER, (whole, name: string) =>
      values !== undefined && name in values ? format(values[name]!) : whole,
    );
  }

  function segments(key: MessageKey): Segment[] {
    // split with a capture group alternates literal text and placeholder names.
    return template(key, undefined)
      .split(PLACEHOLDER)
      .map((part, index) => (index % 2 === 0 ? { text: part } : { placeholder: part }));
  }

  return {
    language,
    locale,
    t,
    segments,
    text: (message) => t(message.key, message.values),
    number: (value) => numberFormat.format(value),
    percent: (ratio) => percentFormat.format(ratio),
    dateTime: (date, timeZone) => {
      const zone = timeZone ?? "";
      let format = dateTimeFormats.get(zone);
      if (format === undefined) {
        format = new Intl.DateTimeFormat(locale, {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: timeZone ?? undefined,
        });
        dateTimeFormats.set(zone, format);
      }
      return format.format(date);
    },
    list: (items) => listFormat.format(items),
  };
}
