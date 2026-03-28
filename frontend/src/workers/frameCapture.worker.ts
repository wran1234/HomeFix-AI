/**
 * Web Worker: encodes ImageData to base64 JPEG off the main thread.
 * Keeps the UI smooth while frames are being sent to the backend.
 */

self.onmessage = (e: MessageEvent<{ imageData: ImageData; width: number; height: number }>) => {
  const { imageData, width, height } = e.data;

  // Use OffscreenCanvas to encode JPEG at quality 0.6
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(imageData, 0, 0);

  canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 }).then((blob) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // Strip "data:image/jpeg;base64," prefix
      const b64 = dataUrl.split(",")[1];
      self.postMessage(b64);
    };
    reader.readAsDataURL(blob);
  });
};
