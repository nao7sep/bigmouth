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

/** The attachment was not installed; stalled work may still own its temporary stage. */
export class AssetUploadFailureError extends Error {
  /** Why, and what to do about it, as the interface says it. */
  readonly reason: Message;

  constructor(reason: Message, readonly stopBatch = false) {
    super(reason.key);
    this.name = "AssetUploadFailureError";
    this.reason = reason;
  }
}
