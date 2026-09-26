import type { Message } from "@shared/i18n/translate";

export class AssetUploadAdmissionError extends Error {
  /** Why the file was refused, as the interface says it. */
  readonly reason: Message;

  constructor(reason: Message) {
    super(reason.key);
    this.name = "AssetUploadAdmissionError";
    this.reason = reason;
  }
}
