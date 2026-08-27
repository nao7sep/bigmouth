export class AssetUploadAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetUploadAdmissionError";
  }
}
