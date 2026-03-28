/** Verify camera + mic tracks are live for Gemini Live (poll + visibility checks). */

export type MediaGateStatus = {
  videoOk: boolean;
  audioOk: boolean;
  /** Non-null when something is wrong — show to the user */
  warning: string | null;
};

export function ensureTracksEnabled(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => {
    t.enabled = true;
  });
}

function tracksHealthy(tracks: MediaStreamTrack[]): boolean {
  return tracks.length > 0 && tracks.every((t) => t.readyState === "live" && t.enabled);
}

export function auditMediaStream(stream: MediaStream | null): MediaGateStatus {
  if (!stream) {
    return { videoOk: false, audioOk: false, warning: "No camera or microphone stream yet." };
  }

  const videoTracks = stream.getVideoTracks();
  const audioTracks = stream.getAudioTracks();

  if (videoTracks.length === 0) {
    return {
      videoOk: false,
      audioOk: tracksHealthy(audioTracks),
      warning: "Camera is off or unavailable. Allow camera access for this site.",
    };
  }

  if (audioTracks.length === 0) {
    return {
      videoOk: tracksHealthy(videoTracks),
      audioOk: false,
      warning: "Microphone is off or unavailable. Allow microphone access for this site.",
    };
  }

  const videoOk = tracksHealthy(videoTracks);
  const audioOk = tracksHealthy(audioTracks);

  if (videoOk && audioOk) {
    return { videoOk: true, audioOk: true, warning: null };
  }

  const parts: string[] = [];
  if (!videoOk) parts.push("camera");
  if (!audioOk) parts.push("microphone");
  return {
    videoOk,
    audioOk,
    warning: `Re-enable your ${parts.join(" and ")} (browser or system settings).`,
  };
}
